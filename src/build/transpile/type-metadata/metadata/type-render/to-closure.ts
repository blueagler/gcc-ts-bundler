import ts from "@typescript/typescript6";
import { firstOrUndefined } from "../../../../../shared/arrays";
import {
  commonPrimitiveClosureType,
  sanitizeClosureName,
  unionWithSuffix,
  stripUndefinedFromClosureType,
  isClosureQualifiedName,
  unionClosureTypes,
  renderPrototypeProperty,
} from "../../../../../shared/closure-type-strings";
import { uniqueSortedStrings } from "../../../../../shared/files";
import type { ClosureDocRenderContext } from "./context";
import {
  getTypeArguments,
  isReadonlyArrayType,
  recordTypeDiagnostic,
  referenceBuiltin,
  safeTypeToString,
  canonicalDeclaration,
  canonicalSymbolId,
  getDeclarationName,
  getReferenceNodeSymbol,
  isDeclarationFileSymbol,
  isTypescriptDefaultLibPath,
  isUnboundAmbientNominal,
  referenceInGraphDeclaredType,
  referenceRuntimeSymbol,
  referenceSymbolId,
  referencesForTemplate,
  registerDeclaredTypeSymbol,
  safeGetAliasedSymbol,
  safeSymbolToString,
} from "./context";
import { renderAnonymousRecordType, renderEnumLiteralType } from "./object";
import { getPropertyNameText } from "../../../../../shared/typescript";

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
    recordTypeDiagnostic(
      context,
      "symbol-rendering-failed",
      type.aliasSymbol ?? type.getSymbol(),
    );
    return "?";
  }
}

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
  const exhausted = renderExhaustedRecursion(type, context, seen);
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
    recordTypeDiagnostic(
      context,
      "unsupported-type-atom",
      type.aliasSymbol ?? type.getSymbol(),
    );
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

  recordTypeDiagnostic(
    context,
    "unsupported-type-atom",
    type.aliasSymbol ?? type.getSymbol(),
  );
  return "?";
}

/**
 * The two recursion limits, depth before self-reference: a chain longer than
 * the budget and a cycle back through this exact atom both degrade to `?`,
 * recorded under distinct diagnostics.
 */
function renderExhaustedRecursion(
  type: ts.Type,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
): string | undefined {
  if (seen.size > MAX_TYPE_DEPTH) {
    recordTypeDiagnostic(
      context,
      "type-reference-depth-exceeded",
      type.aliasSymbol ?? type.getSymbol(),
    );
    return "?";
  }
  if (seen.has(type)) {
    recordTypeDiagnostic(
      context,
      "unsupported-type-atom",
      type.aliasSymbol ?? type.getSymbol(),
    );
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
    recordTypeDiagnostic(
      context,
      "unsupported-type-atom",
      type.aliasSymbol ?? type.getSymbol(),
    );
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
  recordTypeDiagnostic(
    context,
    "unsupported-type-atom",
    type.aliasSymbol ?? type.getSymbol(),
  );
  return unionWithSuffix("?", suffix);
}

export type FunctionLikeDeclaration =
  | ts.ArrowFunction
  | ts.CallSignatureDeclaration
  | ts.ConstructorDeclaration
  | ts.ConstructorTypeNode
  | ts.ConstructSignatureDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.FunctionTypeNode
  | ts.GetAccessorDeclaration
  | ts.JSDocFunctionType
  | ts.MethodDeclaration
  | ts.MethodSignature
  | ts.SetAccessorDeclaration;

export type SignatureParamInfo = {
  name: string;
  optional: boolean;
  rest: boolean;
  thisParam: boolean;
  type: string;
};

const FUNCTION_LIKE_GUARDS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isArrowFunction,
  ts.isCallSignatureDeclaration,
  ts.isConstructorDeclaration,
  ts.isConstructorTypeNode,
  ts.isConstructSignatureDeclaration,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isFunctionTypeNode,
  ts.isGetAccessorDeclaration,
  ts.isJSDocFunctionType,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isSetAccessorDeclaration,
];

/**
 * Construct signature -> `function(new:T, params)`.
 *
 * The `new:` target carries **no** `!`: a nullability modifier there stops
 * Closure recognising the annotation as a constructor type at all. A `*`
 * return also degrades the whole atom, because a constructor must return an
 * ObjectType.
 */
