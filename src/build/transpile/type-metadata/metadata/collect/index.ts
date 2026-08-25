import ts from "@typescript/typescript6";

import { collectClosureDocsForSourceFile } from "./annotations";
import { collectObjectLiteralBrands } from "./brands";
import {
  collectDecoratedOutputText,
  collectEnumDeclarationsForSourceFile,
  collectTypeDeclarationsForSourceFile,
} from "./declarations";
import { createClosureDocRenderContext } from "../type-render/index";
import type { ClosureTypeMetadataFile } from "../../types";
import type { ClosureIrFileFeatures } from "../scan";

export { collectClassOnlyInterfaceSymbolIds } from "./declarations";

export function collectClosureIrFileMetadata({
  classOnlyInterfaceSymbolIds,
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols,
}: {
  classOnlyInterfaceSymbolIds: ReadonlySet<string>;
  compilerOptions: ts.CompilerOptions;
  checker: ts.TypeChecker;
  features: ClosureIrFileFeatures;
  sourceFile: ts.SourceFile;
  unsafeEnumSymbols: Set<ts.Symbol>;
}): { diagnostics: ts.Diagnostic[]; file: ClosureTypeMetadataFile } {
  const diagnostics: ts.Diagnostic[] = [];
  const renderContext = createClosureDocRenderContext(sourceFile);
  const explicitTypeDeclarations = features.hasTypeDeclarations
    ? collectTypeDeclarationsForSourceFile(
        sourceFile,
        checker,
        renderContext,
        classOnlyInterfaceSymbolIds,
      )
    : [];
  const brandMetadata = collectObjectLiteralBrands(
    sourceFile,
    checker,
    renderContext,
  );
  const annotations = [
    ...(features.hasTopLevelDocs
      ? collectClosureDocsForSourceFile(
          sourceFile,
          checker,
          features,
          renderContext,
        )
      : []),
    ...brandMetadata.annotations,
  ];
  const declarations = [
    ...explicitTypeDeclarations,
    ...renderContext.typeDeclarations,
    ...brandMetadata.declarations,
  ];
  const enumDeclarations = features.hasEnumDeclarations
    ? collectEnumDeclarationsForSourceFile(
        sourceFile,
        checker,
        unsafeEnumSymbols,
        compilerOptions,
      )
    : [];
  for (const enumDeclaration of enumDeclarations) {
    if (!renderContext.symbolsById.has(enumDeclaration.symbolId)) {
      renderContext.symbolsById.set(enumDeclaration.symbolId, {
        diagnosticName: enumDeclaration.bindingName,
        id: enumDeclaration.symbolId,
        kind: "runtime",
        localName: enumDeclaration.bindingName,
      });
    }
  }
  const decoratedOutputText = features.hasDecorators
    ? collectDecoratedOutputText({
        compilerOptions,
        diagnostics,
        fileName: sourceFile.fileName,
        sourceText: sourceFile.getFullText(),
      })
    : undefined;

  return {
    diagnostics,
    file: {
      annotations,
      declarations,
      decoratedOutputText,
      diagnostics: renderContext.diagnostics,
      enums: enumDeclarations,
      filePath: sourceFile.fileName,
      sourceFilePath: sourceFile.fileName,
      symbols: [...renderContext.symbolsById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
  };
}
