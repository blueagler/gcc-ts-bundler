import ts from "typescript";

import { transpileDecoratedSource } from "../decorators";
import {
  buildClassJsDoc,
  buildFunctionJsDoc,
  buildFunctionObjectParamRecord,
  buildInterfaceDeclarationSnippet,
  buildTypeAliasDeclarationSnippet,
} from "./docs";
import { buildEnumDeclarationMetadata } from "./enums";
import {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTypeDeclaration,
} from "../types";
import { isDocRelevantTopLevelDeclaration } from "./doc-eligibility";
import type { ClosureIrFileFeatures } from "./scan";

export function collectClosureIrFileMetadata({
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols,
}: {
  compilerOptions: ts.CompilerOptions;
  checker: ts.TypeChecker;
  features: ClosureIrFileFeatures;
  sourceFile: ts.SourceFile;
  unsafeEnumSymbols: Set<ts.Symbol>;
}): { diagnostics: ts.Diagnostic[]; file: ClosureIrFileMetadata } {
  const diagnostics: ts.Diagnostic[] = [];
  const typeDeclarations = features.hasTypeDeclarations
    ? collectTypeDeclarationsForSourceFile(sourceFile, checker)
    : [];
  const topLevelDocs = features.hasTopLevelDocs
    ? collectTopLevelDocsForSourceFile(
        sourceFile,
        checker,
        features,
        typeDeclarations,
      )
    : [];
  const enumDeclarations = features.hasEnumDeclarations
    ? collectEnumDeclarationsForSourceFile(
        sourceFile,
        checker,
        unsafeEnumSymbols,
      )
    : [];
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
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations,
    },
  };
}

function collectTypeDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const typeDeclarations: ClosureIrTypeDeclaration[] = [];

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
    }
  }

  return typeDeclarations;
}

function collectTopLevelDocsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  features: ClosureIrFileFeatures,
  typeDeclarations: ClosureIrTypeDeclaration[],
) {
  const topLevelDocs: ClosureIrFileMetadata["topLevelDocs"] = [];

  for (const statement of sourceFile.statements) {
    if (!isDocRelevantTopLevelDeclaration(statement, features.docEligibility)) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
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
          name: statement.name!.text,
        });
      }
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      const jsdoc = buildClassJsDoc(statement, checker);
      if (jsdoc) {
        topLevelDocs.push({
          jsdoc,
          kind: "class",
          name: statement.name!.text,
        });
      }
    }
  }

  return topLevelDocs;
}

function collectEnumDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
) {
  const enumDeclarations: ClosureIrEnumDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isEnumDeclaration(statement)) {
      continue;
    }

    const enumDeclaration = buildEnumDeclarationMetadata(
      statement,
      checker,
      unsafeEnumSymbols,
    );
    if (enumDeclaration) {
      enumDeclarations.push(enumDeclaration);
    }
  }

  return enumDeclarations;
}

function collectDecoratedOutputText({
  compilerOptions,
  diagnostics,
  fileName,
  sourceText,
}: {
  compilerOptions: ts.CompilerOptions;
  diagnostics: ts.Diagnostic[];
  fileName: string;
  sourceText: string;
}) {
  const transpiled = transpileDecoratedSource({
    compilerOptions,
    fileName,
    sourceText,
  });
  diagnostics.push(
    ...(transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
  );
  return transpiled.outputText;
}