function constructSignatureToClosureType(
  signature: ts.Signature,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
) {
  const instanceType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    context,
    new Set(seen),
  );
  const target = instanceType.replace(/^[!?]/u, "");
  if (target === "*" || target === "" || instanceType === "?") {
    const returnType = signature.getReturnType();
    recordTypeDiagnostic(
      context,
      "unsupported-type-atom",
      returnType.aliasSymbol ?? returnType.getSymbol(),
    );
    return "?";
  }
  const declaration = signature.declaration;
  const params = isFunctionLikeDeclaration(declaration)
    ? collectSignatureParamInfos({ checker, context, declaration })
        .filter((parameter) => !parameter.thisParam)
        .map(
          (parameter) =>
            `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`,
        )
    : [];
  return `function(new:${target}${params.length > 0 ? `, ${params.join(", ")}` : ""})`;
}

export function signatureToClosureFunctionType(
  signature: ts.Signature,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen = new Set<ts.Type>(),
) {
  const declaration = signature.declaration;
  if (!isFunctionLikeDeclaration(declaration)) {
    return `!${referenceBuiltin("Function", context)}`;
  }
  // Closure has no generic *function types* — only generic declarations carry
  // `@template`. A bare `T` inside a function-type annotation resolves to
  // nothing, so a signature that introduces its own type parameters renders
  // them as `?` rather than leaking an unbound name.
  const ownTypeParameters = new Set(
    (signature.getTypeParameters() ?? []).map((parameter) => {
      const rendered = safeTypeToString(parameter, checker, context);
      return rendered ? sanitizeClosureName(rendered) : "?";
    }),
  );
  const paramInfos = collectSignatureParamInfos({
    checker,
    context,
    declaration,
  });
  // A `this` parameter lives in the declaration's parameter list but never in
  // the signature's parameter list, so it has to be recognised here and moved
  // into Closure's dedicated leading `this:` slot. Dropping it (what we used
  // to do) silently changed the arity contract of every `this`-typed callback.
  const thisParam = paramInfos.find((parameter) => parameter.thisParam);
  const params = paramInfos
    .filter((parameter) => !parameter.thisParam)
    .map(
      (parameter) =>
        `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`,
    );
  if (thisParam && thisParam.type !== "?") {
    params.unshift(`this:${thisParam.type}`);
  }
  const returnType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    context,
    new Set(seen),
    "type" in declaration ? declaration.type : undefined,
  );
  const erase = (rendered: string) =>
    ownTypeParameters.size === 0
      ? rendered
      : eraseTypeParameterNames(rendered, ownTypeParameters);
  return `function(${params.map(erase).join(", ")}): ${erase(returnType)}`;
}

/** Replaces whole-word occurrences of unbound type-parameter names with `?`. */
function eraseTypeParameterNames(rendered: string, names: ReadonlySet<string>) {
  return rendered.replace(/[A-Za-z_$][\w$]*/gu, (token) =>
    names.has(token) ? "?" : token,
  );
}

export function collectSignatureParamInfos({
  checker,
  context,
  declaration,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  declaration: FunctionLikeDeclaration;
}) {
  const parameters = getDeclarationParameters(declaration);
  return parameters.map((parameter, index): SignatureParamInfo => {
    const thisParam = isThisParameter(parameter);
    const rest = !!parameter.dotDotDotToken;
    const optional = !!parameter.questionToken || !!parameter.initializer;
    const name = parameterNameForJsDoc(parameter, index);
    const type = renderParameterType(parameter, checker, context, rest);
    return {
      name,
      optional,
      rest,
      thisParam,
      type,
    };
  });
}

function renderParameterType(
  parameter: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  rest: boolean,
) {
  const type = checker.getTypeAtLocation(parameter);
  if (!rest) {
    return toClosureType(type, checker, context, new Set(), parameter.type);
  }
  const elementType = getArrayElementType(type, checker);
  return elementType ? toClosureType(elementType, checker, context) : "?";
}

function getArrayElementType(type: ts.Type, checker: ts.TypeChecker) {
  if (!checker.isArrayType(type) && !isReadonlyArrayType(type)) {
    return null;
  }
  return firstOrUndefined(getTypeArguments(type, checker)) ?? null;
}

