import ts from "@typescript/typescript6";

import {
  commonPrimitiveClosureType,
  sanitizeClosureName,
} from "../../shared/closure-type-strings";
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

/**
 * Ordered dispatcher. The family helpers below are tried in *source order* and
 * that order is load-bearing: the guards are not mutually exclusive (a union of
 * literals is also literal-flagged, a callable object is also a record), so
 * precedence is what decides the emitted text. Each helper returns `undefined`
 * for "not my family, keep walking".
 *
 * `seen` is mutated exactly once, here, before any family runs: adding the type
 * later — or per family — would change the recursion cut-off and therefore the
 * output. Helpers that recurse decide for themselves whether to hand the set
 * onward shared or copied; those decisions are documented at each call.
 */
export function renderType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen = new Set<ts.Type>(),
): string {
  if (seen.size > MAX_DEPTH || seen.has(type))
    return fallback(state, module, type, "recursive-or-deep-type");
  seen.add(type);
  const primitive = renderPrimitiveType(type);
  if (primitive !== undefined) return primitive;
  const parameter = renderTypeParameterType(type, state);
  if (parameter !== undefined) return parameter;
  const operator = renderTypeOperatorType(type, state, module, seen);
  if (operator !== undefined) return operator;
  const unionType = renderUnionType(type, state, module, seen);
  if (unionType !== undefined) return unionType;
  const intersection = renderIntersectionType(type);
  if (intersection !== undefined) return intersection;
  const arrayLike = renderArrayLikeType(type, state, module, seen);
  if (arrayLike !== undefined) return arrayLike;
  const callable = renderCallSignatureType(type, state, module, seen);
  if (callable !== undefined) return callable;
  const reference = renderSymbolReferenceType(type, state, module, seen);
  if (reference !== undefined) return reference;
  const record = renderRecordType(type, state, module, seen);
  if (record !== undefined) return record;
  return fallback(state, module, type, "unresolved-type");
}

function renderPrimitiveType(type: ts.Type): string | undefined {
  // Any/unknown/never collapse to `?` for this Closure target; bigint/symbol
  // stay unmapped here. Shared primitive arms follow.
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  )
    return "?";
  return commonPrimitiveClosureType(type);
}

function renderTypeParameterType(
  type: ts.Type,
  state: RenderState,
): string | undefined {
  if (!(type.flags & ts.TypeFlags.TypeParameter)) return undefined;
  return sanitizeClosureName(state.checker.typeToString(type));
}

/**
 * Conditional / indexed-access / substitution types have no Closure spelling.
 * An indexed access whose apparent type has already resolved to something
 * concrete is rendered through that instead; everything else degrades.
 */
function renderTypeOperatorType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  if (!(type.flags & UNSPELLABLE_TYPE_FLAGS)) return undefined;
  const resolved = resolvedIndexedAccess(type, state, module, seen);
  if (resolved !== undefined) return resolved;
  return fallback(state, module, type, "unsupported-type-operator");
}

const UNSPELLABLE_TYPE_FLAGS =
  ts.TypeFlags.Conditional |
  ts.TypeFlags.IndexedAccess |
  ts.TypeFlags.Substitution;

function resolvedIndexedAccess(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  if (!(type.flags & ts.TypeFlags.IndexedAccess)) return undefined;
  const apparent = state.checker.getApparentType(type);
  if (apparent === type) return undefined;
  if (apparent.flags & UNSPELLABLE_TYPE_FLAGS) return undefined;
  return renderType(apparent, state, module, new Set(seen));
}

/**
 * Over `MAX_UNION` members, rendering every arm is both slow and useless to
 * Closure, so the union is collapsed to one primitive when the arms allow it
 * and degraded otherwise. Members are rendered against *copies* of `seen`:
 * arms are siblings, not a chain, so one arm's depth must not charge another.
 */
function renderUnionType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  if (!type.isUnion()) return undefined;
  if (type.types.length > MAX_UNION) {
    const collapsed = collapsedOversizeUnion(type.types);
    if (collapsed !== undefined) return collapsed;
    return fallback(state, module, type, "union-too-large");
  }
  return union(
    type.types.map((item) => renderType(item, state, module, new Set(seen))),
  );
}

