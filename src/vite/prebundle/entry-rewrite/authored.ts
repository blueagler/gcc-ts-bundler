import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { syncDirectoryEntries } from "../../../shared/files";
import { applyTextEdits } from "../../../shared/text-edits";
import { toRelativeImportSpecifier } from "../../capture";
import type { MaterializedGraph } from "../../internal-types";
import type { CollapsibleBundleEntryOutput } from "../entry-outputs";
import {
  dedupeAuthoredImportStatements,
  renderCollapsedBundleImportStatement,
} from "./shared";
import {
  DEP_BUNDLE_INPUT_DIR,
  DEP_BUNDLE_OUTPUT_DIR,
  normalizePath,
} from "../shared";

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
          if (!(
            (ts.isImportDeclaration(statement) ||
              ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier &&
            ts.isStringLiteralLike(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text.startsWith(".")
          )) {
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
