import ts from "@typescript/typescript6";

import { sanitizeClosureName } from "../../shared/closure-type-strings";
import { resolveAliasedSymbol } from "../shared";
import { reserveSymbol } from "./reserve";
import { diagnostic } from "../typed-render/shared";
import type { ModuleSeed, RenderState } from "../typed-render";

const BUILTINS = {
  Array: "Array",
  Date: "Date",
  Error: "Error",
  Function: "Function",
  Iterable: "Iterable",
  Iterator: "Iterator",
  Map: "Map",
  Object: "Object",
  Promise: "Promise",
  ReadonlyArray: "Array",
  ReadonlyMap: "Map",
  ReadonlySet: "Set",
  Set: "Set",
  WeakMap: "WeakMap",
  WeakSet: "WeakSet",
} as const;

function builtinTypeName(name: string) {
  for (const [key, value] of Object.entries(BUILTINS)) {
    if (key === name) return value;
  }
  return undefined;
}
const MAX_DEPTH = 24;
const MAX_PROPERTIES = 48;
const MAX_UNION = 16;

export function renderFunctionParameterNames(
  declarations: readonly ts.SignatureDeclaration[],
) {
  const maxParams = Math.max(
    0,
    ...declarations.map((item) => item.parameters.length),
  );
  // Synthetic positional names cannot collide across overloads and cannot be
  // JavaScript reserved words (including strict-mode `arguments` and `eval`).
  return Array.from({ length: maxParams }, (_, index) => `param${index}`);
}

export function appendSignatureTags(
  lines: string[],
  declarations: readonly ts.SignatureDeclaration[],
  parameterNames: readonly string[],
  state: RenderState,
  module: ModuleSeed,
  constructor: boolean,
) {
  const signatures = declarations
    .map((declaration) => ({
      declaration,
      signature: state.checker.getSignatureFromDeclaration(declaration),
    }))
    .filter(
      (
        item,
      ): item is {
        declaration: ts.SignatureDeclaration;
        signature: ts.Signature;
      } => !!item.signature,
    );
  const maxParams = Math.max(
    0,
    ...signatures.map((item) => item.declaration.parameters.length),
  );
  for (let index = 0; index < maxParams; index += 1) {
    const params = signatures
      .map((item) => item.declaration.parameters[index])
      .filter((item): item is ts.ParameterDeclaration => !!item);
    if (params.length === 0) continue;
    const first = params[0];
    if (!first) continue;
    const rest = params.some((param) => !!param.dotDotDotToken);
    const optional =
      params.length < signatures.length ||
      params.some((param) => !!param.questionToken || !!param.initializer);
    const types = params.map((param) => {
      const type = state.checker.getTypeAtLocation(param);
      if (!rest) return renderType(type, state, module);
      const typeArguments = getTypeArguments(type, state.checker);
      return state.checker.isArrayType(type)
        ? renderType(typeArguments[0] ?? type, state, module)
        : "?";
    });
    lines.push(
      ` * @param {${rest ? "..." : ""}${union(types)}${optional && !rest ? "=" : ""}} ${parameterNames[index] ?? `param${index}`}`,
    );
  }
  if (!constructor && signatures.length > 0) {
    lines.push(
      ` * @return {${union(signatures.map((item) => renderType(state.checker.getReturnTypeOfSignature(item.signature), state, module)))}}`,
    );
  }
}

/**
 * `seen` is threaded from the caller and *must* stay threaded: a function type
 * is a recursion edge like any other, and React's `Dispatch<SetStateAction<S>>` /
 * `ReactNode` chains cycle through signatures. Resetting the guard here is what
 * previously turned `MAX_DEPTH` into a no-op and crashed the renderer with
 * `RangeError: Maximum call stack size exceeded` on real libraries.
 */
function renderFunctionType(
  signature: ts.Signature,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
) {
  const declaration = signature.declaration;
  if (!declaration || !("parameters" in declaration)) return "!Function";
  const params = [...declaration.parameters]
    .filter(ts.isParameter)
    .map((param) => {
      const type = renderType(
        state.checker.getTypeAtLocation(param),
        state,
        module,
        new Set(seen),
      );
      return `${param.dotDotDotToken ? "..." : ""}${type}${param.questionToken || param.initializer ? "=" : ""}`;
    });
  return `function(${params.join(", ")}): ${renderType(state.checker.getReturnTypeOfSignature(signature), state, module, new Set(seen))}`;
}

