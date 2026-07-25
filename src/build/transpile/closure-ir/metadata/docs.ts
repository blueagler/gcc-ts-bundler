import path from "path";
import ts from "typescript";

import { firstOrUndefined } from "../../../../shared/arrays";
import { hasExportModifier } from "./modifiers";
import type {
  ClosureIrTypeDeclaration,
  FunctionObjectParamRecord,
} from "../types";

export interface ClosureDocRenderContext {
  nextTypeId: number;
  recordNamesByKey: Map<string, string>;
  sourceFileStem: string;
  typeDeclarations: ClosureIrTypeDeclaration[];
  typeIds: WeakMap<ts.Type, number>;
  usedRecordNames: Set<string>;
}

type FunctionLikeDeclaration =
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

type JsDocTagInput = {
  name?: string | undefined;
  text?: string | undefined;
  type?: string | undefined;
};

type SignatureParamInfo = {
  name: string;
  optional: boolean;
  rest: boolean;
  thisParam: boolean;
  type: string;
};

type ResolvedSignature = {
  declaration: FunctionLikeDeclaration;
  signature: ts.Signature;
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

const CONFLICTING_GENERATED_TAGS = new Set([
  "argument",
  "constructor",
  "extends",
  "implements",
  "param",
  "return",
  "template",
  "this",
  "type",
  "typedef",
]);

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

export function buildInterfaceDeclarationSnippet(
  statement: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): ClosureIrTypeDeclaration {
  const name = statement.name.text;
  context.usedRecordNames.add(name);
  const lines: string[] = ["/**"];
  lines.push(" * @record");
  appendTemplateTags(lines, statement.typeParameters);
  lines.push(" */");
  lines.push(`function ${name}() {}`);

  appendInterfaceMembers(lines, name, statement.members, checker, context);

  if (hasExportModifier(statement)) {
    lines.push(`exports.${name} = ${name};`);
  }

  return {
    snippet: `${lines.join("\n")}\n`,
  };
}

export function buildTypeAliasDeclarationSnippet(
  statement: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): ClosureIrTypeDeclaration {
  if (ts.isTypeLiteralNode(statement.type)) {
    const name = statement.name.text;
    context.usedRecordNames.add(name);
    const lines: string[] = ["/**"];
    lines.push(" * @record");
    appendTemplateTags(lines, statement.typeParameters);
    lines.push(" */");
    lines.push(`function ${name}() {}`);
    appendInterfaceMembers(lines, name, statement.type.members, checker, context);
    if (hasExportModifier(statement)) {
      lines.push(`exports.${name} = ${name};`);
    }
    return {
      snippet: `${lines.join("\n")}\n`,
    };
  }

  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker, context);
  const lines: string[] = ["/**"];
  appendTemplateTags(lines, statement.typeParameters);
  lines.push(` * @typedef {${closureType}}`);
  lines.push(" */");
  lines.push(`let ${statement.name.text};`);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join("\n")}\n`,
  };
}

export function buildFunctionJsDoc(
  statement: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  firstParamObjectRecordTypeName?: string | undefined,
) {
  if (!statement.body) {
    return null;
  }
  const declarations = collectFunctionOverloadDeclarations(statement);
  return buildSignaturesJsDoc({
    checker,
    context,
    declarations,
    firstParamObjectRecordTypeName,
  });
}

export function buildFunctionObjectParamRecord(
  statement: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): FunctionObjectParamRecord | null {
  const firstParameter = statement.parameters[0];
  if (
    statement.name === undefined ||
    firstParameter === undefined ||
    !ts.isObjectBindingPattern(firstParameter.name) ||
    hasRestElement(firstParameter.name)
  ) {
    return null;
  }

  const parameterType = checker.getTypeAtLocation(firstParameter);
  const recordTypeName = buildRecordForObjectType({
    checker,
    context,
    preferredName: `${statement.name.text}$Param0`,
    type: parameterType,
  });
  if (!recordTypeName) {
    return null;
  }

  return {
    snippet: "",
    typeName: recordTypeName,
  };
}

export function buildClassJsDoc(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const typeParameters = statement.typeParameters ?? [];
  const tags = [
    ...collectPreservedJsDocTags(statement),
    ...templateTags(typeParameters),
  ];
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureHeritageType(typeNode, checker, context);
        if (!closureType) {
          continue;
        }
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          tags.push({ name: "extends", type: closureType });
        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          tags.push({ name: "implements", type: closureType });
        }
      }
    }
  }
  return tags.length > 0 ? renderJsDoc(tags) : null;
}

export function buildFunctionLikeDoc(
  declaration: FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  if (isBodylessFunctionLikeDeclaration(declaration)) {
    return null;
  }
  const declarations = collectOverloadDeclarations(declaration);
  return buildSignaturesJsDoc({ checker, context, declarations });
}

export function buildVariableJsDoc({
  checker,
  context,
  initializer,
  typeNode,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  initializer?: ts.Expression | undefined;
  typeNode?: ts.TypeNode | undefined;
}) {
  if (
    initializer &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return buildFunctionLikeDoc(initializer, checker, context);
  }

  const type = typeNode
    ? checker.getTypeFromTypeNode(typeNode)
    : initializer
      ? checker.getTypeAtLocation(initializer)
      : null;
  if (!type || !isWorthAnnotatingVariableType(type, checker)) {
    return null;
  }

  return buildTypeJsDoc(toClosureType(type, checker, context));
}

export function buildClassMemberDoc({
  checker,
  context,
  member,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  member: ts.ClassElement;
}) {
  if (
    ts.isConstructorDeclaration(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return buildFunctionLikeDoc(member, checker, context);
  }

  if (!ts.isPropertyDeclaration(member) || !member.type) {
    return null;
  }
  return buildTypeJsDoc(getTypedDeclarationClosureType(member, checker, context));
}

export function buildObjectMemberDoc({
  checker,
  context,
  member,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  member: ts.ObjectLiteralElementLike;
}) {
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return buildFunctionLikeDoc(member, checker, context);
  }

  if (
    ts.isPropertyAssignment(member) &&
    (ts.isArrowFunction(member.initializer) ||
      ts.isFunctionExpression(member.initializer))
  ) {
    return buildFunctionLikeDoc(member.initializer, checker, context);
  }

  if (ts.isPropertyAssignment(member)) {
    const type = checker.getTypeAtLocation(member.initializer);
    return isWorthAnnotatingVariableType(type, checker)
      ? buildTypeJsDoc(toClosureType(type, checker, context))
      : null;
  }

  return null;
}

export function buildClosureTypeReference(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  return toClosureType(type, checker, context);
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

function buildSignaturesJsDoc({
  checker,
  context,
  declarations,
  firstParamObjectRecordTypeName,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  declarations: FunctionLikeDeclaration[];
  firstParamObjectRecordTypeName?: string | undefined;
}) {
  const signatures = resolveSignatures(declarations, checker);
  const implementation = declarations.at(-1);
  if (signatures.length === 0 || implementation === undefined) {
    return null;
  }

  const tags: JsDocTagInput[] = [
    ...collectPreservedJsDocTags(implementation),
    ...uniqueTemplateTags(declarations),
  ];
  const signatureParams = signatures.map(({ declaration }) =>
    collectSignatureParamInfos({
      checker,
      context,
      declaration,
      firstParamObjectRecordTypeName,
    }),
  );
  appendThisTag(tags, signatureParams);
  appendParameterTags(tags, signatureParams);
  appendReturnTag({
    checker,
    context,
    implementation,
    signatures,
    tags,
  });
  return renderJsDoc(tags);
}

function resolveSignatures(
  declarations: FunctionLikeDeclaration[],
  checker: ts.TypeChecker,
): ResolvedSignature[] {
  return declarations
    .map((declaration) => ({
      declaration,
      signature: checker.getSignatureFromDeclaration(declaration),
    }))
    .filter((entry): entry is ResolvedSignature => entry.signature !== undefined);
}

function appendThisTag(
  tags: JsDocTagInput[],
  signatureParams: SignatureParamInfo[][],
) {
  const thisTypes = uniqueSortedStrings(
    signatureParams
      .flatMap((params) => params.filter((param) => param.thisParam))
      .map((param) => param.type),
  );
  if (thisTypes.length > 0) {
    tags.push({ name: "this", type: mergeClosureTypes(thisTypes) });
  }
}

function appendParameterTags(
  tags: JsDocTagInput[],
  signatureParams: SignatureParamInfo[][],
) {
  const realParams = signatureParams.map((params) =>
    params.filter((param) => !param.thisParam),
  );
  const maxParamCount = Math.max(0, ...realParams.map((params) => params.length));
  const minParamCount = Math.min(
    ...realParams.map((params) => params.filter((param) => !param.rest).length),
  );
  let foundOptional = false;
  for (let index = 0; index < maxParamCount; index += 1) {
    const parameter = buildParameterTag({
      foundOptional,
      index,
      minParamCount,
      realParams,
    });
    if (!parameter) {
      continue;
    }
    tags.push(parameter.tag);
    foundOptional ||= parameter.optional;
    if (parameter.rest) {
      break;
    }
  }
}

function buildParameterTag(input: {
  foundOptional: boolean;
  index: number;
  minParamCount: number;
  realParams: SignatureParamInfo[][];
}): { optional: boolean; rest: boolean; tag: JsDocTagInput } | null {
  const candidates = input.realParams
    .map((params) => params[input.index])
    .filter((param): param is SignatureParamInfo => param !== undefined);
  const first = firstOrUndefined(candidates);
  if (first === undefined) {
    return null;
  }
  const rest = candidates.some((param) => param.rest);
  const optional =
    !rest &&
    (input.foundOptional ||
      input.index >= input.minParamCount ||
      candidates.some((param) => param.optional));
  const mergedType = mergeClosureTypes(
    candidates.map((param) =>
      optional ? stripUndefinedFromClosureType(param.type) : param.type,
    ),
  );
  return {
    optional,
    rest,
    tag: {
      name: "param",
      text: first.name,
      type: `${rest ? "..." : ""}${mergedType}${optional ? "=" : ""}`,
    },
  };
}

function appendReturnTag(input: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  implementation: FunctionLikeDeclaration;
  signatures: ResolvedSignature[];
  tags: JsDocTagInput[];
}) {
  if (
    input.signatures.some(({ declaration }) =>
      ts.isConstructorDeclaration(declaration),
    ) || isSetterDeclaration(input.implementation)
  ) {
    return;
  }
  input.tags.push({
    name: "return",
    type: mergeClosureTypes(
      input.signatures.map(({ signature }) =>
        toClosureType(
          input.checker.getReturnTypeOfSignature(signature),
          input.checker,
          input.context,
        ),
      ),
    ),
  });
}

function buildTypeJsDoc(closureType: string) {
  return renderJsDoc([{ name: "type", type: closureType }]);
}

function appendInterfaceMembers(
  lines: string[],
  typeName: string,
  members: ts.NodeArray<ts.TypeElement>,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  for (const member of members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      continue;
    }
    if (ts.isPropertySignature(member)) {
      const propertyType = getTypedDeclarationClosureType(
        member,
        checker,
        context,
      );
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(
        signature,
        checker,
        context,
      );
      lines.push(`/** @type {${functionType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
    }
  }
}

function buildRecordForObjectType({
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

function getTypedDeclarationClosureType(
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

function signatureToClosureFunctionType(
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
    .map((parameter) =>
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

function collectFunctionOverloadDeclarations(
  implementation: ts.FunctionDeclaration,
): FunctionLikeDeclaration[] {
  if (!implementation.name || !implementation.body) {
    return [implementation];
  }
  if (
    !ts.isSourceFile(implementation.parent) &&
    !ts.isModuleBlock(implementation.parent)
  ) {
    return [implementation];
  }
  const declarations = implementation.parent.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === implementation.name?.text,
  );
  const implementationIndex = declarations.indexOf(implementation);
  return implementationIndex > 0
    ? declarations.slice(0, implementationIndex + 1)
    : [implementation];
}

function collectOverloadDeclarations(
  implementation: FunctionLikeDeclaration,
): FunctionLikeDeclaration[] {
  if (!hasFunctionBody(implementation)) {
    return [implementation];
  }
  if (ts.isFunctionDeclaration(implementation)) {
    return collectFunctionOverloadDeclarations(implementation);
  }
  if (
    ts.isMethodDeclaration(implementation) ||
    ts.isConstructorDeclaration(implementation)
  ) {
    const members = ts.isClassDeclaration(implementation.parent) ||
      ts.isClassExpression(implementation.parent)
      ? implementation.parent.members
      : undefined;
    if (!members) {
      return [implementation];
    }
    const implementationName = getClassMemberName(implementation);
    const candidates = members.filter(
      (member): member is ts.ConstructorDeclaration | ts.MethodDeclaration =>
        (ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member)) &&
        getClassMemberName(member) === implementationName,
    );
    const implementationIndex = candidates.indexOf(implementation);
    return implementationIndex > 0
      ? candidates.slice(0, implementationIndex + 1)
      : [implementation];
  }
  return [implementation];
}

function collectSignatureParamInfos({
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

function hasFunctionBody(declaration: FunctionLikeDeclaration) {
  return "body" in declaration && !!declaration.body;
}

function isBodylessFunctionLikeDeclaration(declaration: FunctionLikeDeclaration) {
  return "body" in declaration && !declaration.body;
}

function isThisParameter(parameter: ts.ParameterDeclaration) {
  return ts.isIdentifier(parameter.name) && parameter.name.text === "this";
}

function mergeClosureTypes(types: string[]) {
  return unionClosureTypes(types.filter(Boolean));
}

function unionClosureTypes(types: string[]) {
  const unique = uniqueSortedStrings(types.flatMap(expandClosureUnionType));
  const onlyType = firstOrUndefined(unique);
  return unique.length === 1 && onlyType !== undefined
    ? onlyType
    : `(${unique.join("|")})`;
}

function expandClosureUnionType(type: string): string[] {
  return type.startsWith("(") && type.endsWith(")")
    ? splitTopLevelUnion(type.slice(1, -1))
    : [type];
}

function stripUndefinedFromClosureType(type: string) {
  if (type === "undefined") {
    return "?";
  }
  if (!type.includes("undefined")) {
    return type;
  }
  if (!type.startsWith("(") || !type.endsWith(")")) {
    return type;
  }
  const parts = splitTopLevelUnion(type.slice(1, -1)).filter(
    (part) => part !== "undefined",
  );
  const onlyPart = firstOrUndefined(parts);
  return parts.length === 0
    ? "?"
    : parts.length === 1 && onlyPart !== undefined
      ? onlyPart
      : `(${parts.join("|")})`;
}

function splitTopLevelUnion(type: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < type.length; index += 1) {
    const char = type[index];
    if (char === "<" || char === "(" || char === "{") {
      depth += 1;
    } else if (char === ">" || char === ")" || char === "}") {
      depth -= 1;
    } else if (char === "|" && depth === 0) {
      parts.push(type.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(type.slice(start));
  return parts;
}

function collectPreservedJsDocTags(node: ts.Node): JsDocTagInput[] {
  const tags: JsDocTagInput[] = [];
  for (const tag of ts.getJSDocTags(node)) {
    const name = tag.tagName.text;
    if (CONFLICTING_GENERATED_TAGS.has(name)) {
      continue;
    }
    const text = jsDocCommentText(tag.comment);
    tags.push(text ? { name, text } : { name });
  }
  return tags;
}

function jsDocCommentText(
  comment: string | ts.NodeArray<ts.JSDocComment> | undefined,
) {
  if (!comment) {
    return "";
  }
  if (typeof comment === "string") {
    return comment.trim();
  }
  return comment.map((part) => part.getText()).join(" ").trim();
}

function uniqueTemplateTags(declarations: FunctionLikeDeclaration[]) {
  return uniqueSortedStrings(
    declarations.flatMap((declaration) =>
      getTemplateNames(getSignatureTypeParameters(declaration)),
    ),
  ).map((name) => ({ name: "template", text: name }));
}

function templateTags(
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  return getTemplateNames(typeParameters).map((name) => ({
    name: "template",
    text: name,
  }));
}

function renderJsDoc(tags: JsDocTagInput[]) {
  const lines = ["/**"];
  for (const tag of tags) {
    if (!tag.name) {
      continue;
    }
    if (tag.type && tag.text) {
      lines.push(` * @${tag.name} {${tag.type}} ${tag.text}`);
    } else if (tag.type) {
      lines.push(` * @${tag.name} {${tag.type}}`);
    } else if (tag.text) {
      lines.push(` * @${tag.name} ${tag.text}`);
    } else {
      lines.push(` * @${tag.name}`);
    }
  }
  lines.push(" */");
  return `${lines.join("\n")}\n`;
}

