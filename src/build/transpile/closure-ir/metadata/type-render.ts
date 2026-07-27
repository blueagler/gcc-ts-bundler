import path from "path";
import ts from "typescript";

import { firstOrUndefined } from "../../../../shared/arrays";
import { uniqueSortedStrings } from "../../../../shared/files";
import type { ClosureIrTypeDeclaration } from "../types";
import {
  isClosureQualifiedName,
  renderPrototypeProperty,
  sanitizeClosureName,
  stripUndefinedFromClosureType,
  unionClosureTypes,
  unionWithSuffix,
} from "./closure-type-strings";

export interface ClosureDocRenderContext {
  nextTypeId: number;
  recordNamesByKey: Map<string, string>;
  sourceFileStem: string;
  typeDeclarations: ClosureIrTypeDeclaration[];
  typeIds: WeakMap<ts.Type, number>;
  usedRecordNames: Set<string>;
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

const MAX_RECORDS_PER_FILE = 160;

const MAX_RECORD_PROPERTIES = 48;

const MAX_TYPE_DEPTH = 28;

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
    nextTypeId: 0,
    recordNamesByKey: new Map(),
    sourceFileStem: sanitizeClosureName(
      path.basename(sourceFile.fileName).replace(/\.[cm]?[jt]sx?$/u, ""),
    ),
    typeDeclarations: [],
    typeIds: new WeakMap(),
    usedRecordNames: new Set(),
  };
}

