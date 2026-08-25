import ts from "@typescript/typescript6";

import { firstOrUndefined } from "../../../../../shared/arrays";
import {
  sanitizeClosureName,
  unionWithSuffix,
} from "../../../../../shared/closure-type-strings";
import { uniqueSortedStrings } from "../../../../../shared/files";
import type { ClosureDocRenderContext } from "./context";
import {
  getTypeArguments,
  isReadonlyArrayType,
  recordUnresolvedType,
  recordSymbolRenderingFailure,
  referenceBuiltin,
  safeTypeToString,
} from "./context";
import {
  constructSignatureToClosureType,
  signatureToClosureFunctionType,
} from "./function";
import { renderNamedType } from "./named";
import { renderAnonymousRecordType, renderEnumLiteralType } from "./object";

const MAX_TYPE_DEPTH = 28;
const MAX_UNION_MEMBERS = 16;

export function toClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen = new Set<ts.Type>(),
  referenceNode?: ts.Node | undefined,
): string {
  try {
    return renderClosureType(type, checker, context, seen, referenceNode);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    // Guard one recursive type atom, not the metadata pass: siblings and later
    // files remain typed while only the pathological checker chain degrades.
    recordSymbolRenderingFailure(context, type.aliasSymbol ?? type.getSymbol());
    return "?";
  }
}

function renderClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
): string {
  if (seen.size > MAX_TYPE_DEPTH) {
    recordUnresolvedType(
      context,
      "type-reference-depth-exceeded",
      type,
      checker,
    );
    return "?";
  }
  if (seen.has(type)) {
    recordUnresolvedType(context, "unsupported-type-atom", type, checker);
    return "?";
  }
  seen.add(type);

  // `object` (TS NonPrimitive) is checked before everything else: tsickle does
  // the same, because it carries no other type flag that would classify it.
  if (type.flags & ts.TypeFlags.NonPrimitive) {
    return `!${referenceBuiltin("Object", context)}`;
  }
  if (type.flags & ts.TypeFlags.Any) return "?";
  // `unknown` is the ALL type, not the unknown type. `?` means "Closure does
  // not know"; `*` means "every value is allowed", which is what TS `unknown`
  // states. Emitting `?` throws away a fact the checker proved.
  if (type.flags & ts.TypeFlags.Unknown) return "*";
  // Enum member literals must render as the parent enum, never as the widened
  // primitive: `!E` keeps the nominal identity Closure needs for `@enum`
  // checking, while `number` erases it. Checked before the *Like tests, which
  // would otherwise swallow it.
  const enumName = renderEnumLiteralType(type, checker, context);
  if (enumName) return enumName;
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.UniqueESSymbol)) {
    // Closure has no notion of symbol uniqueness; `symbol` is the whole
    // vocabulary.
    return "symbol";
  }
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Never) {
    recordUnresolvedType(context, "unsupported-type-atom", type, checker);
    return "?";
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const rendered = safeTypeToString(type, checker, context);
    return rendered ? sanitizeClosureName(rendered) : "?";
  }

  if (type.isUnion()) {
    if (type.types.length > MAX_UNION_MEMBERS) {
      return collapseLargeUnion(type, checker, context);
    }
    const rendered = uniqueSortedStrings(
      type.types.map((item, index) =>
        toClosureType(
          item,
          checker,
          context,
          new Set(seen),
          referenceNode && ts.isUnionTypeNode(referenceNode)
            ? referenceNode.types[index]
            : undefined,
        ),
      ),
    );
    const onlyType = firstOrUndefined(rendered);
    return rendered.length === 1 && onlyType !== undefined
      ? onlyType
      : `(${rendered.join("|")})`;
  }

  if (type.isIntersection()) {
    // An intersection can be the same runtime object as any constituent.
    // `!Object` makes Closure treat it as a disjoint receiver type and can
    // rename shared properties apart. Unknown fails toward no split.
    return "?";
  }

  if (checker.isArrayType(type) || isReadonlyArrayType(type)) {
    const elementType = firstOrUndefined(getTypeArguments(type, checker));
    const arraySymbol = referenceBuiltin("Array", context);
    const elementNode =
      referenceNode && ts.isArrayTypeNode(referenceNode)
        ? referenceNode.elementType
        : referenceNode && ts.isTypeReferenceNode(referenceNode)
          ? referenceNode.typeArguments?.[0]
          : undefined;
    return `!${arraySymbol}<${
      elementType === undefined
        ? "?"
        : toClosureType(
            elementType,
            checker,
            context,
            new Set(seen),
            elementNode,
          )
    }>`;
  }

  if (checker.isTupleType(type)) {
    // `!Array<?>`, not a union of the element types. Measured at Google: the
    // union buys no optimization as long as destructuring is aliased, and it
    // makes every tuple position assignable to every other, which reports
    // wrong types at the sites that do read them positionally.
    return `!${referenceBuiltin("Array", context)}<?>`;
  }

  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 1 && type.getProperties().length === 0) {
    // Closure's `function(...)` syntax expresses exactly one signature; an
    // overload set has no faithful spelling, so the whole atom degrades.
    recordUnresolvedType(context, "unsupported-type-atom", type, checker);
    return "?";
  }
  const callSignature = firstOrUndefined(callSignatures);
  if (callSignature && type.getProperties().length === 0) {
    return signatureToClosureFunctionType(
      callSignature,
      checker,
      context,
      seen,
    );
  }
  const constructSignature = firstOrUndefined(type.getConstructSignatures());
  if (
    constructSignature &&
    callSignatures.length === 0 &&
    type.getProperties().length === 0
  ) {
    return constructSignatureToClosureType(
      constructSignature,
      checker,
      context,
      seen,
    );
  }

  const namedType = renderNamedType(
    type,
    checker,
    context,
    seen,
    referenceNode,
  );
  if (namedType) {
    return namedType;
  }

  const indexObject = renderIndexSignatureType(type, checker, context, seen);
  if (indexObject) {
    return indexObject;
  }

  const record = renderAnonymousRecordType(type, checker);
  if (record) {
    return record;
  }

  recordUnresolvedType(context, "unsupported-type-atom", type, checker);
  return "?";
}

