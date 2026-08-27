import ts from "@typescript/typescript6";

import {
  isClosureQualifiedName,
  renderPrototypeProperty,
  sanitizeClosureName,
} from "../../../../../shared/closure-type-strings";
import { getPropertyNameText } from "../../../../../shared/typescript";
import type { ClosureDocRenderContext } from "./context";
import {
  canonicalDeclaration,
  canonicalSymbolId,
  getDeclarationName,
  getReferenceNodeSymbol,
  getTypeArguments,
  isDeclarationFileSymbol,
  isTypescriptDefaultLibPath,
  isUnboundAmbientNominal,
  recordUnresolvedType,
  referenceBuiltin,
  referenceInGraphDeclaredType,
  referenceRuntimeSymbol,
  referenceSymbolId,
  referencesForTemplate,
  registerDeclaredTypeSymbol,
  safeGetAliasedSymbol,
  safeSymbolToString,
} from "./context";
import { signatureToClosureFunctionType } from "./function";
import { getTypedDeclarationClosureType } from "./heritage";
import { recurseClosureType } from "./core";

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

export function renderNamedType(
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
    recordUnresolvedType(
      args.context,
      "unsupported-type-atom",
      type,
      args.checker,
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
    return `!${referenceBuiltin("Object", context)}<${recurseClosureType(
      recordKeyType,
      checker,
      context,
      new Set(seen),
      referenceNode && ts.isTypeReferenceNode(referenceNode)
        ? referenceNode.typeArguments?.[0]
        : undefined,
    )}, ${recurseClosureType(
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
  const { checker, context } = args;
  if (isDeclarationFileSymbol(resolvedSymbol)) {
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
    recurseClosureType(
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
  const declaration = canonicalDeclaration(resolvedSymbol);
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
  const existing = context.symbolsById.get(canonicalSymbolId(resolvedSymbol));
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
    const body = recurseClosureType(type, checker, context, new Set(seen));
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
      const heritage = recurseClosureType(
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
