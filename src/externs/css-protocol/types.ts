import ts from "@typescript/typescript6";

/** Upward hops: one hop is one call-site expansion of a tainted parameter. */
export const MAX_UPWARD_HOPS = 3;
/** Depth of the non-fanning steps (returns, initializers, merges). */
export const MAX_TAINT_DEPTH = 64;
/** Depth of the sink proof: `key` -> `f(key)` -> template with a `--` head. */
export const MAX_SINK_CALL_DEPTH = 2;
/** Total taint steps; a stop valve, not a design parameter. */
export const MAX_TAINT_STEPS = 2_000_000;

export const CSS_VARIABLE_MARKER = "--";

export const KEY_ENUMERATION_METHODS = new Set([
  "entries",
  "getOwnPropertyNames",
  "keys",
]);
export const ITERATION_METHODS = new Set([
  "every",
  "filter",
  "flatMap",
  "forEach",
  "map",
  "some",
]);
/**
 * Helpers that merge their arguments into one object: Babel and esbuild emit
 * the spread forms, `Object.assign` is the platform one. A merge is transparent
 * to the taint — the keys of the result are the keys of the arguments.
 */
export const MERGE_HELPER_PATTERN =
  /^_{0,2}(?:objectSpread2?|extends|assign)\d*$/u;

export const MAX_FRAME_DEPTH = 8;

export type FunctionLikeNode =
  | ts.ArrowFunction
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

export type ScopeNode = FunctionLikeNode | ts.SourceFile;

/**
 * One flat record rather than a discriminated union, and deliberately so.
 * Closure disambiguates a property by the receiver type it can see; a variant
 * read out of a union after TypeScript narrowing — which Closure cannot see —
 * is an unknown receiver, so it renames one side of the property and leaves
 * the other alone, and the two spellings never meet. With one named type every
 * read and every write agree. Which kind of symbol this is, is the field that
 * is set: exactly one of `call`, `declaration`, `fn`, `node` and `specifier`,
 * or none of them for a name declared twice in one scope.
 */
export interface ScopeSymbol {
  /** `const { x } = f(…)` — the call, with `property` naming the member. */
  call: ts.CallExpression | null;
  /** `const x = …` — the declaration, with `scope` naming where it lives. */
  declaration: ts.VariableDeclaration | null;
  exportName: string | null;
  /** A parameter of `fn`, at `index`, optionally destructured to `property`. */
  fn: FunctionLikeNode | null;
  index: number;
  /** A function declaration or a function-valued `const`. */
  node: FunctionLikeNode | null;
  property: string | null;
  scope: ScopeNode | null;
  /** An import from `specifier`, of `exportName`. */
  specifier: string | null;
}

export function emptySymbol(): ScopeSymbol {
  return {
    call: null,
    declaration: null,
    exportName: null,
    fn: null,
    index: -1,
    node: null,
    property: null,
    scope: null,
    specifier: null,
  };
}

export function parameterSymbol(
  fn: FunctionLikeNode,
  index: number,
  property: string | null,
): ScopeSymbol {
  return { ...emptySymbol(), fn, index, property };
}

export function functionSymbol(node: FunctionLikeNode): ScopeSymbol {
  return { ...emptySymbol(), node };
}

export function importSymbol(
  exportName: string,
  specifier: string,
): ScopeSymbol {
  return { ...emptySymbol(), exportName, specifier };
}

export function variableSymbol(
  declaration: ts.VariableDeclaration,
  scope: ScopeNode,
): ScopeSymbol {
  return { ...emptySymbol(), declaration, scope };
}

export function destructuredCallSymbol(
  call: ts.CallExpression,
  property: string,
): ScopeSymbol {
  return { ...emptySymbol(), call, property };
}

export type ExportTarget =
  | { kind: "local"; name: string }
  | { kind: "reExport"; exportName: string; specifier: string };

export interface ModuleInfo {
  exports: Map<string, ExportTarget>;
  filePath: string;
  scopes: Map<ScopeNode, Map<string, ScopeSymbol>>;
  sourceFile: ts.SourceFile;
  starReExports: string[];
}

export interface Resolution {
  module: ModuleInfo;
  symbol: ScopeSymbol;
}

export interface FunctionRef {
  module: ModuleInfo;
  node: FunctionLikeNode;
}

export interface CallSite {
  call: ts.CallExpression;
  module: ModuleInfo;
}

/**
 * A call context. Entering a resolved function through a call binds its
 * parameters to that call's arguments, so reading a parameter inside is exact
 * and costs no hop. Only a parameter with no binding context fans out to every
 * call site, and that is what a hop counts.
 */
export interface Frame {
  call: ts.CallExpression;
  /**
   * Deliberately not named `fn`: two record types that share a property name
   * are one disambiguation cluster for Closure, and it then renames the
   * declaration of `ScopeSymbol.fn` while leaving its reads alone.
   */
  callee: FunctionLikeNode;
  depth: number;
  module: ModuleInfo;
  parent: Frame | null;
}

export interface EnumeratedKeyBinding {
  key: string;
  scope: ts.Node;
  /** The object whose keys the binding walks. */
  source: ts.Expression;
}

export function isFunctionLikeNode(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node)
  );
}

export function getPropertyKeyText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

export function addToSet<K, V>(map: Map<K, Set<V>>, key: K, value: V) {
  const current = map.get(key);
  if (current) current.add(value);
  else map.set(key, new Set([value]));
}

export function parameterSlotKey(
  fn: FunctionLikeNode,
  index: number,
  property: string | null,
) {
  return `${fn.getSourceFile().fileName}\u0000${fn.pos}\u0000${index}\u0000${property ?? ""}`;
}

export function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const current = map.get(key);
  if (current) current.push(value);
  else map.set(key, [value]);
}
