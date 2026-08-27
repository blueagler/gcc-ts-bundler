import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";

const PRESERVED_MARKER = "__gcc_preserved/";

/**
 * The string literal of a static `import`/`export ... from`, if the node is
 * one of those declarations and names a string specifier.
 */
export function staticModuleSpecifier(node: ts.Node) {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) {
    return undefined;
  }
  const specifier = node.moduleSpecifier;
  if (!specifier || !ts.isStringLiteralLike(specifier)) {
    return undefined;
  }
  return specifier;
}

/**
 * Repoints `__gcc_preserved/` module specifiers at their emitted location,
 * relative to the importing chunk. Text-in/text-out so the emit pipeline can
 * chain it with the other whole-file output rewrites over a single read.
 * Returns `code` unchanged when the chunk carries no preserved specifier.
 */
export function rewritePreservedImportSpecifiers(input: {
  code: string;
  filePath: string;
  outDir: string;
}) {
  if (!input.code.includes(PRESERVED_MARKER)) {
    return input.code;
  }
  const sourceFile = ts.createSourceFile(
    input.filePath,
    input.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    const literal = staticModuleSpecifier(node);
    if (literal) {
      const markerIndex = literal.text.indexOf(PRESERVED_MARKER);
      if (markerIndex >= 0) {
        const targetPath = path.join(
          input.outDir,
          literal.text.slice(markerIndex),
        );
        const relative = path
          .relative(path.dirname(input.filePath), targetPath)
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
  return edits.length > 0 ? applyTextEdits(input.code, edits) : input.code;
}
