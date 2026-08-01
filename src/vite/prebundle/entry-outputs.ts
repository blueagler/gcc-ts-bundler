import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { firstOrUndefined } from "../../shared/arrays";
import { syncDirectoryEntries } from "../../shared/files";
import { applyTextEdits } from "../../shared/text-edits";
import { toRelativeImportSpecifier } from "../capture";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import type { WrittenRegionBundleRequest } from "./regions";
import { isPureLazyRegionKey } from "./regions";
import {
  DEP_BUNDLE_INPUT_DIR,
  DEP_BUNDLE_OUTPUT_DIR,
  hashText,
  normalizePath,
} from "./shared";

/**
 * Rewrite authored modules so dependency imports point at their region
 * bundles, then stage the rewritten sources into the runtime source dir.
 */
export async function rewriteAuthoredModules(input: {
  collapsedEntryOutputByPath: Map<string, CollapsibleBundleEntryOutput>;
  dynamicRootRequestKeyByTargetFilePath: Map<string, string>;
  materialized: MaterializedGraph;
  outputByRequestKey: Map<string, string>;
  regionLabelsByAuthoredFile: Map<string, string>;
  requestGroupKeyByTarget: Map<string, string>;
  runtimeSrcDir: string;
}): Promise<Array<{ content: string; relativePath: string }>> {
  const authoredEntries = await Promise.all(
    input.materialized.authoredFiles.map(async (filePath) => {
      const normalizedFilePath = normalizePath(filePath);
      const regionKey =
        input.regionLabelsByAuthoredFile.get(normalizedFilePath);
      const sourceText = await fs.readFile(normalizedFilePath, "utf8");
      const sourceFile = ts.createSourceFile(
        normalizedFilePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const outputFilePath = normalizePath(
        path.join(
          input.runtimeSrcDir,
          path.relative(input.materialized.srcDir, normalizedFilePath),
        ),
      );
      const edits: Array<{ end: number; start: number; text: string }> = [];
      const resolveBundledOutput = (requestKey: string) =>
        input.outputByRequestKey.get(
          input.requestGroupKeyByTarget.get(requestKey) ?? requestKey,
        );

      if (regionKey) {
        for (const statement of sourceFile.statements) {
          if (
            !(
              (ts.isImportDeclaration(statement) ||
                ts.isExportDeclaration(statement)) &&
              statement.moduleSpecifier &&
              ts.isStringLiteralLike(statement.moduleSpecifier) &&
              statement.moduleSpecifier.text.startsWith(".")
            )
          ) {
            continue;
          }
          const targetFilePath = normalizePath(
            path.resolve(
              path.dirname(normalizedFilePath),
              statement.moduleSpecifier.text,
            ),
          );
          const bundledOutput = resolveBundledOutput(
            `${regionKey}\u0000${targetFilePath}`,
          );
          if (!bundledOutput) {
            continue;
          }
          const collapsedOutput =
            input.collapsedEntryOutputByPath.get(bundledOutput);
          if (!collapsedOutput) {
            edits.push({
              end: statement.moduleSpecifier.getEnd() - 1,
              start: statement.moduleSpecifier.getStart() + 1,
              text: toRelativeImportSpecifier(outputFilePath, bundledOutput),
            });
            continue;
          }

          edits.push({
            end: statement.getEnd(),
            start: statement.getStart(sourceFile),
            text: renderCollapsedBundleImportStatement({
              importerFilePath: outputFilePath,
              sourceFile,
              statement,
              wrapperOutput: collapsedOutput,
            }),
          });
        }
      }

      const visit = (node: ts.Node) => {
        const firstArgument = ts.isCallExpression(node)
          ? node.arguments[0]
          : undefined;
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          firstArgument &&
          ts.isStringLiteralLike(firstArgument) &&
          firstArgument.text.startsWith(".")
        ) {
          const targetFilePath = normalizePath(
            path.resolve(path.dirname(normalizedFilePath), firstArgument.text),
          );
          const requestKey =
            input.dynamicRootRequestKeyByTargetFilePath.get(targetFilePath);
          const bundledOutput = requestKey
            ? resolveBundledOutput(requestKey)
            : undefined;
          if (bundledOutput) {
            edits.push({
              end: firstArgument.getEnd() - 1,
              start: firstArgument.getStart() + 1,
              text: toRelativeImportSpecifier(outputFilePath, bundledOutput),
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      return {
        content: dedupeAuthoredImportStatements(
          outputFilePath,
          applyTextEdits(sourceText, edits),
        ),
        relativePath: path
          .relative(input.runtimeSrcDir, outputFilePath)
          .replace(/\\/g, "/"),
      };
    }),
  );
  await syncDirectoryEntries(input.runtimeSrcDir, authoredEntries, {
    preserve(relativePath) {
      return (
        relativePath.startsWith(`${DEP_BUNDLE_INPUT_DIR}/`) ||
        relativePath.startsWith(`${DEP_BUNDLE_OUTPUT_DIR}/`)
      );
    },
  });
  return authoredEntries;
}

export interface CollapsibleBundleEntryOutput {
  directTargetFilePath: string;
  sideEffectImportFilePaths: string[];
}

export async function canonicalizeDuplicateLazyEntryOutputs(input: {
  entryOutputByRequestKey: Map<string, string>;
  outputDir: string;
  outputSrcDir: string;
  writtenRequests: WrittenRegionBundleRequest[];
}) {
  const requestByKey = new Map(
    input.writtenRequests.map((request) => [request.requestKey, request]),
  );
  const requestKeysByContentHash = new Map<string, string[]>();

  for (const [requestKey, outputFilePath] of input.entryOutputByRequestKey) {
    const request = requestByKey.get(requestKey);
    if (!request || !isPureLazyRegionKey(request.requests[0]?.regionKey)) {
      continue;
    }
    const sourceText = await fs.readFile(outputFilePath, "utf8");
    const contentHash = hashText(sourceText);
    const bucket = requestKeysByContentHash.get(contentHash);
    if (bucket) {
      bucket.push(requestKey);
    } else {
      requestKeysByContentHash.set(contentHash, [requestKey]);
    }
  }

  const outputByRequestKey = new Map(input.entryOutputByRequestKey);
  const omittedOutputFilePaths = new Set<string>();
  const canonicalModules: CapturedRuntimeModule[] = [];
  const sharedEntries: Array<{ content: string; relativePath: string }> = [];

  for (const [contentHash, requestKeys] of requestKeysByContentHash) {
    if (requestKeys.length < 2) {
      continue;
    }

    const firstRequestKey = firstOrUndefined(requestKeys);
    if (firstRequestKey === undefined) {
      continue;
    }
    const firstOutputFilePath = outputByRequestKey.get(firstRequestKey);
    if (!firstOutputFilePath) {
      continue;
    }
    const sourceText = await fs.readFile(firstOutputFilePath, "utf8");

    const canonicalFilePath = normalizePath(
      path.join(
        input.outputDir,
        "shared",
        `${path.basename(firstOutputFilePath, ".js")}-${contentHash.slice(
          0,
          8,
        )}.js`,
      ),
    );
    sharedEntries.push({
      content: sourceText,
      relativePath: path
        .relative(path.join(input.outputDir, "shared"), canonicalFilePath)
        .replace(/\\/g, "/"),
    });

    const sourceModuleIds = new Set<string>();
    for (const requestKey of requestKeys) {
      const request = requestByKey.get(requestKey);
      if (!request) {
        continue;
      }
      for (const sourceModuleId of request.sourceModuleIds) {
        sourceModuleIds.add(sourceModuleId);
      }
      const outputFilePath = outputByRequestKey.get(requestKey);
      if (outputFilePath && outputFilePath !== canonicalFilePath) {
        omittedOutputFilePaths.add(outputFilePath);
      }
      outputByRequestKey.set(requestKey, canonicalFilePath);
    }

    canonicalModules.push({
      filePath: canonicalFilePath,
      id: canonicalFilePath,
      relativePath: path
        .relative(input.outputSrcDir, canonicalFilePath)
        .replace(/\\/g, "/"),
      sourceModuleIds: [...sourceModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
  }

  await syncDirectoryEntries(
    path.join(input.outputDir, "shared"),
    sharedEntries,
  );

  return {
    canonicalModules,
    omittedOutputFilePaths,
    outputByRequestKey,
  };
}

export async function collectCollapsibleBundleEntryOutputs(
  outputFilePaths: string[],
) {
  const collapsibleByPath = new Map<string, CollapsibleBundleEntryOutput>();
  for (const outputFilePath of outputFilePaths) {
    const collapsible =
      await analyzeCollapsibleBundleEntryOutput(outputFilePath);
    if (!collapsible) {
      continue;
    }
    collapsibleByPath.set(outputFilePath, collapsible);
  }
  return collapsibleByPath;
}

async function analyzeCollapsibleBundleEntryOutput(outputFilePath: string) {
  const sourceText = await fs.readFile(outputFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    outputFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const sideEffectImportFilePaths = new Set<string>();
  const importedBindingNames = new Set<string>();
  let directTargetFilePath: string | null = null;

  const resolveTarget = (specifier: string) =>
    normalizePath(path.resolve(path.dirname(outputFilePath), specifier));

  const setDirectTarget = (nextTargetFilePath: string) => {
    if (
      directTargetFilePath !== null &&
      directTargetFilePath !== nextTargetFilePath
    ) {
      return false;
    }
    directTargetFilePath = nextTargetFilePath;
    return true;
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const targetFilePath = resolveTarget(statement.moduleSpecifier.text);
      if (!statement.importClause) {
        sideEffectImportFilePaths.add(targetFilePath);
        continue;
      }
      if (!setDirectTarget(targetFilePath)) {
        return null;
      }
      if (statement.importClause.name) {
        importedBindingNames.add(statement.importClause.name.text);
      }
      if (statement.importClause.namedBindings) {
        if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
          importedBindingNames.add(
            statement.importClause.namedBindings.name.text,
          );
        } else {
          for (const element of statement.importClause.namedBindings.elements) {
            importedBindingNames.add(element.name.text);
          }
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      if (
        statement.exportClause &&
        ts.isNamespaceExport(statement.exportClause)
      ) {
        return null;
      }
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (element) =>
            element.propertyName &&
            element.propertyName.text !== element.name.text,
        )
      ) {
        return null;
      }
      if (!setDirectTarget(resolveTarget(statement.moduleSpecifier.text))) {
        return null;
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause) ||
        directTargetFilePath === null
      ) {
        return null;
      }
      for (const element of statement.exportClause.elements) {
        if (
          element.propertyName &&
          element.propertyName.text !== element.name.text
        ) {
          return null;
        }
        const localName = (element.propertyName ?? element.name).text;
        if (!importedBindingNames.has(localName)) {
          return null;
        }
      }
      continue;
    }

    return null;
  }

  if (directTargetFilePath === null) {
    return null;
  }

  sideEffectImportFilePaths.delete(directTargetFilePath);
  return {
    directTargetFilePath,
    sideEffectImportFilePaths: [...sideEffectImportFilePaths].sort(
      (left, right) => left.localeCompare(right),
    ),
  } satisfies CollapsibleBundleEntryOutput;
}

function renderCollapsedBundleImportStatement(input: {
  importerFilePath: string;
  sourceFile: ts.SourceFile;
  statement: ts.ImportDeclaration | ts.ExportDeclaration;
  wrapperOutput: CollapsibleBundleEntryOutput;
}) {
  const moduleSpecifier = input.statement.moduleSpecifier;
  if (!moduleSpecifier) {
    return input.sourceFile.text.slice(
      input.statement.getStart(input.sourceFile),
      input.statement.getEnd(),
    );
  }
  const statementStart = input.statement.getStart(input.sourceFile);
  const statementText = input.sourceFile.text.slice(
    statementStart,
    input.statement.getEnd(),
  );
  const directSpecifierText = toRelativeImportSpecifier(
    input.importerFilePath,
    input.wrapperOutput.directTargetFilePath,
  );
  const specifierStart =
    moduleSpecifier.getStart(input.sourceFile) - statementStart + 1;
  const specifierEnd = moduleSpecifier.getEnd() - statementStart - 1;
  const rewrittenStatementText =
    statementText.slice(0, specifierStart) +
    directSpecifierText +
    statementText.slice(specifierEnd);
  const sideEffectImports = input.wrapperOutput.sideEffectImportFilePaths.map(
    (filePath) =>
      `import ${JSON.stringify(
        toRelativeImportSpecifier(input.importerFilePath, filePath),
      )};`,
  );
  return [...sideEffectImports, rewrittenStatementText].join("\n");
}

function dedupeAuthoredImportStatements(filePath: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const seenBoundImports = new Set<string>();
  const seenSideEffectImports = new Set<string>();
  const moduleSpecifiersWithBoundImports = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }
    moduleSpecifiersWithBoundImports.add(statement.moduleSpecifier.text);
  }

  const deletions: Array<{ start: number; end: number }> = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const statementText = sourceFile.text.slice(
      statement.getStart(sourceFile),
      statement.getEnd(),
    );
    if (!statement.importClause) {
      if (
        moduleSpecifiersWithBoundImports.has(moduleSpecifier) ||
        seenSideEffectImports.has(moduleSpecifier)
      ) {
        deletions.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
        });
        continue;
      }
      seenSideEffectImports.add(moduleSpecifier);
      continue;
    }
    const boundImportKey = `${moduleSpecifier}\u0000${statementText}`;
    if (seenBoundImports.has(boundImportKey)) {
      deletions.push({
        end: statement.getEnd(),
        start: statement.getStart(sourceFile),
      });
      continue;
    }
    seenBoundImports.add(boundImportKey);
  }

  let rewritten = sourceText;
  for (const deletion of deletions.sort(
    (left, right) => right.start - left.start,
  )) {
    rewritten =
      rewritten.slice(0, deletion.start) + rewritten.slice(deletion.end);
  }
  return rewritten;
}