function renderIntersectionType(type: ts.Type): string | undefined {
  if (!type.isIntersection()) return undefined;
  return collapsedIntersectionPrimitive(type.types) ?? "!Object";
}

function renderArrayLikeType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  if (!state.checker.isArrayType(type) && !state.checker.isTupleType(type))
    return undefined;
  const args = getTypeArguments(type, state.checker);
  return `!Array<${args.length ? union(args.map((item) => renderType(item, state, module, new Set(seen)))) : "?"}>`;
}

/**
 * Only a *bare* callable is a function type. Once it carries properties it is
 * a record that happens to be callable, and the record family renders it.
 *
 * `seen` is handed on shared, not copied: `renderFunctionType` is the same
 * recursion edge as any other and copying here is what previously turned
 * `MAX_DEPTH` into a no-op.
 */
function renderCallSignatureType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  const call = type.getCallSignatures()[0];
  if (!call || type.getProperties().length !== 0) return undefined;
  return renderFunctionType(call, state, module, seen);
}

/**
 * Named types: a known builtin, or a symbol declared in a `.d.ts` that we can
 * reserve an extern name for. A symbol that is neither — an inline object type
 * (`__type`), or a local declaration with no extern of its own — falls through
 * to the structural families.
 */
function renderSymbolReferenceType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  const symbol = resolveAliasedSymbol(
    type.aliasSymbol ?? type.getSymbol(),
    state.checker,
  );
  if (!symbol || symbol.getName() === "__type") return undefined;
  const builtin = builtinTypeName(symbol.getName());
  const args = isTypeReference(type)
    ? state.checker.getTypeArguments(type)
    : (type.aliasTypeArguments ?? []);
  if (builtin) return namedReference(builtin, args, state, module, seen);
  if (
    !(symbol.declarations ?? []).some(
      (item) => item.getSourceFile().isDeclarationFile,
    )
  )
    return undefined;
  const reserved = reserveSymbol(symbol, module, state);
  if (reserved === undefined) {
    return fallback(state, module, type, "closure-depth-exceeded");
  }
  return namedReference(reserved, args, state, module, seen);
}

function namedReference(
  name: string,
  args: readonly ts.Type[],
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
) {
  const rendered = args.map((item) =>
    renderType(item, state, module, new Set(seen)),
  );
  return rendered.length ? `!${name}<${rendered.join(", ")}>` : `!${name}`;
}

/**
 * Anonymous records, and the bare `!Object` an empty object type degrades to.
 * Both live here so the property list is asked for once.
 */
