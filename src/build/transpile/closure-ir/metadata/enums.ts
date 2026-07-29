import ts from "typescript";

import type { ClosureEnumDeclaration } from "../types";
import { getPropertyNameText, hasExportModifier } from "./modifiers";
import { canonicalSymbolId } from "./type-render";

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
  compilerOptions: ts.CompilerOptions,
) {
  if (isErasableConstEnum(statement, compilerOptions)) {
    return null;
  }
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }

  const members: ClosureEnumDeclaration["members"] = [];
  let valueType: ClosureEnumDeclaration["valueType"] | null = null;
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
    bindingName: statement.name.text,
    exported: hasExportModifier(statement),
    members,
    symbolId: resolved
      ? canonicalSymbolId(resolved)
      : `enum:${statement.getSourceFile().fileName}:${statement.getStart()}`,
    valueType,
  };
}

/**
 * A `const enum` TypeScript erases entirely.
 *
 * It has no runtime representation: every member read is inlined at the use
 * site and the object is gone, so `import * as m from "./x"; m.ConstEnum` is
 * `undefined`. Synthesising an object for it made that observable — the
 * divergence the tsickle `export` suite catches — and shipped bytes for a value
 * no legal program can reach, because TypeScript rejects every use of a const
 * enum outside a property access ("'const' enums can only be used in property
 * or index access expressions or the right hand side of an import declaration
 * or export assignment or type query").
 *
 * The reads do not depend on the object: `collect_ts_enum_literal_values` and
 * its imported counterpart inline them from the TypeScript AST *before* `strip`
 * runs, so inlining is independent of type-metadata emission and survives
 * `GCC_DISABLE_TYPE_INFERENCE=1`.
 *
 * Decided by the two compiler options that own the question, never by a name
 * list: `preserveConstEnums` asks for the object explicitly, and
 * `isolatedModules` forbids cross-file inlining, so TypeScript itself emits a
 * real enum object in that mode and so must we.
 */
export function isErasableConstEnum(
  node: ts.EnumDeclaration,
  compilerOptions: ts.CompilerOptions,
) {
  return (
    hasConstModifier(node) &&
    !compilerOptions.preserveConstEnums &&
    !compilerOptions.isolatedModules
  );
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
