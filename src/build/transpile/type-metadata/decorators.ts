import ts from "@typescript/typescript6";

export function transpileDecoratedSource({
  compilerOptions,
  fileName,
  sourceText,
}: {
  compilerOptions: ts.CompilerOptions;
  fileName: string;
  sourceText: string;
}) {
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      ...compilerOptions,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      sourceMap: false,
      target: ts.ScriptTarget.ES2018,
    },
    fileName,
    reportDiagnostics: true,
  });
}
