import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { toRelativeImportSpecifier } from "./capture";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "./internal-types";

const DEP_BUNDLE_INPUT_DIR = "__dep-bundle-inputs";
const DEP_BUNDLE_OUTPUT_DIR = "__dep-bundles";
const EAGER_REGION_LABEL = "@eager";

type EsbuildBuild = typeof import("esbuild").build;

interface ParsedDependencyImport {
  hasDefault: boolean;
  hasNamespace: boolean;
  isSideEffectOnly: boolean;
  namedExports: string[];
  node: ts.ImportDeclaration | ts.ExportDeclaration;
  targetFilePath: string;
}

interface ParsedMaterializedModule {
  dependencyImports: ParsedDependencyImport[];
  exportedNames: string[];
  hasDefaultExport: boolean;
  staticAuthoredImports: string[];
}

interface RegionBundleRequest {
  exportedNames: string[];
  hasDefaultExport: boolean;
  needsDefault: boolean;
  needsExportAll: boolean;
  needsSideEffectOnly: boolean;
  regionKey: string;
  sourceModuleIds: string[];
  targetFilePath: string;
  targetModule: CapturedRuntimeModule;
  usedNamedExports: Set<string>;
}

interface GroupedRegionBundleRequest {
  requestKey: string;
  requests: RegionBundleRequest[];
  sourceModuleIds: string[];
}

interface WrittenRegionBundleRequest extends GroupedRegionBundleRequest {
  entryPoint: string;
}

interface CollapsibleBundleEntryOutput {
  directTargetFilePath: string;
  sideEffectImportFilePaths: string[];
}

let cachedEsbuildBuild: Promise<EsbuildBuild> | null = null;