function isThisParameter(parameter: ts.ParameterDeclaration) {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

function getDeclarationParameters(declaration: FunctionLikeDeclaration) {
  return "parameters" in declaration ? declaration.parameters : [];
}

function parameterNameForJsDoc(
  declaration: ts.ParameterDeclaration | undefined,
  index: number,
) {
  if (declaration && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return `__param${index}`;
}

function isFunctionLikeDeclaration(
  declaration: ts.Node | undefined,
): declaration is FunctionLikeDeclaration {
  return (
    declaration !== undefined &&
    FUNCTION_LIKE_GUARDS.some((isFunctionLike) => isFunctionLike(declaration))
  );
}

export function getTypedDeclarationClosureType(
  declaration:
    ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature,
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

const MAX_SYNTHESIZED_DTS_DECLARATIONS = 48;
const MAX_SYNTHESIZED_DTS_MEMBERS = 24;

const BUILTIN_TYPE_NAMES = new Set([
  "AbortController",
  "AbortSignal",
  "Array",
  "ArrayBuffer",
  "AsyncIterable",
  "AsyncIterator",
  "BigInt64Array",
  "BigUint64Array",
  "Blob",
  "DataView",
  "Date",
  "Error",
  "Float32Array",
  "Float64Array",
  "FormData",
  "Function",
  "Headers",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Iterable",
  "Iterator",
  "Map",
  "Object",
  "Promise",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "ReadableStream",
  "ReadableStreamDefaultController",
  "ReadableStreamDefaultReader",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "TextDecoder",
  "TextEncoder",
  "TransformStream",
  "URL",
  "URLSearchParams",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "WritableStream",
  "WritableStreamDefaultController",
  "WritableStreamDefaultWriter",
]);

const BUILTIN_GENERIC_TYPE_NAMES = new Map([
  ["AsyncIterable", "AsyncIterable"],
  ["AsyncIterator", "AsyncIterator"],
  ["Iterable", "Iterable"],
  ["Iterator", "Iterator"],
  ["Map", "Map"],
  ["Promise", "Promise"],
  ["ReadonlyMap", "Map"],
  ["ReadonlySet", "Set"],
  ["Set", "Set"],
  ["WeakMap", "WeakMap"],
  ["WeakSet", "WeakSet"],
]);

type NamedTypeTarget = {
  symbol: ts.Symbol;
  resolvedSymbol: ts.Symbol;
  symbolName: string;
};

/** Checker walk state that always travels with a named-type render. */
type NamedTypeRenderArgs = {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  seen: Set<ts.Type>;
  referenceNode?: ts.Node | undefined;
};

function renderNamedType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) {
  const args: NamedTypeRenderArgs = { checker, context, seen, referenceNode };
  const target = resolveNamedTypeTarget(type, args);
  if (target === "?" || target === null) {
    return target;
  }
  const builtinType = renderBuiltinNamedType(target.symbolName, type, args);
  if (builtinType) {
    return builtinType;
  }
  const aliasedType = renderAliasedNamedType(type, target.symbolName, args);
  if (aliasedType) {
    return aliasedType;
  }
  const synthesizedDtsType = synthesizeReferencedDtsType(
    target.resolvedSymbol,
    type,
    args,
  );
  if (synthesizedDtsType) {
    return synthesizedDtsType;
  }
  return renderReferencedNamedType(type, target, args);
}

/**
 * Joins a rendered target with its type arguments, dropping the arguments when
 * the target degraded.
 *
 * `?<A, B>` is a **syntax error** in Closure's type grammar, not a weaker type:
 * a single degraded target used to poison the whole annotation, and the parse
 * failure is reported far from the cause. A degraded target takes its arguments
 * with it.
 */
export function applyTypeArguments(
  target: string,
  renderedArgs: readonly string[],
) {
  if (renderedArgs.length === 0) {
    return target;
  }
  const bare = target.replace(/^[!?]/u, "");
  if (bare === "?" || bare === "*" || target === "?" || target === "*") {
    return "?";
  }
  // A degraded argument is fine — `!Foo<?>` is legal — but a degraded *target*
  // is not.
  return `${target}<${renderedArgs.join(", ")}>`;
}

function resolveNamedTypeTarget(
  type: ts.Type,
  args: NamedTypeRenderArgs,
): NamedTypeTarget | "?" | null {
  // A mapped type's alias symbol names a *type*, never a runtime value, so
  // referencing it would mint a dangling identifier. tsickle warns and drops
  // to `?` here; so do we, at the smallest node.
  if (isMappedObjectType(type)) {
    recordTypeDiagnostic(
      args.context,
      "unsupported-type-atom",
      type.aliasSymbol ?? type.getSymbol(),
    );
    return "?";
  }
  const symbols = resolveNamedTypeSymbols(type, args);
  if (symbols === "?" || symbols === null) {
    return symbols;
  }
  return qualifyNamedTypeName(symbols, args);
}

function resolveNamedTypeSymbols(
  type: ts.Type,
  args: NamedTypeRenderArgs,
): { symbol: ts.Symbol; resolvedSymbol: ts.Symbol } | "?" | null {
  const locationSymbol = getReferenceNodeSymbol(
    args.referenceNode,
    args.checker,
    args.context,
  );
  if (locationSymbol === null) {
    return "?";
  }
  const symbol = locationSymbol ?? type.aliasSymbol ?? type.getSymbol();
  if (!symbol) {
    return null;
  }
  const resolvedSymbol =
    symbol.flags & ts.SymbolFlags.Alias
      ? safeGetAliasedSymbol(symbol, args.checker, args.context)
      : symbol;
  if (!resolvedSymbol) {
    return "?";
  }
  if (!type.aliasSymbol && !isTypeLikeSymbol(resolvedSymbol)) {
    return null;
  }
  return { symbol, resolvedSymbol };
}

function qualifyNamedTypeName(
  symbols: { symbol: ts.Symbol; resolvedSymbol: ts.Symbol },
  args: NamedTypeRenderArgs,
): NamedTypeTarget | "?" | null {
  const symbolName = safeSymbolToString(
    symbols.resolvedSymbol,
    args.checker,
    args.context,
  );
  if (!symbolName) {
    return "?";
  }
  if (symbolName === "__type" || !isClosureQualifiedName(symbolName)) {
    return null;
  }
  if (["Array", "ReadonlyArray"].includes(symbolName)) {
    return null;
  }
  return { ...symbols, symbolName };
}

function renderAliasedNamedType(
  type: ts.Type,
  symbolName: string,
  args: NamedTypeRenderArgs,
) {
  const { checker, context, seen, referenceNode } = args;
  const declaredSymbolId = context.symbolIdByDeclaredName.get(symbolName);
  if (declaredSymbolId) {
    return `!${referenceSymbolId(declaredSymbolId, context)}`;
  }
  const [recordKeyType, recordValueType] = type.aliasTypeArguments ?? [];
  if (
    symbolName === "Record" &&
    recordKeyType !== undefined &&
    recordValueType !== undefined
  ) {
    return `!${referenceBuiltin("Object", context)}<${toClosureType(
      recordKeyType,
      checker,
      context,
      new Set(seen),
      referenceNode && ts.isTypeReferenceNode(referenceNode)
        ? referenceNode.typeArguments?.[0]
        : undefined,
    )}, ${toClosureType(
      recordValueType,
      checker,
      context,
      new Set(seen),
      referenceNode && ts.isTypeReferenceNode(referenceNode)
        ? referenceNode.typeArguments?.[1]
        : undefined,
    )}>`;
  }
  return undefined;
}

function renderReferencedNamedType(
  type: ts.Type,
  target: NamedTypeTarget,
  args: NamedTypeRenderArgs,
) {
  const { symbol, resolvedSymbol, symbolName } = target;
  const { context } = args;
  if (isDeclarationFileSymbol(resolvedSymbol)) {
    return null;
  }
  if (isGlobalObjectType(type)) {
    return `!${referenceBuiltin("Object", context)}`;
  }
  if (isUnboundAmbientNominal(resolvedSymbol)) {
    recordTypeDiagnostic(
      context,
      "ambient-nominal-without-binding",
      resolvedSymbol,
    );
    return "?";
  }
  const renderedArgs = renderTypeArgumentList(type, args);
  const inGraph = referenceInGraphDeclaredType(
    symbol,
    resolvedSymbol,
    symbolName,
    context,
  );
  const reference =
    inGraph ??
    referenceRuntimeSymbol(symbol, resolvedSymbol, symbolName, context);
  return applyTypeArguments(`!${reference}`, renderedArgs);
}

function renderTypeArgumentList(type: ts.Type, args: NamedTypeRenderArgs) {
  const { checker, context, seen, referenceNode } = args;
  return getTypeArguments(type, checker).map((arg, index) =>
    toClosureType(
      arg,
      checker,
      context,
      new Set(seen),
      referenceNode && ts.isTypeReferenceNode(referenceNode)
        ? referenceNode.typeArguments?.[index]
        : undefined,
    ),
  );
}

function renderBuiltinNamedType(
  symbolName: string,
  type: ts.Type,
  args: NamedTypeRenderArgs,
) {
  const closureName = BUILTIN_GENERIC_TYPE_NAMES.get(symbolName);
  if (closureName) {
    const renderedArgs = renderTypeArgumentList(type, args);
    const reference = referenceBuiltin(closureName, args.context);
    return applyTypeArguments(`!${reference}`, renderedArgs);
  }
  if (!BUILTIN_TYPE_NAMES.has(symbolName)) {
    return null;
  }
  return `!${referenceBuiltin(symbolName, args.context)}`;
}

function isTypeLikeSymbol(symbol: ts.Symbol) {
  return Boolean(
    symbol.flags &
    (ts.SymbolFlags.Class |
      ts.SymbolFlags.Enum |
      ts.SymbolFlags.Interface |
      ts.SymbolFlags.TypeAlias |
      ts.SymbolFlags.TypeParameter),
  );
}

function synthesizeReferencedDtsType(
  resolvedSymbol: ts.Symbol,
  type: ts.Type,
  args: NamedTypeRenderArgs,
): string | null {
  const { checker, context, seen } = args;
  if (!isDeclarationFileSymbol(resolvedSymbol)) {
    return null;
  }
  const declaration = canonicalDeclaration(resolvedSymbol, context);
  if (!declaration) {
    return null;
  }
  if (isTypescriptDefaultLibPath(declaration.getSourceFile().fileName)) {
    return null;
  }
  const isInterface = ts.isInterfaceDeclaration(declaration);
  const isAlias = ts.isTypeAliasDeclaration(declaration);
  const isClass = ts.isClassDeclaration(declaration);
  const isEnum = ts.isEnumDeclaration(declaration);
  if (!isInterface && !isAlias && !isClass && !isEnum) {
    return null;
  }
  const existing = context.symbolsById.get(
    canonicalSymbolId(resolvedSymbol, context),
  );
  if (existing?.kind === "declared") {
    return `!${referenceSymbolId(existing.id, context)}`;
  }
  if (context.typeDeclarations.length >= MAX_SYNTHESIZED_DTS_DECLARATIONS) {
    return null;
  }
  const rawName =
    getDeclarationName(declaration) ??
    sanitizeClosureName(resolvedSymbol.getName()) ??
    "DtsType";
  const simpleName = rawName.includes(".")
    ? (rawName.split(".").at(-1) ?? rawName)
    : rawName;
  if (!isClosureQualifiedName(simpleName)) {
    return null;
  }
  const name = uniqueDeclaredName(simpleName, context);
  const declaredSymbolId = registerDeclaredTypeSymbol(
    resolvedSymbol,
    declaration,
    name,
    context,
  );
  const lines: string[] = [];
  if (isAlias) {
    const body = toClosureType(type, checker, context, new Set(seen));
    lines.push("/**", ` * @typedef {${body}}`, " */", `let ${name};`);
  } else if (isEnum) {
    lines.push("/**", " * @enum {number}", " */", `const ${name} = {};`);
  } else if (isClass) {
    lines.push("/**", " * @constructor", " * @struct");
    appendSynthesizedDtsHeritage(lines, declaration, args);
    lines.push(" */", `function ${name}() {}`);
    appendSynthesizedDtsMembers(
      lines,
      name,
      declaration.members,
      declaration.typeParameters,
      args,
    );
  } else {
    lines.push("/**", " * @record", " */", `function ${name}() {}`);
    appendSynthesizedDtsMembers(
      lines,
      name,
      declaration.members,
      declaration.typeParameters,
      args,
    );
  }
  const template = `${lines.join("\n")}\n`;
  context.typeDeclarations.push({
    declaredSymbolId,
    id: `${declaredSymbolId}:declaration`,
    references: referencesForTemplate(template, context),
    template,
  });
  return `!${referenceSymbolId(declaredSymbolId, context)}`;
}

function uniqueDeclaredName(base: string, context: ClosureDocRenderContext) {
  if (!context.symbolIdByDeclaredName.has(base)) {
    return base;
  }
  let index = 0;
  let candidate = `${base}$$type$$${index}`;
  while (context.symbolIdByDeclaredName.has(candidate)) {
    index += 1;
    candidate = `${base}$$type$$${index}`;
  }
  return candidate;
}

function appendSynthesizedDtsHeritage(
  lines: string[],
  declaration: ts.ClassDeclaration,
  args: NamedTypeRenderArgs,
) {
  const { checker, context, seen } = args;
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const typeNode of clause.types) {
      const heritage = toClosureType(
        checker.getTypeFromTypeNode(typeNode),
        checker,
        context,
        new Set(seen),
        typeNode,
      );
      if (heritage === "?" || heritage === "*") {
        continue;
      }
      lines.push(
        ` * @extends {${heritage.startsWith("!") ? heritage : `!${heritage.replace(/^[?]/u, "")}`}}`,
      );
    }
  }
}

