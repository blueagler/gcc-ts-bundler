import ts from "@typescript/typescript6";

import { isClosureQualifiedName } from "../../../../../shared/closure-type-strings";
import type { ClosureDocRenderContext } from "./context";
import {
  referenceRuntimeSymbol,
  referenceSymbolId,
  safeSymbolToString,
  symbolParent,
} from "./context";

/**
 * Enum member literal -> `!EnumName`, never `EnumName.MEMBER`.
 *
 * `getBaseTypeOfLiteralType` widens a member literal to its enum, except for a
 * **single-member enum**, where TS returns the literal itself (TS#28869). In
 * that case the parent enum is reached through the member symbol's parent, so
 * the workaround walks there rather than accepting the widened primitive.
 * TS5 enums are unions of literals, so the union path resolves member-wise and
 * dedupes back to one name.
 */
export function renderEnumLiteralType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  if (!(type.flags & ts.TypeFlags.EnumLike)) {
    return null;
  }
  const enumSymbol = enumParentSymbol(type, checker);
  if (!enumSymbol) {
    return null;
  }
  const name = safeSymbolToString(enumSymbol, checker, context);
  if (!name) {
    return "?";
  }
  if (!isClosureQualifiedName(name)) {
    return null;
  }
  const declaredSymbolId = context.symbolIdByDeclaredName.get(name);
  if (declaredSymbolId) {
    return `!${referenceSymbolId(declaredSymbolId, context)}`;
  }
  return `!${referenceRuntimeSymbol(enumSymbol, enumSymbol, name, context)}`;
}

function enumParentSymbol(type: ts.Type, checker: ts.TypeChecker) {
  const widened = checker.getBaseTypeOfLiteralType(type);
  const widenedSymbol = widened.getSymbol();
  if (widenedSymbol && widenedSymbol.flags & ts.SymbolFlags.Enum) {
    return widenedSymbol;
  }
  // Single-member enum: the widened type is still the literal, so walk from
  // the member symbol to its declaring enum.
  const memberSymbol = type.getSymbol();
  const parent = memberSymbol && symbolParent(memberSymbol);
  return parent && parent.flags & ts.SymbolFlags.Enum ? parent : undefined;
}

/**
 * `{}` with no members, no call/construct signatures and no index signature.
 *
 * `!Object` is wrong here: it is not a supertype of `string` or `number`, so
 * every primitive assignment to a `{}`-typed slot becomes a type error. `*` is
 * the honest spelling — TS `{}` means "anything but null/undefined", and `*`
 * is the closest Closure has.
 */
function isEmptyAnonymousType(type: ts.Type, checker: ts.TypeChecker) {
  return (
    !!(type.flags & ts.TypeFlags.Object) &&
    type.getProperties().length === 0 &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0 &&
    checker.getIndexInfosOfType(type).length === 0 &&
    !checker.isArrayType(type) &&
    !checker.isTupleType(type)
  );
}

/**
 * Anonymous object types.
 *
 * tsickle renders these as Closure record literals (`{a: T, b: U}`). We
 * deliberately do **not**: the structural-record experiment was measured at
 * zero delivered bytes and deleted one wave ago, and `test/closure-ir.test.mjs`
 * locks declaration-file structures to a single `?` atom. Re-synthesizing them
 * here would regress a decision we already paid to make.
 *
 * The one part of the row that is a correctness fix — and is adopted — is the
 * **empty** anonymous type. `{}` in TS means "anything but null/undefined";
 * `!Object` is not a supertype of `string` or `number`, so rendering it that
 * way makes every primitive assignment to a `{}` slot a type error. `*` is the
 * honest spelling.
 */
export function renderAnonymousRecordType(
  type: ts.Type,
  checker: ts.TypeChecker,
) {
  return isEmptyAnonymousType(type, checker) ? "*" : null;
}