export async function prebundleMaterializedDependencies(input: {
  dynamicRootModuleIds: string[];
  materialized: MaterializedGraph;
}) {
  const authoredFiles = new Set(
    input.materialized.authoredFiles.map((filePath) => normalizePath(filePath)),
  );
  const moduleByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      module,
    ]),
  );
  const moduleBySourceId = new Map<string, CapturedRuntimeModule>();
  for (const module of input.materialized.modules) {
    for (const sourceModuleId of module.sourceModuleIds) {
      moduleBySourceId.set(sourceModuleId, module);
    }
  }

  const parseCache = new Map<string, ParsedMaterializedModule>();
  const parseModule = async (filePath: string) => {
    const normalizedFilePath = normalizePath(filePath);
    const cached = parseCache.get(normalizedFilePath);
    if (cached) {
      return cached;
    }

    const sourceText = await fs.readFile(normalizedFilePath, "utf8");
    const sourceFile = ts.createSourceFile(
      normalizedFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const staticAuthoredImports = new Set<string>();
    const dependencyImports: ParsedDependencyImport[] = [];
    const exportedNames = new Set<string>();
    let hasDefaultExport = false;

    const resolveRelativeTarget = (specifier: string) => {
      if (!specifier.startsWith(".")) {
        return null;
      }
      return normalizePath(
        path.resolve(path.dirname(normalizedFilePath), specifier),
      );
    };

    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        hasDefaultExport = true;
        exportedNames.add("default");
        continue;
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        ) &&
        statement.modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        hasDefaultExport = true;
        exportedNames.add("default");
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isVariableStatement(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exportedNames.add(declaration.name.text);
            }
          }
        } else if (statement.name) {
          exportedNames.add(statement.name.text);
        }
      }

      if (
        ts.isImportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const targetFilePath = resolveRelativeTarget(
          statement.moduleSpecifier.text,
        );
        if (!targetFilePath) {
          continue;
        }
        if (authoredFiles.has(targetFilePath)) {
          staticAuthoredImports.add(targetFilePath);
          continue;
        }

        if (!moduleByFilePath.has(targetFilePath)) {
          continue;
        }

        const importClause = statement.importClause;
        const isSideEffectOnly = !importClause;
        let hasDefault = false;
        let hasNamespace = false;
        const namedExports = new Set<string>();

        if (importClause) {
          if (importClause.name) {
            hasDefault = true;
          }
          if (importClause.namedBindings) {
            if (ts.isNamespaceImport(importClause.namedBindings)) {
              hasNamespace = true;
            } else {
              for (const element of importClause.namedBindings.elements) {
                namedExports.add((element.propertyName ?? element.name).text);
              }
            }
          }
        }

        dependencyImports.push({
          hasDefault,
          hasNamespace,
          isSideEffectOnly,
          namedExports: [...namedExports].sort((left, right) =>
            left.localeCompare(right),
          ),
          node: statement,
          targetFilePath,
        });
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const targetFilePath = resolveRelativeTarget(
          statement.moduleSpecifier.text,
        );
        if (!targetFilePath) {
          continue;
        }
        if (authoredFiles.has(targetFilePath)) {
          staticAuthoredImports.add(targetFilePath);
          continue;
        }
        if (!moduleByFilePath.has(targetFilePath)) {
          continue;
        }
        if (
          statement.exportClause &&
          ts.isNamespaceExport(statement.exportClause)
        ) {
          continue;
        }

        if (!statement.exportClause) {
          dependencyImports.push({
            hasDefault: false,
            hasNamespace: true,
            isSideEffectOnly: false,
            namedExports: [],
            node: statement,
            targetFilePath,
          });
          continue;
        }

        if (ts.isNamedExports(statement.exportClause)) {
          const namedExports = new Set<string>();
          for (const element of statement.exportClause.elements) {
            const exportedName = (element.propertyName ?? element.name).text;
            namedExports.add(exportedName);
            exportedNames.add(element.name.text);
          }
          if (namedExports.has("default")) {
            namedExports.delete("default");
            hasDefaultExport = true;
            exportedNames.add("default");
          }
          dependencyImports.push({
            hasDefault: false,
            hasNamespace: false,
            isSideEffectOnly: false,
            namedExports: [...namedExports].sort((left, right) =>
              left.localeCompare(right),
            ),
            node: statement,
            targetFilePath,
          });
        }
      }
    }

    const parsed = {
      dependencyImports,
      exportedNames: [...exportedNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      hasDefaultExport,
      staticAuthoredImports: [...staticAuthoredImports].sort((left, right) =>
        left.localeCompare(right),
      ),
    } satisfies ParsedMaterializedModule;
    parseCache.set(normalizedFilePath, parsed);
    return parsed;
  };

  const entryFilePaths = input.materialized.entries.map((entry) =>
    normalizePath(path.resolve(input.materialized.srcDir, entry)),
  );
  const dynamicRootFilePaths = input.dynamicRootModuleIds
    .map((moduleId) => moduleBySourceId.get(moduleId)?.filePath)
    .filter(
      (filePath): filePath is string =>
        typeof filePath === "string" &&
        authoredFiles.has(normalizePath(filePath)),
    )
    .map((filePath) => normalizePath(filePath))
    .sort((left, right) => left.localeCompare(right));

  const regionLabelsByAuthoredFile = await assignRegionLabels({
    authoredFiles,
    dynamicRootFilePaths,
    entryFilePaths,
    parseModule,
  });

  const bundleRequests = new Map<string, RegionBundleRequest>();
  for (const filePath of input.materialized.authoredFiles) {
    const normalizedFilePath = normalizePath(filePath);
    const regionKey = regionLabelsByAuthoredFile.get(normalizedFilePath);
    if (!regionKey) {
      continue;
    }

    const parsed = await parseModule(normalizedFilePath);
    for (const dependencyImport of parsed.dependencyImports) {
      const targetModule = moduleByFilePath.get(
        normalizePath(dependencyImport.targetFilePath),
      );
      if (!targetModule) {
        continue;
      }

      const requestKey = `${regionKey}\u0000${normalizePath(targetModule.filePath)}`;
      const existing = bundleRequests.get(requestKey);
      if (existing) {
        existing.needsDefault ||= dependencyImport.hasDefault;
        existing.needsExportAll ||= dependencyImport.hasNamespace;
        existing.needsSideEffectOnly ||= dependencyImport.isSideEffectOnly;
        for (const namedExport of dependencyImport.namedExports) {
          existing.usedNamedExports.add(namedExport);
        }
        continue;
      }

      const parsedTarget = await parseModule(targetModule.filePath);
      bundleRequests.set(requestKey, {
        exportedNames: parsedTarget.exportedNames,
        hasDefaultExport: parsedTarget.hasDefaultExport,
        needsDefault: dependencyImport.hasDefault,
        needsExportAll: dependencyImport.hasNamespace,
        needsSideEffectOnly: dependencyImport.isSideEffectOnly,
        regionKey,
        sourceModuleIds: [...targetModule.sourceModuleIds],
        targetFilePath: normalizePath(targetModule.filePath),
        targetModule,
        usedNamedExports: new Set(dependencyImport.namedExports),
      });
    }
  }

  if (bundleRequests.size === 0) {
    return input.materialized;
  }

  const { groupedRequests, requestGroupKeyByTarget } = groupBundleRequests([
    ...bundleRequests.values(),
  ]);

  const inputDir = path.join(input.materialized.srcDir, DEP_BUNDLE_INPUT_DIR);
  const outputDir = path.join(input.materialized.srcDir, DEP_BUNDLE_OUTPUT_DIR);
  await fs.rm(inputDir, { force: true, recursive: true });
  await fs.rm(outputDir, { force: true, recursive: true });
  await fs.mkdir(inputDir, { recursive: true });

  const writtenRequests: WrittenRegionBundleRequest[] = [];
  for (const groupedRequest of groupedRequests) {
    const regionDir = path.join(
      inputDir,
      sanitizeRegionKey(
        groupedRequest.requests[0]?.regionKey ?? EAGER_REGION_LABEL,
      ),
    );
    await fs.mkdir(regionDir, { recursive: true });
    const fileName = `${sanitizeEntryName(groupedRequest)}-${hashText(
      groupedRequest.requestKey,
    ).slice(0, 8)}.js`;
    const entryPoint = path.join(regionDir, fileName);
    const renderedEntry = renderBundleEntrySource({
      entryPoint,
      requests: groupedRequest.requests,
    });
    await fs.writeFile(entryPoint, renderedEntry, "utf8");
    writtenRequests.push({
      entryPoint,
      ...groupedRequest,
    });
  }

  const esbuildBuild = await loadEsbuildBuild();
  const entryPoints = writtenRequests.map((request) =>
    path
      .relative(input.materialized.srcDir, request.entryPoint)
      .replace(/\\/g, "/"),
  );
  const bundleResult = await esbuildBuild({
    absWorkingDir: input.materialized.srcDir,
    bundle: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[dir]/[name]",
    entryPoints,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: DEP_BUNDLE_OUTPUT_DIR,
    outbase: DEP_BUNDLE_INPUT_DIR,
    platform: "browser",
    splitting: true,
    target: "esnext",
    treeShaking: true,
    write: true,
  });

  const entryOutputByRequestKey = resolveEntryOutputsByRequest({
    metafile: bundleResult.metafile,
    srcDir: input.materialized.srcDir,
    writtenRequests,
  });
  if (entryOutputByRequestKey.size === 0) {
    return input.materialized;
  }

  const collapsedEntryOutputByPath = await collectCollapsibleBundleEntryOutputs(
    [...new Set(entryOutputByRequestKey.values())],
  );

  await Promise.all(
    input.materialized.authoredFiles.map(async (filePath) => {
      const normalizedFilePath = normalizePath(filePath);
      const regionKey = regionLabelsByAuthoredFile.get(normalizedFilePath);
      if (!regionKey) {
        return;
      }
      const sourceText = await fs.readFile(normalizedFilePath, "utf8");
      const sourceFile = ts.createSourceFile(
        normalizedFilePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const edits: Array<{ end: number; start: number; text: string }> = [];

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
        const targetRequestKey = `${regionKey}\u0000${targetFilePath}`;
        const bundledOutput = entryOutputByRequestKey.get(
          requestGroupKeyByTarget.get(targetRequestKey) ?? targetRequestKey,
        );
        if (!bundledOutput) {
          continue;
        }
        const collapsedOutput = collapsedEntryOutputByPath.get(bundledOutput);
        if (!collapsedOutput) {
          edits.push({
            end: statement.moduleSpecifier.getEnd() - 1,
            start: statement.moduleSpecifier.getStart() + 1,
            text: toRelativeImportSpecifier(normalizedFilePath, bundledOutput),
          });
          continue;
        }

        edits.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
          text: renderCollapsedBundleImportStatement({
            importerFilePath: normalizedFilePath,
            sourceFile,
            statement,
            wrapperOutput: collapsedOutput,
          }),
        });
      }

      if (edits.length === 0) {
        return;
      }

      let rewritten = sourceText;
      for (const edit of edits.sort(
        (left, right) => right.start - left.start,
      )) {
        rewritten =
          rewritten.slice(0, edit.start) +
          edit.text +
          rewritten.slice(edit.end);
      }
      await fs.writeFile(
        normalizedFilePath,
        dedupeAuthoredImportStatements(normalizedFilePath, rewritten),
        "utf8",
      );
    }),
  );

  const originalSourceIdsByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      [...module.sourceModuleIds],
    ]),
  );
  const bundleInputSourceIdsByEntry = new Map(
    writtenRequests.map((request) => [
      request.entryPoint,
      request.sourceModuleIds,
    ]),
  );
  const bundledModules = collectBundledModules({
    metafile: bundleResult.metafile,
    omittedFilePaths: new Set(collapsedEntryOutputByPath.keys()),
    outputDir,
    originalSourceIdsByFilePath,
    srcDir: input.materialized.srcDir,
    syntheticSourceIdsByFilePath: bundleInputSourceIdsByEntry,
  });

  return {
    ...input.materialized,
    modules: [
      ...input.materialized.modules.filter((module) =>
        authoredFiles.has(normalizePath(module.filePath)),
      ),
      ...bundledModules,
    ].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    runtimeEntries: [
      ...new Set(
        [
          ...input.materialized.entries,
          ...input.materialized.authoredFiles.map(
            (filePath) =>
              `./${path
                .relative(input.materialized.srcDir, filePath)
                .replace(/\\/g, "/")}`,
          ),
          ...bundledModules.map((module) => `./${module.relativePath}`),
        ].sort((left, right) => left.localeCompare(right)),
      ),
    ],
  } satisfies MaterializedGraph;
}

