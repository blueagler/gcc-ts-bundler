import ts from "typescript";

import type { ClosureIrEnumDeclaration } from "../types";
import { getPropertyNameText, hasExportModifier } from "./modifiers";

export function collectUnsafeEnumSymbols(
  sourceFiles: Iterable<ts.SourceFile>,
  checker: ts.TypeChecker,
) {
  const unsafe = new Set<ts.Symbol>();
  const mark = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol,
      );
    }
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        mark(node.expression);
      }
      const firstArgument = ts.isCallExpression(node)
        ? node.arguments[0]
        : undefined;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        ["entries", "keys", "values"].includes(node.expression.name.text) &&
        firstArgument !== undefined &&
        ts.isIdentifier(firstArgument)
      ) {
        mark(firstArgument);
      }
      if (
        ts.isIdentifier(node) &&
        !ts.isPropertyAccessExpression(node.parent) &&
        !ts.isElementAccessExpression(node.parent) &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isImportClause(node.parent) &&
        !ts.isExportSpecifier(node.parent) &&
        !ts.isEnumDeclaration(node.parent) &&
        !ts.isEnumMember(node.parent)
      ) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved =
            symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
          if (resolved.flags & ts.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return unsafe;
}

export function buildEnumDeclarationMetadata(
  statement: ts.EnumDeclaration,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }

  const members: ClosureIrEnumDeclaration["members"] = [];
  let valueType: ClosureIrEnumDeclaration["valueType"] | null = null;
  let nextNumber = 0;

  for (const member of statement.members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      return null;
    }

    const constantValue = checker.getConstantValue(member);
    const memberValue =
      constantValue ??
      (member.initializer
        ? literalValueFromExpression(member.initializer)
        : nextNumber);
    if (memberValue === undefined) {
      return null;
    }

    const currentValueType = typeof memberValue;
    if (
      currentValueType !== "number" &&
      currentValueType !== "string" &&
      currentValueType !== "boolean"
    ) {
      return null;
    }
    if (valueType && valueType !== currentValueType) {
      return null;
    }
    valueType = currentValueType;
    members.push({ name: memberName, value: memberValue });
    if (typeof memberValue === "number") {
      nextNumber = memberValue + 1;
    }
  }

  if (!valueType || members.length === 0) {
    return null;
  }

  if (valueType === "number" && !hasConstModifier(statement)) {
    return null;
  }

  return {
    exported: hasExportModifier(statement),
    members,
    name: statement.name.text,
    valueType,
  };
}

function hasConstModifier(node: ts.EnumDeclaration) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Const) !== 0;
}


function literalValueFromExpression(
  expression: ts.Expression,
): boolean | number | string | undefined {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  return undefined;
}