function toClosureHeritageType(
  typeNode: ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const expressionName = getHeritageExpressionName(typeNode.expression);
  if (expressionName) {
    const args = (typeNode.typeArguments ?? []).map((argument) =>
      toClosureType(checker.getTypeFromTypeNode(argument), checker, context),
    );
    return args.length > 0 ? `${expressionName}<${args.join(", ")}>` : expressionName;
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
    .filter(
      (item) =>
        item.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined),
    )
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

function unionWithSuffix(base: string, suffix: string[]) {
  const rendered = uniqueSortedStrings([base, ...suffix]);
  const onlyType = firstOrUndefined(rendered);
  return rendered.length === 1 && onlyType !== undefined
    ? onlyType
    : `(${rendered.join("|")})`;
}

function isWorthAnnotatingVariableType(type: ts.Type, checker: ts.TypeChecker) {
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

function getSignatureTypeParameters(declaration: FunctionLikeDeclaration) {
  return "typeParameters" in declaration ? declaration.typeParameters : undefined;
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

function appendTemplateTags(
  lines: string[],
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  for (const tag of templateTags(typeParameters)) {
    lines.push(` * @template ${tag.text}`);
  }
}

function getTemplateNames(
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  return (typeParameters ?? []).map((parameter) =>
    sanitizeClosureName(parameter.name.text),
  );
}

function hasRestElement(pattern: ts.ObjectBindingPattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}

function getPropertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}

export function getClassMemberName(member: ts.ClassElement) {
  if (ts.isConstructorDeclaration(member)) {
    return "constructor";
  }
  return getPropertyNameText(member.name);
}

export function getObjectPropertyName(member: ts.ObjectLiteralElementLike) {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) ||
    ts.isShorthandPropertyAssignment(member)
  ) {
    return getPropertyNameText(member.name);
  }
  return null;
}

export function hasStaticModifier(node: ts.Node) {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
  );
}

function isSetterDeclaration(declaration: FunctionLikeDeclaration) {
  return ts.isSetAccessorDeclaration(declaration);
}

function renderPrototypeProperty(typeName: string, propertyName: string) {
  return isClosureIdentifier(propertyName)
    ? `${typeName}.prototype.${propertyName};`
    : `${typeName}.prototype[${JSON.stringify(propertyName)}];`;
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

function structuralRecordKey(
  type: ts.Type,
  context: ClosureDocRenderContext,
) {
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

function sanitizeClosureName(name: string) {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!sanitized || /^[0-9]/u.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

function isClosureIdentifier(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

function isClosureQualifiedName(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(
    name,
  );
}

function uniqueSortedStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
