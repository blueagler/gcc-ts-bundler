import * as ts from "@typescript/typescript6";

export function parseJavaScriptSource(
  fileName: string,
  source: string,
): ts.SourceFile | null {
  try {
    // JSDoc parsing is off because TypeScript's JSDoc parser recurses per
    // type token and overflows the stack on large minified chunks that
    // contain dense JSDoc-like comment blocks. The seed scan only walks
    // identifiers and property names, so the JSDoc AST is unused. Do not
    // restore transpileModule to "validate" the file — it re-enters that
    // parser. setParentNodes stays on because seeds.isValueIdentifier
    // reads node.parent.
    return ts.createSourceFile(
      fileName,
      source,
      {
        languageVersion: ts.ScriptTarget.Latest,
        jsDocParsingMode: ts.JSDocParsingMode.ParseNone,
      },
      true,
      ts.ScriptKind.JS,
    );
  } catch {
    return null;
  }
}