async function assignRegionLabels(input: {
  authoredFiles: Set<string>;
  dynamicRootFilePaths: string[];
  entryFilePaths: string[];
  parseModule: (filePath: string) => Promise<ParsedMaterializedModule>;
}) {
  const labelsByFile = new Map<string, Set<string>>();
  const traverse = async (roots: string[], label: string) => {
    const queue = [...roots];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const filePath = queue.pop();
      if (!filePath) {
        continue;
      }
      const normalizedFilePath = normalizePath(filePath);
      if (
        seen.has(normalizedFilePath) ||
        !input.authoredFiles.has(normalizedFilePath)
      ) {
        continue;
      }
      seen.add(normalizedFilePath);
      const labels = labelsByFile.get(normalizedFilePath) ?? new Set<string>();
      labels.add(label);
      labelsByFile.set(normalizedFilePath, labels);
      const parsed = await input.parseModule(normalizedFilePath);
      queue.push(...parsed.staticAuthoredImports);
    }
  };

  await traverse(input.entryFilePaths, EAGER_REGION_LABEL);
  for (const dynamicRootFilePath of input.dynamicRootFilePaths) {
    await traverse(
      [dynamicRootFilePath],
      `dynamic:${normalizePath(dynamicRootFilePath)}`,
    );
  }

  return new Map(
    [...labelsByFile.entries()].map(([filePath, labels]) => [
      filePath,
      [...labels].sort((left, right) => left.localeCompare(right)).join("|"),
    ]),
  );
}

