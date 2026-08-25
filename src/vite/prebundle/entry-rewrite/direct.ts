import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../../shared/text-edits";
import { toRelativeImportSpecifier } from "../../capture";
import type { MaterializedGraph } from "../../internal-types";
import type { CollapsibleBundleEntryOutput } from "../entry-outputs";
import {
  dedupeAuthoredImportStatements,
  renderCollapsedBundleImportStatement,
} from "./shared";
import { normalizePath } from "../shared";

/**
 * Rewrite direct dependency modules so imports of prebundled modules point at
 * those modules' atom bundles, and return the staged contents. Direct modules
 * stay in the native pipeline; only the specifier crossing into an atom moves.
 */
export async function rewriteDirectDependencyModules(input: {
  atomOutputByTargetFilePath: Map<string, string>;
  collapsedEntryOutputByPath: Map<string, CollapsibleBundleEntryOutput>;
  directDependencyFilePaths: Set<string>;
  materialized: MaterializedGraph;
  runtimeSrcDir: string;
}): Promise<Array<{ content: string; relativePath: string }>> {
  return await Promise.all(
    input.materialized.modules
      .filter((module) =>
        input.directDependencyFilePaths.has(normalizePath(module.filePath)),
      )
      .map(async (module) => {
        const normalizedFilePath = normalizePath(module.filePath);
        const sourceText = await fs.readFile(normalizedFilePath, "utf8");
        const outputFilePath = normalizePath(
          path.join(input.runtimeSrcDir, module.relativePath),
        );
        if (input.atomOutputByTargetFilePath.size === 0) {
          return { content: sourceText, relativePath: module.relativePath };
        }
        const sourceFile = ts.createSourceFile(
          normalizedFilePath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const edits: Array<{ end: number; start: number; text: string }> = [];
        const resolveAtomOutput = (specifierText: string) => {
          const targetFilePath = normalizePath(
            path.resolve(path.dirname(normalizedFilePath), specifierText),
          );
          return input.atomOutputByTargetFilePath.get(targetFilePath);
        };

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
          const atomOutput = resolveAtomOutput(statement.moduleSpecifier.text);
          if (!atomOutput) {
            continue;
          }
          const collapsedOutput =
            input.collapsedEntryOutputByPath.get(atomOutput);
          if (!collapsedOutput) {
            edits.push({
              end: statement.moduleSpecifier.getEnd() - 1,
              start: statement.moduleSpecifier.getStart() + 1,
              text: toRelativeImportSpecifier(outputFilePath, atomOutput),
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
            const atomOutput = resolveAtomOutput(firstArgument.text);
            if (atomOutput) {
              edits.push({
                end: firstArgument.getEnd() - 1,
                start: firstArgument.getStart() + 1,
                text: toRelativeImportSpecifier(
                  outputFilePath,
                  input.collapsedEntryOutputByPath.get(atomOutput)
                    ?.directTargetFilePath ?? atomOutput,
                ),
              });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);

        return {
          content:
            edits.length === 0
              ? sourceText
              : dedupeAuthoredImportStatements(
                  outputFilePath,
                  applyTextEdits(sourceText, edits),
                ),
          relativePath: module.relativePath,
        };
      }),
  );
}