export function toClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen = new Set<ts.Type>(),
): string {
  if (seen.size > MAX_TYPE_DEPTH) {
    return "?";
  }
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);

  if (type.flags & ts.TypeFlags.Any) return "?";
  if (type.flags & ts.TypeFlags.Unknown) return "?";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Never) return "?";
  if (type.flags & ts.TypeFlags.TypeParameter) {
    return sanitizeClosureName(checker.typeToString(type));
  }

  if (type.isUnion()) {
    if (type.types.length > MAX_UNION_MEMBERS) {
      return collapseLargeUnion(type, checker);
    }
    const rendered = uniqueSortedStrings(
      type.types.map((item) => toClosureType(item, checker, context, seen)),
    );
    const onlyType = firstOrUndefined(rendered);
    return rendered.length === 1 && onlyType !== undefined
      ? onlyType
      : `(${rendered.join("|")})`;
  }

  if (type.isIntersection()) {
    const recordName = buildRecordForObjectType({
      checker,
      context,
      type,
    });
    return recordName ? `!${recordName}` : "!Object";
  }

  if (checker.isArrayType(type) || isReadonlyArrayType(type, checker)) {
    const elementType = firstOrUndefined(getTypeArguments(type, checker));
    return `!Array<${
      elementType === undefined
        ? "?"
        : toClosureType(elementType, checker, context, seen)
    }>`;
  }

  if (checker.isTupleType(type)) {
    const typeArguments = getTypeArguments(type, checker);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${uniqueSortedStrings(
      typeArguments.map((item) => toClosureType(item, checker, context, seen)),
    ).join("|")}>`;
  }

  const callSignature = firstOrUndefined(type.getCallSignatures());
  if (callSignature && type.getProperties().length === 0) {
    return signatureToClosureFunctionType(
      callSignature,
      checker,
      context,
      seen,
    );
  }

  const namedType = renderNamedType(type, checker, context, seen);
  if (namedType) {
    return namedType;
  }

  const recordName = buildRecordForObjectType({ checker, context, type });
  if (recordName) {
    return `!${recordName}`;
  }

  return "?";
}

export function buildRecordForObjectType({
  checker,
  context,
  preferredName,
  type,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  preferredName?: string | undefined;
  type: ts.Type;
}) {
  const properties = checker.getPropertiesOfType(type).filter((property) => {
    const name = property.getName();
    return name !== "__type" && !name.startsWith("__@");
  });
  if (
    properties.length === 0 ||
    properties.length > MAX_RECORD_PROPERTIES ||
    context.recordNamesByKey.size > MAX_RECORDS_PER_FILE ||
    isGlobalObjectType(type, checker)
  ) {
    return null;
  }

  const key = structuralRecordKey(type, context);
  const current = context.recordNamesByKey.get(key);
  if (current) {
    return current;
  }

  const baseName = preferredName
    ? sanitizeClosureName(preferredName)
    : `${context.sourceFileStem}$Record${context.recordNamesByKey.size}`;
  const recordName = reserveRecordName(baseName, context);
  context.recordNamesByKey.set(key, recordName);

  const lines = ["/**", " * @record", " */", `function ${recordName}() {}`];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = declaration
      ? checker.getTypeOfSymbolAtLocation(property, declaration)
      : checker.getTypeOfSymbol(property);
    lines.push(
      `/** @type {${toClosureType(propertyType, checker, context, new Set([type]))}} */`,
    );
    lines.push(renderPrototypeProperty(recordName, property.getName()));
  }
  context.typeDeclarations.push({ snippet: `${lines.join("\n")}\n` });
  return recordName;
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
  const closureType = toClosureType(type, checker, context);
  return declaration.questionToken
    ? unionClosureTypes([closureType, "undefined"])
    : closureType;
}

function renderNamedType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) {
    return null;
  }
  if (!type.aliasSymbol && !isTypeLikeSymbol(symbol)) {
    return null;
  }
  const symbolName = checker.symbolToString(symbol);
  if (
    !symbolName ||
    symbolName === "__type" ||
    !isClosureQualifiedName(symbolName)
  ) {
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
  );
  if (builtinType) {
    return builtinType;
  }
  const [recordKeyType, recordValueType] = type.aliasTypeArguments ?? [];
  if (
    symbolName === "Record" &&
    recordKeyType !== undefined &&
    recordValueType !== undefined
  ) {
    return `!Object<${toClosureType(recordKeyType, checker, context, seen)}, ${toClosureType(recordValueType, checker, context, seen)}>`;
  }
  if (
    isDeclarationFileSymbol(symbol) &&
    !(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) &&
    type.getProperties().length > 0
  ) {
    const recordName = buildRecordForObjectType({
      checker,
      context,
      preferredName: symbolName,
      type,
    });
    return recordName ? `!${recordName}` : null;
  }
  if (isGlobalObjectType(type, checker)) {
    return "!Object";
  }
  const args = getTypeArguments(type, checker);
  const renderedArgs = args.map((arg) =>
    toClosureType(arg, checker, context, seen),
  );
  return renderedArgs.length > 0
    ? `!${symbolName}<${renderedArgs.join(", ")}>`
    : `!${symbolName}`;
}

function renderBuiltinNamedType(
  symbolName: string,
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  seen: Set<ts.Type>,
) {
  const closureName = BUILTIN_GENERIC_TYPE_NAMES.get(symbolName);
  if (closureName) {
    const args = getTypeArguments(type, checker);
    const renderedArgs = args.map((arg) =>
      toClosureType(arg, checker, context, seen),
    );
    return renderedArgs.length > 0
      ? `!${closureName}<${renderedArgs.join(", ")}>`
      : `!${closureName}`;
  }
  if (!BUILTIN_TYPE_NAMES.has(symbolName)) {
    return null;
  }
  if (symbolName === "Object") {
    return "!Object";
  }
  if (symbolName === "Function") {
    return "!Function";
  }
  return `!${symbolName}`;
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
    return "!Function";
  }
  const params = collectSignatureParamInfos({
    checker,
    context,
    declaration,
  })
    .filter((parameter) => !parameter.thisParam)
    .map(
      (parameter) =>
        `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`,
    );
  const returnType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
    context,
    new Set(seen),
  );
  return `function(${params.join(", ")}): ${returnType}`;
}

export function collectSignatureParamInfos({
  checker,
  context,
  declaration,
  firstParamObjectRecordTypeName,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  declaration: FunctionLikeDeclaration;
  firstParamObjectRecordTypeName?: string | undefined;
}) {
  const parameters = getDeclarationParameters(declaration);
  return parameters.map((parameter, index): SignatureParamInfo => {
    const thisParam = isThisParameter(parameter);
    const rest = !!parameter.dotDotDotToken;
    const optional = !!parameter.questionToken || !!parameter.initializer;
    const name =
      index === 0 && firstParamObjectRecordTypeName
        ? "__props"
        : parameterNameForJsDoc(parameter, index);
    const type =
      index === 0 && firstParamObjectRecordTypeName
        ? `!${firstParamObjectRecordTypeName}`
        : renderParameterType(parameter, checker, context, rest);
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
    return toClosureType(type, checker, context);
  }
  const elementType = getArrayElementType(type, checker);
  return elementType ? toClosureType(elementType, checker, context) : "?";
}

function getArrayElementType(type: ts.Type, checker: ts.TypeChecker) {
  if (!checker.isArrayType(type) && !isReadonlyArrayType(type, checker)) {
    return null;
  }
  return firstOrUndefined(getTypeArguments(type, checker)) ?? null;
}

function isThisParameter(parameter: ts.ParameterDeclaration) {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

export function toClosureHeritageType(
  typeNode: ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const expressionName = getHeritageExpressionName(typeNode.expression);
  if (expressionName) {
    const args = (typeNode.typeArguments ?? []).map((argument) =>
      toClosureType(checker.getTypeFromTypeNode(argument), checker, context),
    );
    return args.length > 0
      ? `${expressionName}<${args.join(", ")}>`
      : expressionName;
  }
  return toClosureType(checker.getTypeAtLocation(typeNode), checker, context)
    .replace(/^!/, "")
    .replace(/<this>$/u, "")
    .replace(/,\s*this(?=>)/gu, "");
}

function getHeritageExpressionName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const left = getHeritageExpressionName(expression.expression);
    return left ? `${left}.${expression.name.text}` : null;
  }
  return null;
}

function collapseLargeUnion(type: ts.UnionType, checker: ts.TypeChecker) {
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
    return unionWithSuffix("!Array<?>", suffix);
  }
  if (nonNullable.every((item) => item.getProperties().length > 0)) {
    return unionWithSuffix("!Object", suffix);
  }
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

function reserveRecordName(baseName: string, context: ClosureDocRenderContext) {
  let candidate = baseName || "Record";
  let index = 0;
  while (context.usedRecordNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}${index}`;
  }
  context.usedRecordNames.add(candidate);
  return candidate;
}

function structuralRecordKey(type: ts.Type, context: ClosureDocRenderContext) {
  const existingId = context.typeIds.get(type);
  if (existingId !== undefined) {
    return `id:${existingId}`;
  }

  const typeId = context.nextTypeId;
  context.nextTypeId += 1;
  context.typeIds.set(type, typeId);
  return `id:${typeId}`;
}

function isReadonlyArrayType(type: ts.Type, checker: ts.TypeChecker) {
  const symbol = type.getSymbol();
  return symbol ? checker.symbolToString(symbol) === "ReadonlyArray" : false;
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker) {
  return isTypeReference(type) ? checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

function isFunctionLikeDeclaration(
  declaration: ts.Node | undefined,
): declaration is FunctionLikeDeclaration {
  return (
    declaration !== undefined &&
    FUNCTION_LIKE_GUARDS.some((isFunctionLike) => isFunctionLike(declaration))
  );
}

function isGlobalObjectType(type: ts.Type, checker: ts.TypeChecker) {
  const symbol = type.getSymbol();
  if (!symbol) {
    return false;
  }
  return BUILTIN_TYPE_NAMES.has(checker.symbolToString(symbol));
}
