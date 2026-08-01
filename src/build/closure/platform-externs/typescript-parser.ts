import * as ts from "@typescript/typescript6";

export function parseJavaScriptSource(
  fileName: string,
  source: string,
): ts.SourceFile | null {
  let diagnostics: readonly ts.Diagnostic[] | undefined;
  try {
    diagnostics = ts.transpileModule(source, {
      compilerOptions: {
        allowJs: true,
        target: ts.ScriptTarget.Latest,
      },
      fileName,
      reportDiagnostics: true,
    }).diagnostics;
  } catch {
    return null;
  }
  if (
    diagnostics?.some(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
  ) {
    return null;
  }
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
}