function renderBundleEntrySource(input: {
  entryPoint: string;
  requests: RegionBundleRequest[];
}) {
  const lines: string[] = [];

  for (const request of input.requests) {
    const importPath = toRelativeImportSpecifier(
      input.entryPoint,
      request.targetFilePath,
    );
    if (
      request.needsSideEffectOnly &&
      !request.needsDefault &&
      !request.needsExportAll &&
      request.usedNamedExports.size === 0
    ) {
      lines.push(`import ${JSON.stringify(importPath)};`);
    }

    if (request.needsExportAll) {
      lines.push(`export * from ${JSON.stringify(importPath)};`);
    }

    const exportSpecifiers = new Set<string>();
    if (
      request.hasDefaultExport &&
      (request.needsDefault || request.needsExportAll)
    ) {
      exportSpecifiers.add("default");
    }
    for (const namedExport of request.usedNamedExports) {
      exportSpecifiers.add(namedExport);
    }

    if (exportSpecifiers.size > 0) {
      lines.push(
        `export { ${[...exportSpecifiers]
          .sort((left, right) => left.localeCompare(right))
          .join(", ")} } from ${JSON.stringify(importPath)};`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function groupBundleRequests(requests: RegionBundleRequest[]) {
  const groupedRequests: GroupedRegionBundleRequest[] = [];
  const requestGroupKeyByTarget = new Map<string, string>();

  const requestsByRegionAndPackage = new Map<string, RegionBundleRequest[]>();
  for (const request of requests) {
    const packageKey =
      request.sourceModuleIds[0] !== undefined
        ? classifyPackageName(request.sourceModuleIds[0])
        : "bundle";
    const bucketKey = `${request.regionKey}\u0000${packageKey}`;
    const bucket = requestsByRegionAndPackage.get(bucketKey);
    if (bucket) {
      bucket.push(request);
    } else {
      requestsByRegionAndPackage.set(bucketKey, [request]);
    }
  }

  for (const [bucketKey, bucketRequests] of [
    ...requestsByRegionAndPackage.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    if (
      bucketRequests.length === 1 ||
      !canCombineBundleRequests(bucketRequests)
    ) {
      for (const request of bucketRequests.sort((left, right) =>
        left.targetFilePath.localeCompare(right.targetFilePath),
      )) {
        const requestKey = `${request.regionKey}\u0000${request.targetFilePath}`;
        groupedRequests.push({
          requestKey,
          requests: [request],
          sourceModuleIds: [...request.sourceModuleIds],
        });
        requestGroupKeyByTarget.set(requestKey, requestKey);
      }
      continue;
    }

    const groupedRequestKey = `${bucketKey}\u0000bundle`;
    const groupedRequest = {
      requestKey: groupedRequestKey,
      requests: bucketRequests.sort((left, right) =>
        left.targetFilePath.localeCompare(right.targetFilePath),
      ),
      sourceModuleIds: [
        ...new Set(
          bucketRequests.flatMap((request) => request.sourceModuleIds),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    } satisfies GroupedRegionBundleRequest;
    groupedRequests.push(groupedRequest);
    for (const request of bucketRequests) {
      requestGroupKeyByTarget.set(
        `${request.regionKey}\u0000${request.targetFilePath}`,
        groupedRequestKey,
      );
    }
  }

  return { groupedRequests, requestGroupKeyByTarget };
}

function canCombineBundleRequests(requests: RegionBundleRequest[]) {
  const exportedNames = new Set<string>();
  let exportedDefaultCount = 0;

  for (const request of requests) {
    const willExportDefault =
      request.hasDefaultExport &&
      (request.needsDefault || request.needsExportAll);
    if (willExportDefault) {
      exportedDefaultCount += 1;
      if (exportedDefaultCount > 1) {
        return false;
      }
    }

    const namesToExport = request.needsExportAll
      ? request.exportedNames
      : [...request.usedNamedExports];
    for (const exportedName of namesToExport) {
      if (exportedName === "default") {
        continue;
      }
      if (exportedNames.has(exportedName)) {
        return false;
      }
      exportedNames.add(exportedName);
    }
  }

  return true;
}

function resolveEntryOutputsByRequest(input: {
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  srcDir: string;
  writtenRequests: WrittenRegionBundleRequest[];
}) {
  const requestKeyByEntryPoint = new Map(
    input.writtenRequests.map((request) => [
      normalizePath(request.entryPoint),
      request.requestKey,
    ]),
  );
  const outputByRequestKey = new Map<string, string>();
  for (const [outputPath, metadata] of Object.entries(input.metafile.outputs)) {
    if (!metadata.entryPoint) {
      continue;
    }
    const requestKey = requestKeyByEntryPoint.get(
      normalizePath(path.resolve(input.srcDir, metadata.entryPoint)),
    );
    if (!requestKey) {
      continue;
    }
    outputByRequestKey.set(
      requestKey,
      normalizePath(path.resolve(input.srcDir, outputPath)),
    );
  }
  return outputByRequestKey;
}

async function collectCollapsibleBundleEntryOutputs(outputFilePaths: string[]) {
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

function collectBundledModules(input: {
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  omittedFilePaths: Set<string>;
  originalSourceIdsByFilePath: Map<string, string[]>;
  outputDir: string;
  srcDir: string;
  syntheticSourceIdsByFilePath: Map<string, string[]>;
}) {
  const modules: CapturedRuntimeModule[] = [];

  for (const [outputPath, metadata] of Object.entries(input.metafile.outputs)) {
    if (!outputPath.endsWith(".js")) {
      continue;
    }

    const sourceModuleIds = new Set<string>();
    for (const inputPath of Object.keys(metadata.inputs)) {
      const absoluteInputPath = normalizePath(
        path.resolve(input.srcDir, inputPath),
      );
      const sourceIds =
        input.syntheticSourceIdsByFilePath.get(absoluteInputPath) ??
        input.originalSourceIdsByFilePath.get(absoluteInputPath);
      if (!sourceIds) {
        continue;
      }
      for (const sourceId of sourceIds) {
        sourceModuleIds.add(sourceId);
      }
    }

    const filePath = normalizePath(path.resolve(input.srcDir, outputPath));
    if (input.omittedFilePaths.has(filePath)) {
      continue;
    }
    modules.push({
      filePath,
      id: filePath,
      relativePath: path.relative(input.srcDir, filePath).replace(/\\/g, "/"),
      sourceModuleIds: [...sourceModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
  }

  return modules.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function sanitizeEntryName(request: GroupedRegionBundleRequest) {
  if (request.requests.length === 1) {
    const sourceId =
      request.requests[0]?.sourceModuleIds[0] ??
      request.requests[0]?.targetFilePath;
    return path
      .basename(sourceId ?? "bundle")
      .replace(/\.[^/.]+$/u, "")
      .replace(/[^\w.-]+/gu, "-");
  }

  return classifyPackageName(request.sourceModuleIds[0] ?? "bundle").replace(
    /[^\w.-]+/gu,
    "-",
  );
}

function sanitizeRegionKey(regionKey: string) {
  if (regionKey === EAGER_REGION_LABEL) {
    return "eager";
  }
  return regionKey
    .split("|")
    .map((segment) => {
      if (segment.startsWith("dynamic:")) {
        return path
          .basename(segment.slice("dynamic:".length))
          .replace(/\.[^/.]+$/u, "");
      }
      return segment;
    })
    .join("__")
    .replace(/[^\w.-]+/gu, "-");
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(filePath: string) {
  return path.normalize(filePath);
}

function classifyPackageName(moduleId: string) {
  const normalized = moduleId.replace(/\\/g, "/");
  const nodeModulesIndex = normalized.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) {
    return "bundle";
  }

  const packagePath = normalized.slice(
    nodeModulesIndex + "/node_modules/".length,
  );
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || "bundle";
}

async function loadEsbuildBuild() {
  if (cachedEsbuildBuild) {
    return cachedEsbuildBuild;
  }

  cachedEsbuildBuild = (async () => {
    const require = createRequire(import.meta.url);
    const vitePackagePath = require.resolve("vite/package.json");
    const esbuildPath = require.resolve("esbuild", {
      paths: [path.dirname(vitePackagePath)],
    });
    const esbuildModule = (await import(
      pathToFileURL(esbuildPath).href
    )) as typeof import("esbuild");
    return esbuildModule.build;
  })();

  return await cachedEsbuildBuild;
}
