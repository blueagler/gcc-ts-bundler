import fs from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";

import type { OutputChunk } from "../internal-types";
import { applyFileRenames, relativeSpecifier } from "./helpers";

export async function rewriteAndRenameCompiledFiles(
  outDir: string,
  outputFiles: string[],
  renameMap: Map<string, string>,
) {
  for (const outputFile of outputFiles.filter((file) => file.endsWith(".js"))) {
    const oldName = path.relative(outDir, outputFile).replace(/\\/g, "/");
    const newName = renameMap.get(oldName) ?? oldName;
    let source = await fs.readFile(outputFile, "utf8");
    for (const [oldTarget, newTarget] of renameMap) {
      const oldSpecifier = relativeSpecifier(oldName, oldTarget);
      const newSpecifier = relativeSpecifier(newName, newTarget);
      for (const candidate of [
        oldSpecifier,
        oldSpecifier.replace(/^\.\//u, ""),
      ]) {
        source = source.replaceAll(
          JSON.stringify(candidate),
          JSON.stringify(newSpecifier),
        );
        source = source.replaceAll(`'${candidate}'`, `'${newSpecifier}'`);
        // Final minification runs before this pass and re-quotes with
        // backticks, and the runtime manifest's chunk urls are ordinary
        // strings inside the base chunk: miss this spelling and a renamed
        // lazy chunk keeps a url that no longer exists.
        source = source.replaceAll(`\`${candidate}\``, `\`${newSpecifier}\``);
      }
    }
    await fs.writeFile(outputFile, source, "utf8");
  }
  await applyFileRenames(outDir, renameMap);
}

export function applyChunkMetadata(chunk: OutputChunk) {
  const sourceFile = ts.createSourceFile(
    chunk.fileName,
    chunk.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = new Set<string>();
  const dynamicImports = new Set<string>();
  const visit = (node: ts.Node) => {
    const literal =
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
        ? node.moduleSpecifier
        : undefined;
    if (literal?.text.startsWith(".")) {
      imports.add(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(chunk.fileName), literal.text),
        ),
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".")
    ) {
      dynamicImports.add(
        path.posix.normalize(
          path.posix.join(
            path.posix.dirname(chunk.fileName),
            node.arguments[0].text,
          ),
        ),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  chunk.imports = [...imports].sort();
  chunk.dynamicImports = [...dynamicImports].sort();
}