function renderRecordType(
  type: ts.Type,
  state: RenderState,
  module: ModuleSeed,
  seen: ReadonlySet<ts.Type>,
): string | undefined {
  const properties = state.checker.getPropertiesOfType(type);
  if (properties.length > 0 && properties.length <= MAX_PROPERTIES) {
    // A comment terminator inside a key has no faithful record spelling: it
    // would close the enclosing JSDoc block and turn the rest of the line
    // into extern source. Degrade the whole record instead of emitting it.
    if (properties.some((property) => property.getName().includes("*/")))
      return fallback(state, module, type, "unrepresentable-property-name");
    const fields = properties.map((property) => {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      const propertyType = declaration
        ? state.checker.getTypeOfSymbolAtLocation(property, declaration)
        : state.checker.getTypeOfSymbol(property);
      return `${jsdocSafeMemberName(property.getName())}: ${renderType(propertyType, state, module, new Set(seen))}`;
    });
    return `{${fields.join(", ")}}`;
  }
  if (
    properties.length === 0 &&
    type.flags & ts.TypeFlags.Object &&
    type.getConstructSignatures().length === 0
  ) {
    return "!Object";
  }
  return undefined;
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

/**
 * Member names are interpolated into a JSDoc block, where a literal `@` opens
 * a tag: TypeScript spells well-known-symbol members `__@toStringTag@42`, and
 * Closure rejects those with `illegal use of unknown JSDoc tag "toStringTag"`.
 * `\u0040` is the JSON escape for `@`, so the quoted key still decodes to the
 * original name while the emitted comment carries no tag-opening character.
 * Quoting belongs here rather than at the call site: escaping before
 * `JSON.stringify` would leave the backslash to be escaped a second time.
 * Names carrying a comment terminator are rejected before they reach this.
 */
function jsdocSafeMemberName(name: string) {
  const quoted = JSON.stringify(name);
  return quoted.includes("@") ? quoted.replaceAll("@", "\\u0040") : quoted;
}

export function union(types: string[]) {
  const unique = [...new Set(types)].sort();
  const only = unique[0];
  return unique.length === 1 && only !== undefined
    ? only
    : `(${unique.join("|")})`;
}

function primitiveClosureType(type: ts.Type): string | undefined {
  // BigIntLike is bit-disjoint from StringLike/NumberLike/BooleanLike and from
  // Void/Undefined/Null, so checking it before the shared arms cannot change a
  // result on any flags word TypeScript actually produces.
  if (type.flags & ts.TypeFlags.BigIntLike) return "bigint";
  const common = commonPrimitiveClosureType(type);
  if (common !== undefined) return common;
  if (type.isUnion()) return collapsedUnionPrimitive(type.types);
  if (type.isIntersection()) return collapsedIntersectionPrimitive(type.types);
  return undefined;
}

function isIgnorableBrandIntersection(type: ts.IntersectionType) {
  return type.types.every(
    (item) =>
      !!(
        item.flags &
        (ts.TypeFlags.Object |
          ts.TypeFlags.NonPrimitive |
          ts.TypeFlags.Void |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Null)
      ),
  );
}

function applyIntersectionArm(
  item: ts.Type,
  primitive: string | undefined,
): { primitive: string | undefined } | undefined {
  if (item.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) {
    return { primitive };
  }
  const inner = primitiveClosureType(item);
  if (inner === undefined) return undefined;
  if (inner === "undefined" || inner === "null" || inner === "void") {
    return { primitive };
  }
  if (primitive !== undefined && primitive !== inner) return undefined;
  return { primitive: inner };
}

function collapsedIntersectionPrimitive(
  types: readonly ts.Type[],
): string | undefined {
  let primitive: string | undefined;
  for (const item of types) {
    const next = applyIntersectionArm(item, primitive);
    if (!next) return undefined;
    primitive = next.primitive;
  }
  return primitive;
}

function applyUnionArm(
  item: ts.Type,
  primitive: string | undefined,
): { primitive: string | undefined; wrapper?: string } | undefined {
  const inner = primitiveClosureType(item);
  if (inner === undefined) {
    if (item.isIntersection() && isIgnorableBrandIntersection(item)) {
      return { primitive };
    }
    return undefined;
  }
  if (inner === "undefined" || inner === "null" || inner === "void") {
    return { primitive, wrapper: inner };
  }
  if (primitive !== undefined && primitive !== inner) return undefined;
  return { primitive: inner };
}

function collapsedUnionPrimitive(
  types: readonly ts.Type[],
): string | undefined {
  let primitive: string | undefined;
  const wrappers: string[] = [];
  for (const item of types) {
    const next = applyUnionArm(item, primitive);
    if (!next) return undefined;
    primitive = next.primitive;
    if (next.wrapper !== undefined) wrappers.push(next.wrapper);
  }
  if (primitive === undefined) return undefined;
  return union([primitive, ...wrappers]);
}

function oversizeUnionArm(item: ts.Type) {
  if (
    item.flags &
    (ts.TypeFlags.Any |
      ts.TypeFlags.Unknown |
      ts.TypeFlags.Never |
      UNSPELLABLE_TYPE_FLAGS)
  ) {
    return false;
  }
  const inner = primitiveClosureType(item);
  if (inner !== undefined) return inner;
  if (item.isIntersection() && isIgnorableBrandIntersection(item)) {
    return undefined;
  }
  return "!Object";
}

function collapsedOversizeUnion(types: readonly ts.Type[]): string | undefined {
  const primitive = collapsedUnionPrimitive(types);
  if (primitive !== undefined) return primitive;
  const parts: string[] = [];
  for (const item of types) {
    const arm = oversizeUnionArm(item);
    if (arm === false) return undefined;
    if (arm !== undefined) parts.push(arm);
  }
  if (parts.length === 0) return undefined;
  return union(parts);
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
