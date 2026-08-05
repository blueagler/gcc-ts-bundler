import crypto from "crypto";
import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import { firstOrUndefined } from "../../../../shared/arrays";
import { uniqueSortedStrings } from "../../../../shared/files";
import type {
  ClosureTypeDeclaration,
  ClosureTypeReference,
  ClosureTypeSymbol,
  TypeMetadataDiagnostic,
} from "../types";
import {
  isClosureQualifiedName,
  sanitizeClosureName,
  stripUndefinedFromClosureType,
  unionClosureTypes,
  unionWithSuffix,
} from "./closure-type-strings";

export interface ClosureDocRenderContext {
  diagnostics: TypeMetadataDiagnostic[];
  nextReferenceId: number;
  referencesByToken: Map<string, ClosureTypeReference>;
  sourceFilePath: string;
  sourceFileStem: string;
  symbolIdByDeclaredName: Map<string, string>;
  symbolsById: Map<string, ClosureTypeSymbol>;
  typeDeclarations: ClosureTypeDeclaration[];
  unresolvedTypeReferenceCount: number;
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

const MAX_TYPE_DEPTH = 28;
const MAX_SYMBOL_CHAIN_DEPTH = 64;

const MAX_UNION_MEMBERS = 16;

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

export function createClosureDocRenderContext(
  sourceFile: ts.SourceFile,
): ClosureDocRenderContext {
  return {
    diagnostics: [],
    nextReferenceId: 0,
    referencesByToken: new Map(),
    sourceFilePath: sourceFile.fileName,
    sourceFileStem: sanitizeClosureName(
      path.basename(sourceFile.fileName).replace(/\.[cm]?[jt]sx?$/u, ""),
    ),
    symbolIdByDeclaredName: new Map(),
    symbolsById: new Map(),
    typeDeclarations: [],
    unresolvedTypeReferenceCount: 0,
  };
}

export function referencesForTemplate(
  template: string,
  context: ClosureDocRenderContext,
): ClosureTypeReference[] {
  return [...context.referencesByToken.entries()]
    .filter(([token]) => template.includes(token))
    .map(([, reference]) => reference);
}

export function registerDeclaredTypeSymbol(
  symbol: ts.Symbol | undefined,
  declaration: ts.Declaration,
  name: string,
  context: ClosureDocRenderContext,
) {
  const id = symbol
    ? canonicalSymbolId(symbol)
    : hashIdentity(
        `${normalizeDeclarationPath(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${name}:declared`,
      );
  context.symbolIdByDeclaredName.set(name, id);
  context.symbolsById.set(id, {
    declarationFilePath: declaration.getSourceFile().fileName,
    declarationId: `${id}:declaration`,
    declarationStart: declaration.getStart(),
    diagnosticName: name,
    id,
    kind: "declared",
  });
  return id;
}

export function canonicalSymbolId(symbol: ts.Symbol) {
  const declaration = canonicalDeclaration(symbol);
  if (!declaration) {
    return hashIdentity(`symbol:${symbol.getName()}:${symbol.flags}`);
  }
  return hashIdentity(
    `${normalizeDeclarationPath(declaration.getSourceFile().fileName)}:${declaration.getStart()}:${symbol.flags}`,
  );
}

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
    // Intersections have no faithful Closure spelling; `!Object` keeps the
    // atom nominal without inventing a structural shape.
    return `!${referenceBuiltin("Object", context)}`;
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
function renderEnumLiteralType(
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
function renderAnonymousRecordType(type: ts.Type, checker: ts.TypeChecker) {
  return isEmptyAnonymousType(type, checker) ? "*" : null;
}

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
    recordUnresolvedType(
      context,
      "unsupported-type-atom",
      signature.getReturnType(),
      checker,
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

function renderNamedType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) {
  // A mapped type's alias symbol names a *type*, never a runtime value, so
  // referencing it would mint a dangling identifier. tsickle warns and drops
  // to `?` here; so do we, at the smallest node.
  if (isMappedObjectType(type)) {
    recordUnresolvedType(context, "unsupported-type-atom", type, checker);
    return "?";
  }
  const locationSymbol = getReferenceNodeSymbol(
    referenceNode,
    checker,
    context,
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
      ? safeGetAliasedSymbol(symbol, checker, context)
      : symbol;
  if (!resolvedSymbol) {
    return "?";
  }
  if (!type.aliasSymbol && !isTypeLikeSymbol(resolvedSymbol)) {
    return null;
  }
  const symbolName = safeSymbolToString(resolvedSymbol, checker, context);
  if (!symbolName) {
    return "?";
  }
  if (symbolName === "__type" || !isClosureQualifiedName(symbolName)) {
    return null;
  }
  if (["Array", "ReadonlyArray"].includes(symbolName)) {
    return null;
  }
  const builtinType = renderBuiltinNamedType(
    symbolName,
    type,
    checker,
    context,
    seen,
    referenceNode,
  );
  if (builtinType) {
    return builtinType;
  }
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
  if (
    isDeclarationFileSymbol(resolvedSymbol) &&
    !(resolvedSymbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) &&
    type.getProperties().length > 0
  ) {
    // Structural shapes declared in `.d.ts` files are not representable as a
    // named Closure type here; the caller degrades the atom to `?`.
    return null;
  }
  if (isGlobalObjectType(type)) {
    return `!${referenceBuiltin("Object", context)}`;
  }
  if (isUnboundAmbientNominal(resolvedSymbol)) {
    recordUnresolvedType(
      context,
      "ambient-nominal-without-binding",
      type,
      checker,
      resolvedSymbol,
    );
    return "?";
  }
  const args = getTypeArguments(type, checker);
  const renderedArgs = args.map((arg, index) =>
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
  const reference = referenceRuntimeSymbol(
    symbol,
    resolvedSymbol,
    symbolName,
    context,
  );
  return applyTypeArguments(`!${reference}`, renderedArgs);
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
export function applyTypeArgumentsForTest(
  target: string,
  renderedArgs: readonly string[],
) {
  return applyTypeArguments(target, renderedArgs);
}

function applyTypeArguments(target: string, renderedArgs: readonly string[]) {
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

function renderBuiltinNamedType(
  symbolName: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
  referenceNode?: ts.Node | undefined,
) {
  const closureName = BUILTIN_GENERIC_TYPE_NAMES.get(symbolName);
  if (closureName) {
    const args = getTypeArguments(type, checker);
    const renderedArgs = args.map((arg, index) =>
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
    const reference = referenceBuiltin(closureName, context);
    return applyTypeArguments(`!${reference}`, renderedArgs);
  }
  if (!BUILTIN_TYPE_NAMES.has(symbolName)) {
    return null;
  }
  return `!${referenceBuiltin(symbolName, context)}`;
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

function isDeclarationFileSymbol(symbol: ts.Symbol) {
  return (symbol.declarations ?? []).some(
    (declaration) => declaration.getSourceFile().isDeclarationFile,
  );
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

function isMappedObjectType(type: ts.Type) {
  if (!(type.flags & ts.TypeFlags.Object) || !hasObjectFlags(type)) {
    return false;
  }
  return Boolean(type.objectFlags & ts.ObjectFlags.Mapped);
}

function isReadonlyArrayType(type: ts.Type) {
  const symbol = type.getSymbol();
  return symbol?.getName() === "ReadonlyArray";
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker) {
  return isTypeReference(type) ? checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

function hasObjectFlags(type: ts.Type): type is ts.ObjectType {
  return "objectFlags" in type;
}

function symbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
  return hasSymbolParent(symbol) ? symbol.parent : undefined;
}

function hasSymbolParent(
  symbol: ts.Symbol,
): symbol is ts.Symbol & { parent: ts.Symbol } {
  return "parent" in symbol && symbol.parent !== undefined;
}

function isFunctionLikeDeclaration(
  declaration: ts.Node | undefined,
): declaration is FunctionLikeDeclaration {
  return (
    declaration !== undefined &&
    FUNCTION_LIKE_GUARDS.some((isFunctionLike) => isFunctionLike(declaration))
  );
}

function isGlobalObjectType(type: ts.Type) {
  const symbol = type.getSymbol();
  return symbol ? BUILTIN_TYPE_NAMES.has(symbol.getName()) : false;
}

function getReferenceNodeSymbol(
  node: ts.Node | undefined,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): ts.Symbol | null | undefined {
  const location =
    node && ts.isTypeReferenceNode(node)
      ? node.typeName
      : node && ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : undefined;
  if (!location) {
    return undefined;
  }
  try {
    return checker.getSymbolAtLocation(location);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordSymbolRenderingFailure(context, undefined);
    return null;
  }
}

function referenceBuiltin(name: string, context: ClosureDocRenderContext) {
  const id = hashIdentity(`builtin:${name}`);
  if (!context.symbolsById.has(id)) {
    context.symbolsById.set(id, {
      builtinName: name,
      diagnosticName: name,
      id,
      kind: "builtin",
    });
  }
  return referenceSymbolId(id, context);
}

function referenceRuntimeSymbol(
  sourceSymbol: ts.Symbol,
  resolvedSymbol: ts.Symbol,
  diagnosticName: string,
  context: ClosureDocRenderContext,
) {
  const aliasDeclaration =
    sourceSymbol.flags & ts.SymbolFlags.Alias
      ? canonicalDeclaration(sourceSymbol)
      : undefined;
  const localName = getDeclarationName(aliasDeclaration) ?? diagnosticName;
  const identitySymbol = aliasDeclaration ? sourceSymbol : resolvedSymbol;
  const id = canonicalSymbolId(identitySymbol);
  if (!context.symbolsById.has(id)) {
    const declaration = canonicalDeclaration(resolvedSymbol);
    context.symbolsById.set(id, {
      declarationFilePath: declaration?.getSourceFile().fileName,
      declarationStart: declaration?.getStart(),
      diagnosticName,
      id,
      kind: "runtime",
      localName,
    });
  }
  return referenceSymbolId(id, context);
}

function getDeclarationName(declaration: ts.Declaration | undefined) {
  if (
    declaration &&
    (ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration))
  ) {
    return declaration.name?.text;
  }
  return undefined;
}

function referenceSymbolId(id: string, context: ClosureDocRenderContext) {
  const token = `__GCC_TYPE_${context.nextReferenceId}__`;
  context.nextReferenceId += 1;
  context.referencesByToken.set(token, { symbolId: id, token });
  return token;
}

function recordUnresolvedType(
  context: ClosureDocRenderContext,
  reason: TypeMetadataDiagnostic["reason"],
  type: ts.Type,
  _checker: ts.TypeChecker,
  symbol = type.aliasSymbol ?? type.getSymbol(),
) {
  context.unresolvedTypeReferenceCount += 1;
  const declaration = symbol ? canonicalDeclaration(symbol) : undefined;
  context.diagnostics.push({
    declarationFilePath: declaration?.getSourceFile().fileName,
    phase: "analysis",
    reason,
    sourceFilePath: context.sourceFilePath,
    symbolId: symbol ? canonicalSymbolId(symbol) : undefined,
    // Diagnostics must never recurse back into the checker renderer after the
    // rendering path already degraded. `getName()` is bounded and sufficient
    // to identify the offending symbol; anonymous types omit the name.
    symbolName: symbol?.getName(),
  });
}

function safeGetAliasedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  try {
    return checker.getAliasedSymbol(symbol);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordSymbolRenderingFailure(context, symbol);
    return null;
  }
}

function safeSymbolToString(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  if (!hasBoundedSymbolParentChain(symbol)) {
    recordSymbolRenderingFailure(context, symbol);
    return null;
  }
  try {
    return checker.symbolToString(symbol);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordSymbolRenderingFailure(context, symbol);
    return null;
  }
}

function safeTypeToString(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  try {
    return checker.typeToString(type);
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordSymbolRenderingFailure(context, type.aliasSymbol ?? type.getSymbol());
    return null;
  }
}

function hasBoundedSymbolParentChain(symbol: ts.Symbol) {
  const seen = new Set<ts.Symbol>();
  let current: ts.Symbol | undefined = symbol;
  for (let depth = 0; current; depth += 1) {
    if (depth >= MAX_SYMBOL_CHAIN_DEPTH || seen.has(current)) {
      return false;
    }
    seen.add(current);
    current = symbolParent(current);
  }
  return true;
}

function recordSymbolRenderingFailure(
  context: ClosureDocRenderContext,
  symbol: ts.Symbol | undefined,
) {
  context.unresolvedTypeReferenceCount += 1;
  const declaration = symbol ? canonicalDeclaration(symbol) : undefined;
  context.diagnostics.push({
    declarationFilePath: declaration?.getSourceFile().fileName,
    phase: "analysis",
    reason: "symbol-rendering-failed",
    sourceFilePath: context.sourceFilePath,
    symbolId: symbol ? canonicalSymbolId(symbol) : undefined,
    symbolName: symbol?.getName(),
  });
}

function isUnboundAmbientNominal(symbol: ts.Symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Class)) {
    return false;
  }
  const declarations = symbol.declarations ?? [];
  return (
    declarations.length === 0 ||
    declarations.every(
      (declaration) =>
        declaration.getSourceFile().isDeclarationFile ||
        Boolean(
          ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient,
        ),
    )
  );
}

function canonicalDeclaration(symbol: ts.Symbol) {
  return [...(symbol.declarations ?? [])].sort((left, right) => {
    const pathOrder = normalizeDeclarationPath(
      left.getSourceFile().fileName,
    ).localeCompare(normalizeDeclarationPath(right.getSourceFile().fileName));
    return pathOrder || left.getStart() - right.getStart();
  })[0];
}

function normalizeDeclarationPath(filePath: string) {
  let normalized = path.resolve(filePath);
  try {
    normalized = fs.realpathSync.native(normalized);
  } catch {
    // The checker can retain deleted virtual files; the normalized absolute path is stable.
  }
  return normalized.replaceAll(path.sep, "/");
}

function hashIdentity(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
