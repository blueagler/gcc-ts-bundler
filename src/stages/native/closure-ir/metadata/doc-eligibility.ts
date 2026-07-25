import ts from "typescript";

import { hasExportModifier } from "./modifiers";

export interface ClosureIrDocEligibility {
  exportedDeclarationNames: Set<string>;
  hasJsDocText: boolean;
  hasTsCheckText: boolean;
  hasTopLevelDocs: boolean;
  isTypeScriptLike: boolean;
}

export function classifyClosureIrDocEligibility(
  sourceFile: ts.SourceFile,
): ClosureIrDocEligibility {
  const exportedDeclarationNames =
    collectExportedTopLevelDeclarationNames(sourceFile);
  const hasJsDocText = sourceFile.text.includes("/**");
  const hasTsCheckText = sourceFile.text.includes("@ts-check");
  const isTypeScriptLike = isTypeScriptLikeSourceFile(sourceFile);
  let hasTopLevelDocs = false;

  for (const statement of sourceFile.statements) {
    if (
      isDocRelevantTopLevelDeclaration(statement, {
        exportedDeclarationNames,
        hasJsDocText,
        isTypeScriptLike,
      })
    ) {
      hasTopLevelDocs = true;
      break;
    }
  }

  return {
    exportedDeclarationNames,
    hasJsDocText,
    hasTsCheckText,
    hasTopLevelDocs,
    isTypeScriptLike,
  };
}

export function isDocRelevantTopLevelDeclaration(
  statement: ts.Statement,
  eligibility: Pick<
    ClosureIrDocEligibility,
    "exportedDeclarationNames" | "hasJsDocText" | "isTypeScriptLike"
  >,
): statement is ts.FunctionDeclaration | ts.ClassDeclaration {
  if (
    !(
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    )
  ) {
    return false;
  }

  if (
    eligibility.isTypeScriptLike &&
    hasNamedExport(statement, eligibility.exportedDeclarationNames)
  ) {
    return true;
  }

  if (
    ts.isFunctionDeclaration(statement) &&
    canGenerateComponentObjectParamRecord(statement)
  ) {
    return true;
  }

  return (
    eligibility.hasJsDocText && ts.getJSDocCommentsAndTags(statement).length > 0
  );
}

function collectExportedTopLevelDeclarationNames(sourceFile: ts.SourceFile) {
  const exportedNames = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name &&
      hasExportModifier(statement)
    ) {
      exportedNames.add(statement.name.text);
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (
        ts.isNamedExports(statement.exportClause) &&
        !statement.moduleSpecifier
      ) {
        for (const element of statement.exportClause.elements) {
          exportedNames.add(element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }

    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    ) {
      exportedNames.add(statement.expression.text);
    }
  }

  return exportedNames;
}

function hasNamedExport(
  statement: ts.FunctionDeclaration | ts.ClassDeclaration,
  exportedNames: ReadonlySet<string>,
) {
  return !!statement.name && exportedNames.has(statement.name.text);
}

function canGenerateComponentObjectParamRecord(
  statement: ts.FunctionDeclaration,
) {
  const firstParameter = statement.parameters[0];
  return (
    !!statement.name &&
    /^[A-Z]/.test(statement.name.text) &&
    !!firstParameter &&
    ts.isObjectBindingPattern(firstParameter.name) &&
    !firstParameter.name.elements.some((element) => element.dotDotDotToken)
  );
}

function isTypeScriptLikeSourceFile(sourceFile: ts.SourceFile) {
  return /\.(?:cts|mts|ts|tsx)$/u.test(sourceFile.fileName);
}