export function renderType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen = new Set<ts.Type>(),
): string {
  if (seen.size > MAX_DEPTH || seen.has(type))
    return fallback(state, module, type, "recursive-or-deep-type");
  seen.add(type);
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  )
    return "?";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.TypeParameter)
    return sanitizeClosureName(state.checker.typeToString(type));
  if (
    type.flags &
    (ts.TypeFlags.Conditional |
      ts.TypeFlags.IndexedAccess |
      ts.TypeFlags.Substitution)
  ) {
    return fallback(state, module, type, "unsupported-type-operator");
  }
  if (type.isUnion()) {
    if (type.types.length > MAX_UNION)
      return fallback(state, module, type, "union-too-large");
    return union(
      type.types.map((item) => renderType(item, state, module, new Set(seen))),
    );
  }
  if (type.isIntersection()) return "!Object";
  if (state.checker.isArrayType(type) || state.checker.isTupleType(type)) {
    const args = getTypeArguments(type, state.checker);
    return `!Array<${args.length ? union(args.map((item) => renderType(item, state, module, new Set(seen)))) : "?"}>`;
  }
  const call = type.getCallSignatures()[0];
  if (call && type.getProperties().length === 0)
    return renderFunctionType(call, state, module, seen);
  const symbol = resolveAliasedSymbol(
    type.aliasSymbol ?? type.getSymbol(),
    state.checker,
  );
  if (symbol && symbol.getName() !== "__type") {
    const builtin = builtinTypeName(symbol.getName());
    const args = isTypeReference(type)
      ? state.checker.getTypeArguments(type)
      : (type.aliasTypeArguments ?? []);
    if (builtin)
      return `!${builtin}${args.length ? `<${args.map((item) => renderType(item, state, module, new Set(seen))).join(", ")}>` : ""}`;
    if (
      (symbol.declarations ?? []).some(
        (item) => item.getSourceFile().isDeclarationFile,
      )
    ) {
      const name = reserveSymbol(symbol, module, state);
      return `!${name}${args.length ? `<${args.map((item) => renderType(item, state, module, new Set(seen))).join(", ")}>` : ""}`;
    }
  }
  const properties = state.checker.getPropertiesOfType(type);
  if (properties.length > 0 && properties.length <= MAX_PROPERTIES) {
    const fields = properties.map((property) => {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = declaration
        ? state.checker.getTypeOfSymbolAtLocation(property, declaration)
        : state.checker.getTypeOfSymbol(property);
      return `${JSON.stringify(property.getName())}: ${renderType(propertyType, state, module, new Set(seen))}`;
    });
    return `{${fields.join(", ")}}`;
  }
  return fallback(state, module, type, "unresolved-type");
}

function fallback(
  state: RenderState,
  module: ModuleSeed,
  type: ts.Type,
  code: string,
) {
  state.degradedOccurrences += 1;
  if (state.currentSymbol) state.degradedSymbols.add(state.currentSymbol);
  diagnostic(
    state,
    module,
    undefined,
    code,
    `Degraded ${state.checker.typeToString(type)} to ?.`,
  );
  return "?";
}

export function union(types: string[]) {
  const unique = [...new Set(types)].sort();
  const only = unique[0];
  return unique.length === 1 && only !== undefined
    ? only
    : `(${unique.join("|")})`;
}

export function appendTemplates(
  lines: string[],
  parameters: readonly ts.TypeParameterDeclaration[],
) {
  const names = [
    ...new Set(parameters.map((item) => sanitizeClosureName(item.name.text))),
  ].sort();
  if (names.length) lines.push(` * @template ${names.join(", ")}`);
}

export function propertyName(
  name: ts.PropertyName | ts.BindingName | undefined,
) {
  return name &&
    (ts.isIdentifier(name) ||
      ts.isStringLiteralLike(name) ||
      ts.isNumericLiteral(name))
    ? name.text
    : null;
}

export function propertyAccess(owner: string, name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    ? `${owner}.${name}`
    : `${owner}[${JSON.stringify(name)}]`;
}

export function hasStatic(node: ts.Node) {
  return !!(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((item) => item.kind === ts.SyntaxKind.StaticKeyword)
  );
}

export function isNonPublic(node: ts.Node) {
  return !!(
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some(
        (item) =>
          item.kind === ts.SyntaxKind.PrivateKeyword ||
          item.kind === ts.SyntaxKind.ProtectedKeyword,
      )
  );
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker) {
  return isTypeReference(type) ? checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

export function isSignatureDeclaration(
  node: ts.Declaration,
): node is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}