/**
 * Near-twin of `appendInterfaceMembers` in `metadata/docs.ts`, and deliberately
 * not merged with it. This one reconstructs members for a type that was never
 * declared in the program: it accepts `ClassElement` as well as `TypeElement`,
 * caps output at `MAX_SYNTHESIZED_DTS_MEMBERS`, scrubs type-parameter names out
 * of each rendered type, and passes a copied `seen` set into signature
 * rendering to bound recursion. The authored-interface variant does none of
 * those four things. See that function's comment before attempting to unify.
 */
function appendSynthesizedDtsMembers(
  lines: string[],
  typeName: string,
  members: readonly ts.ClassElement[] | readonly ts.TypeElement[],
  typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  args: NamedTypeRenderArgs,
) {
  const typeParameterNames = (typeParameters ?? []).map(
    (parameter) => parameter.name.text,
  );
  const memberLines: string[] = [];
  for (const member of members) {
    if (memberLines.length / 2 >= MAX_SYNTHESIZED_DTS_MEMBERS) {
      break;
    }
    const pair = renderSynthesizedDtsMember(
      typeName,
      member,
      typeParameterNames,
      args,
    );
    if (!pair) {
      continue;
    }
    memberLines.push(pair[0], pair[1]);
  }
  if (memberLines.length > 0) {
    lines.push("if (false) {", ...memberLines.map((line) => `  ${line}`), "}");
  }
}

