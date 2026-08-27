import ts from "@typescript/typescript6";

import { firstOrUndefined } from "../../../../../shared/arrays";
import {
  commonPrimitiveClosureType,
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
import { bindToClosureTypeRenderer } from "./core";
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

bindToClosureTypeRenderer(toClosureType);

/**
 * Ordered probe ladder: each family is asked in turn and the first one that
 * claims the atom wins. The order decides which annotation is emitted for a
 * type that belongs to several families at once, so it is load-bearing — a
 * probe may be rewritten, never moved.
 */
function renderClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
): string {
  const exhausted = renderExhaustedRecursion(type, checker, context, seen);
  if (exhausted !== undefined) return exhausted;
  seen.add(type);

  const unstructured = renderUnstructuredFlagType(type, context);
  if (unstructured !== undefined) return unstructured;

  // Enum member literals must render as the parent enum, never as the widened
  // primitive: `!E` keeps the nominal identity Closure needs for `@enum`
  // checking, while `number` erases it. Checked before the *Like tests, which
  // would otherwise swallow it.
  const enumName = renderEnumLiteralType(type, checker, context);
  if (enumName) return enumName;

  const primitive = renderPrimitiveFlagType(type);
  if (primitive !== undefined) return primitive;

  if (type.flags & ts.TypeFlags.Never) {
    recordUnresolvedType(context, "unsupported-type-atom", type, checker);
    return "?";
  }

  const typeParameter = renderTypeParameterName(type, checker, context);
  if (typeParameter !== undefined) return typeParameter;

  const composite = renderUnionOrIntersectionType(
    type,
    checker,
    context,
    seen,
    referenceNode,
  );
  if (composite !== undefined) return composite;

  const arrayLike = renderArrayLikeType(
    type,
    checker,
    context,
    seen,
    referenceNode,
  );
  if (arrayLike !== undefined) return arrayLike;

  const signatureType = renderSignatureType(type, checker, context, seen);
  if (signatureType !== undefined) return signatureType;

  const namedType = renderNamedType(
    type,
    checker,
    context,
    seen,
    referenceNode,
  );
  if (namedType) return namedType;

  const indexObject = renderIndexSignatureType(type, checker, context, seen);
  if (indexObject) return indexObject;

  const record = renderAnonymousRecordType(type, checker);
  if (record) return record;

  recordUnresolvedType(context, "unsupported-type-atom", type, checker);
  return "?";
}

/**
 * The two recursion limits, depth before self-reference: a chain longer than
 * the budget and a cycle back through this exact atom both degrade to `?`,
 * recorded under distinct diagnostics.
 */
function renderExhaustedRecursion(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
): string | undefined {
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
  return undefined;
}

/**
 * The atoms with no structure to walk: TS `object`, `any` and `unknown`.
 *
 * `object` (TS NonPrimitive) is checked before everything else: tsickle does
 * the same, because it carries no other type flag that would classify it.
 */
function renderUnstructuredFlagType(
  type: ts.Type,
  context: ClosureDocRenderContext,
): string | undefined {
  if (type.flags & ts.TypeFlags.NonPrimitive) {
    return `!${referenceBuiltin("Object", context)}`;
  }
  if (type.flags & ts.TypeFlags.Any) return "?";
  // `unknown` is the ALL type, not the unknown type. `?` means "Closure does
  // not know"; `*` means "every value is allowed", which is what TS `unknown`
  // states. Emitting `?` throws away a fact the checker proved.
  if (type.flags & ts.TypeFlags.Unknown) return "*";
  return undefined;
}

/** A type parameter renders as its own sanitized name, or `?` if unprintable. */
function renderTypeParameterName(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): string | undefined {
  if (!(type.flags & ts.TypeFlags.TypeParameter)) {
    return undefined;
  }
  const rendered = safeTypeToString(type, checker, context);
  return rendered ? sanitizeClosureName(rendered) : "?";
}

function renderUnionOrIntersectionType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
): string | undefined {
  if (type.isUnion()) {
    return renderUnionType(type, checker, context, seen, referenceNode);
  }
  if (type.isIntersection()) {
    // An intersection can be the same runtime object as any constituent.
    // `!Object` makes Closure treat it as a disjoint receiver type and can
    // rename shared properties apart. Unknown fails toward no split.
    return "?";
  }
  return undefined;
}

function renderArrayLikeType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
): string | undefined {
  if (checker.isArrayType(type) || isReadonlyArrayType(type)) {
    return renderArrayType(type, checker, context, seen, referenceNode);
  }
  if (checker.isTupleType(type)) {
    // `!Array<?>`, not a union of the element types. Measured at Google: the
    // union buys no optimization as long as destructuring is aliased, and it
    // makes every tuple position assignable to every other, which reports
    // wrong types at the sites that do read them positionally.
    return `!${referenceBuiltin("Array", context)}<?>`;
  }
  return undefined;
}

/**
 * Maps TS primitive *Like flags onto Closure's primitive vocabulary.
 *
 * Order is load-bearing: `BigIntLike` and `ESSymbolLike` precede the shared
 * `commonPrimitiveClosureType` tail so overlapping flag bits cannot collapse a
 * bigint or unique-symbol atom into a string or number. `Never` is not a
 * primitive here — it records an unresolved atom at the call site.
 */
function renderPrimitiveFlagType(type: ts.Type): string | undefined {
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  if (type.flags & (ts.TypeFlags.ESSymbolLike | ts.TypeFlags.UniqueESSymbol)) {
    // Closure has no notion of symbol uniqueness; `symbol` is the whole
    // vocabulary.
    return "symbol";
  }
  return commonPrimitiveClosureType(type);
}

function renderUnionType(
  type: ts.UnionType,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) {
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

function renderArrayType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) {
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
      : toClosureType(elementType, checker, context, new Set(seen), elementNode)
  }>`;
}

function renderSignatureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
): string | undefined {
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
  return undefined;
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
