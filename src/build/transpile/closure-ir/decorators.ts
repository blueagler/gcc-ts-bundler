import ts from "@typescript/typescript6";

export function containsDecorators(sourceFile: ts.SourceFile) {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (
      ts.canHaveDecorators(node) &&
      (ts.getDecorators(node)?.length ?? 0) > 0
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

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
