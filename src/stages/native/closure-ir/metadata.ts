import ts from "typescript";

import { containsDecorators, transpileDecoratedSource } from "./decorators";
import {
  buildClassJsDoc,
  buildFunctionJsDoc,
  buildFunctionObjectParamRecord,
  buildInterfaceDeclarationSnippet,
  buildTypeAliasDeclarationSnippet,
} from "./metadata/docs";
import {
  buildEnumDeclarationMetadata,
  collectUnsafeEnumSymbols,
} from "./metadata/enums";
import {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTypeDeclaration,
} from "./types";

export function collectClosureIrFiles({
  compilerOptions,
  fileNames,
  program,
}: {
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
}): { diagnostics: ts.Diagnostic[]; files: ClosureIrFileMetadata[] } {
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const inputFiles = new Set(fileNames);

  const diagnostics: ts.Diagnostic[] = [];
  const files: ClosureIrFileMetadata[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }

    const typeDeclarations: ClosureIrTypeDeclaration[] = [];
    const topLevelDocs: ClosureIrFileMetadata["topLevelDocs"] = [];
    const enumDeclarations: ClosureIrEnumDeclaration[] = [];

    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(
          buildInterfaceDeclarationSnippet(statement, checker),
        );
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(
          buildTypeAliasDeclarationSnippet(statement, checker),
        );
        continue;
      }

      if (ts.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(
          statement,
          checker,
          unsafeEnumSymbols,
        );
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const objectParamRecord = buildFunctionObjectParamRecord(
          statement,
          checker,
        );
        if (objectParamRecord) {
          typeDeclarations.push({ snippet: objectParamRecord.snippet });
        }
        const jsdoc = buildFunctionJsDoc(
          statement,
          checker,
          objectParamRecord?.typeName,
        );
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: statement.name.text,
          });
        }
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        const jsdoc = buildClassJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "class",
            name: statement.name.text,
          });
        }
      }
    }

    let decoratedOutputText: string | undefined;
    if (containsDecorators(sourceFile)) {
      const transpiled = transpileDecoratedSource({
        compilerOptions,
        fileName: sourceFile.fileName,
        sourceText: sourceFile.getFullText(),
      });
      diagnostics.push(
        ...(transpiled.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        ),
      );
      decoratedOutputText = transpiled.outputText;
    }

    files.push({
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations,
    });
  }

  return { diagnostics, files };
}
