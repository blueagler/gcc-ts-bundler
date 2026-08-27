import ts from "@typescript/typescript6";

import {
  isClosureQualifiedName,
  unionClosureTypes,
} from "../../../../../shared/closure-type-strings";
import type { ClosureDocRenderContext } from "./context";
import { recurseClosureType as toClosureType } from "./core";

export function getTypedDeclarationClosureType(
  declaration:
    | ts.ParameterDeclaration
    | ts.PropertyDeclaration
    | ts.PropertySignature,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const symbol = declaration.name
    ? checker.getSymbolAtLocation(declaration.name)
    : undefined;
  const type = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : declaration.type
      ? checker.getTypeFromTypeNode(declaration.type)
      : checker.getTypeAtLocation(declaration);
  const closureType = toClosureType(
    type,
    checker,
    context,
    new Set(),
    declaration.type,
  );
  return declaration.questionToken
    ? unionClosureTypes([closureType, "undefined"])
    : closureType;
}

/**
 * Supertype for `@extends` / `@implements`, or null when the supertype has no
 * nameable Closure form.
 *
 * Three tsickle rules are encoded here:
 *
 * 1. **Strip the leading `!`.** `@extends {!X}` is rejected by Closure —
 *    heritage positions are inherently non-null, and the modifier is a syntax
 *    error there. Type *arguments* keep theirs (`@extends {X<!Y>}`).
 * 2. **Refuse symbol-less and structural supertypes.** A mapped-type or
 *    type-literal supertype degrades to `?` or a record literal; `@extends {?}`
 *    and `@extends {{a: number}}` are not heritage, they are noise that
 *    suppresses real inheritance checking. Emitting nothing is strictly better.
 * 3. **Drop a trailing `this` type argument** (TS#38391): TS materialises the
 *    polymorphic `this` as a final type argument that has no Closure spelling.
 *
 * The `implements`-to-`@extends` rewrite tsickle carries is deliberately NOT
 * adopted; their own comment calls it a poorly-thought-out hack
 * (closure-compiler#3126).
 */
export function toClosureHeritageType(
  typeNode: ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const rendered = toClosureType(
    checker.getTypeAtLocation(typeNode),
    checker,
    context,
    new Set(),
    typeNode,
  )
    .replace(/^!/, "")
    .replace(/<this>$/u, "")
    .replace(/,\s*this(?=>)/gu, "");
  if (!isNameableHeritageType(rendered)) {
    return null;
  }
  return rendered;
}

function isNameableHeritageType(rendered: string) {
  if (!rendered || rendered === "?" || rendered === "*") {
    return false;
  }
  // Record literals, unions and function types are structural, not nominal.
  if (/^[{(]/u.test(rendered) || rendered.startsWith("function(")) {
    return false;
  }
  const head = rendered.replace(/<.*$/su, "");
  return isClosureQualifiedName(head);
}

export function isWorthAnnotatingVariableType(
  type: ts.Type,
  checker: ts.TypeChecker,
) {
  if (
    type.flags &
    (ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null |
      ts.TypeFlags.Never)
  ) {
    return false;
  }
  return (
    checker.isArrayType(type) ||
    checker.isTupleType(type) ||
    type.getCallSignatures().length > 0 ||
    type.getProperties().length > 0 ||
    Boolean(type.getSymbol() || type.aliasSymbol)
  );
}