/** `{[k: string]: V}` -> `!Object<string, V>`; numeric keys likewise. */
function renderIndexSignatureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
) {
  if (!(type.flags & ts.TypeFlags.Object)) {
    return null;
  }
  const indexInfo = firstOrUndefined(checker.getIndexInfosOfType(type));
  if (!indexInfo) {
    return null;
  }
  const keyType =
    indexInfo.keyType.flags & ts.TypeFlags.NumberLike ? "number" : "string";
  const valueType = toClosureType(
    indexInfo.type,
    checker,
    context,
    new Set(seen),
  );
  return `!${referenceBuiltin("Object", context)}<${keyType}, ${valueType}>`;
}

function collapseLargeUnion(
  type: ts.UnionType,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const nonNullable = type.types.filter(
    (item) =>
      !(item.flags & ts.TypeFlags.Null) &&
      !(item.flags & ts.TypeFlags.Undefined),
  );
  const suffix = type.types
    .filter((item) => item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
    .map((item) => (item.flags & ts.TypeFlags.Null ? "null" : "undefined"));
  if (nonNullable.every((item) => item.flags & ts.TypeFlags.StringLike)) {
    return unionWithSuffix("string", suffix);
  }
  if (nonNullable.every((item) => item.flags & ts.TypeFlags.NumberLike)) {
    return unionWithSuffix("number", suffix);
  }
  if (nonNullable.every((item) => item.flags & ts.TypeFlags.BooleanLike)) {
    return unionWithSuffix("boolean", suffix);
  }
  if (nonNullable.every((item) => checker.isArrayType(item))) {
    return unionWithSuffix(`!${referenceBuiltin("Array", context)}<?>`, suffix);
  }
  if (nonNullable.every((item) => item.getProperties().length > 0)) {
    return unionWithSuffix(`!${referenceBuiltin("Object", context)}`, suffix);
  }
  recordUnresolvedType(context, "unsupported-type-atom", type, checker);
  return unionWithSuffix("?", suffix);
}