function renderSynthesizedDtsMember(
  typeName: string,
  member: ts.ClassElement | ts.TypeElement,
  typeParameterNames: readonly string[],
  args: NamedTypeRenderArgs,
): [string, string] | null {
  const memberName = getPropertyNameText(member.name);
  if (!memberName) {
    return null;
  }
  if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    return renderSynthesizedPropertyMember(
      typeName,
      memberName,
      member,
      typeParameterNames,
      args,
    );
  }
  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    return renderSynthesizedMethodMember(
      typeName,
      memberName,
      member,
      typeParameterNames,
      args,
    );
  }
  return null;
}

function renderSynthesizedPropertyMember(
  typeName: string,
  memberName: string,
  member: ts.PropertySignature | ts.PropertyDeclaration,
  typeParameterNames: readonly string[],
  args: NamedTypeRenderArgs,
): [string, string] {
  const { checker, context } = args;
  const closureType = scrubDtsTypeParameters(
    getTypedDeclarationClosureType(member, checker, context),
    typeParameterNames,
  );
  return [
    `/** @type {${closureType}} */`,
    renderPrototypeProperty(typeName, memberName),
  ];
}

function renderSynthesizedMethodMember(
  typeName: string,
  memberName: string,
  member: ts.MethodSignature | ts.MethodDeclaration,
  typeParameterNames: readonly string[],
  args: NamedTypeRenderArgs,
): [string, string] | null {
  const { checker, context, seen } = args;
  const signature = checker.getSignatureFromDeclaration(member);
  if (!signature) {
    return null;
  }
  const closureType = scrubDtsTypeParameters(
    signatureToClosureFunctionType(signature, checker, context, new Set(seen)),
    typeParameterNames,
  );
  return [
    `/** @type {${closureType}} */`,
    renderPrototypeProperty(typeName, memberName),
  ];
}

function scrubDtsTypeParameters(
  closureType: string,
  typeParameterNames: readonly string[],
) {
  let scrubbed = closureType;
  for (const name of typeParameterNames) {
    if (!isClosureQualifiedName(name)) {
      continue;
    }
    scrubbed = scrubbed.replaceAll(
      new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, "gu"),
      "?",
    );
  }
  return scrubbed;
}

function isMappedObjectType(type: ts.Type) {
  if (!(type.flags & ts.TypeFlags.Object) || !hasObjectFlags(type)) {
    return false;
  }
  return Boolean(type.objectFlags & ts.ObjectFlags.Mapped);
}

function hasObjectFlags(type: ts.Type): type is ts.ObjectType {
  return "objectFlags" in type;
}

function isGlobalObjectType(type: ts.Type) {
  const symbol = type.getSymbol();
  return symbol ? BUILTIN_TYPE_NAMES.has(symbol.getName()) : false;
}
