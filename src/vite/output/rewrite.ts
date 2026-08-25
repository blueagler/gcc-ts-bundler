import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";

export async function rewritePreservedImportSpecifiers(input: {
  outDir: string;
  outputFiles: string[];
}) {
  await Promise.all(
    input.outputFiles
      .filter((filePath) => filePath.endsWith(".js"))
      .map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        const sourceFile = ts.createSourceFile(
          filePath,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        const edits: Array<{ end: number; start: number; text: string }> = [];
        const visit = (node: ts.Node) => {
          const literal =
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
              ? node.moduleSpecifier
              : undefined;
          if (literal) {
            const markerIndex = literal.text.indexOf("__gcc_preserved/");
            if (markerIndex >= 0) {
              const targetPath = path.join(
                input.outDir,
                literal.text.slice(markerIndex),
              );
              const relative = path
                .relative(path.dirname(filePath), targetPath)
                .replace(/\\/g, "/");
              edits.push({
                end: literal.getEnd() - 1,
                start: literal.getStart(sourceFile) + 1,
                text: relative.startsWith(".") ? relative : `./${relative}`,
              });
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);
        if (edits.length > 0) {
          await fs.writeFile(filePath, applyTextEdits(source, edits), "utf8");
        }
      }),
  );
}
