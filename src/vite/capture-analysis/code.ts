import ts from "@typescript/typescript6";

import type { CapturedModuleAnalysis } from "../internal-types";
import { stripQuery } from "../capture/specifiers";

function isEffectivelyEmptyStatement(statement: ts.Statement) {
  if (ts.isEmptyStatement(statement)) {
    return true;
  }
  return isEmptyExportStatement(statement);
}

function isEmptyExportStatement(statement: ts.Statement) {
  if (!ts.isExportDeclaration(statement)) {
    return false;
  }
  if (statement.moduleSpecifier) {
    return false;
  }
  if (!statement.exportClause) {
    return true;
  }
  return (
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length === 0
  );
}

export function resolveScriptKind(id: string) {
  const cleanId = stripQuery(id);
  if (cleanId.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (cleanId.endsWith(".ts")) {
    return ts.ScriptKind.TS;
  }
  if (cleanId.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

export function analyzeModuleCode(
  id: string,
  code: string,
): CapturedModuleAnalysis {
  const sourceFile = ts.createSourceFile(
    id,
    code,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(id),
  );
  const importSpecifiers = new Set<string>();
  const dynamicImportSpecifiers = new Set<string>();
  const bridgeSpecifiers = new Set<string>();
  const commonJsExportAliases = new Set<string>();
  const commonJsNamedExports = new Set<string>();
  const collectCommonJsAliases = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExportsAccess(node.left) &&
      ts.isIdentifier(node.right)
    ) {
      commonJsExportAliases.add(node.right.text);
    }
    ts.forEachChild(node, collectCommonJsAliases);
  };
  collectCommonJsAliases(sourceFile);
  let isForwardingOnly = true;
  let hasCommonJsSyntax = false;
  let hasEsmSyntax = false;
  let hasExtendingClass = false;
  let needsClosureCompatibility = false;
  let needsTypeScriptCompatibility = false;

  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) {
      continue;
    }

    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      hasEsmSyntax = true;
      const specifier = statement.moduleSpecifier.text;
      importSpecifiers.add(specifier);
      if (statement.importClause) {
        bridgeSpecifiers.add(specifier);
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      hasEsmSyntax = true;
      if (
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        importSpecifiers.add(statement.moduleSpecifier.text);
      }
      continue;
    }

    if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) {
        hasCommonJsSyntax = true;
      } else {
        hasEsmSyntax = true;
      }
    } else if (
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      hasEsmSyntax = true;
    }

    if (isEmptyExportStatement(statement)) {
      continue;
    }

    isForwardingOnly = false;
  }

  const visit = (node: ts.Node) => {
    const firstArgument = ts.isCallExpression(node)
      ? node.arguments[0]
      : undefined;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      hasCommonJsSyntax = true;
    } else if (
      ts.isBinaryExpression(node) &&
      isCommonJsExportTarget(node.left)
    ) {
      hasCommonJsSyntax = true;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const directExportName = commonJsExportName(node.left);
      if (directExportName && directExportName !== "default") {
        commonJsNamedExports.add(directExportName);
      }
      const aliasedExportName = commonJsAliasedExportName(
        node.left,
        commonJsExportAliases,
      );
      if (aliasedExportName) {
        commonJsNamedExports.add(aliasedExportName);
      }
    } else if (isModuleExportsAccess(node)) {
      hasCommonJsSyntax = true;
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "defineProperty" &&
      node.arguments[0] !== undefined &&
      (isExportsIdentifier(node.arguments[0]) ||
        isModuleExportsAccess(node.arguments[0]))
    ) {
      hasCommonJsSyntax = true;
    }

    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      hasEsmSyntax = true;
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      firstArgument !== undefined &&
      ts.isStringLiteralLike(firstArgument)
    ) {
      const specifier = firstArgument.text;
      importSpecifiers.add(specifier);
      dynamicImportSpecifiers.add(specifier);
      bridgeSpecifiers.add(specifier);
    }

    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )
    ) {
      hasExtendingClass = true;
    }

    if (ts.isPrivateIdentifier(node) || isClassStaticBlockNode(node)) {
      needsClosureCompatibility = true;
    }

    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      node.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      needsTypeScriptCompatibility = true;
    } else if (ts.isMetaProperty(node)) {
      if (
        node.keywordToken === ts.SyntaxKind.NewKeyword &&
        node.name.escapedText === "target"
      ) {
        needsTypeScriptCompatibility = true;
      }
    } else if (
      (ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isComputedPropertyName(node.name)
    ) {
      needsTypeScriptCompatibility = true;
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    bridgeSpecifiers: [...bridgeSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    commonJsNamedExports: [...commonJsNamedExports].sort((left, right) =>
      left.localeCompare(right),
    ),
    dynamicImportSpecifiers: [...dynamicImportSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    importSpecifiers: [...importSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    isEffectivelyEmpty: sourceFile.statements.every(
      isEffectivelyEmptyStatement,
    ),
    hasExtendingClass,
    isForwardingOnly,
    moduleFormat: hasEsmSyntax
      ? hasCommonJsSyntax
        ? "mixed"
        : "esm"
      : hasCommonJsSyntax
        ? "cjs"
        : "unknown",
    needsClosureCompatibilityDownlevel: needsClosureCompatibility,
    needsTypeScriptCompatibilityDownlevel: needsTypeScriptCompatibility,
  };
}

function isCommonJsExportTarget(node: ts.Expression): boolean {
  return commonJsExportName(node) !== null;
}

function commonJsExportName(node: ts.Expression): string | null {
  if (isModuleExportsAccess(node)) {
    return "default";
  }
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return null;
  }
  if (
    !isExportsIdentifier(node.expression) &&
    !isModuleExportsAccess(node.expression)
  ) {
    return null;
  }
  return propertyAccessName(node);
}

function commonJsAliasedExportName(
  node: ts.Expression,
  aliases: Set<string>,
): string | null {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    !ts.isIdentifier(node.expression) ||
    !aliases.has(node.expression.text)
  ) {
    return null;
  }
  return propertyAccessName(node);
}

function propertyAccessName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : null;
}

function isExportsIdentifier(node: ts.Node) {
  return ts.isIdentifier(node) && node.text === "exports";
}

function isModuleExportsAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function isClassStaticBlockNode(node: ts.Node) {
  return node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration;
}
