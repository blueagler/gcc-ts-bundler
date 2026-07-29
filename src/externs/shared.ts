import path from "path";
import ts from "typescript";

export const DECLARATION_EXTENSIONS = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];

export const BUILTIN_CONTAINER_NAMES = new Set([
  "Array",
  "AsyncIterable",
  "AsyncIterator",
  "Iterable",
  "Iterator",
  "Map",
  "Promise",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Set",
  "String",
  "WeakMap",
  "WeakSet",
]);

export const BUILTIN_RUNTIME_MEMBER_NAMES = new Set([
  "addEventListener",
  "apply",
  "attachShadow",
  "attributes",
  "length",
  "message",
  "name",
  "removeAttribute",
  "removeEventListener",
  "setAttribute",
]);

export interface InterfaceContract {
  extends: Set<ts.Symbol>;
  members: Set<string>;
  name: string;
  symbol: ts.Symbol;
}

export interface ClassContract {
  constructorParamContracts: Array<Set<ts.Symbol>>;
  instanceMembers: Set<string>;
  name: string;
  staticMembers: Set<string>;
  symbol: ts.Symbol;
  usedImplementedContracts: Set<ts.Symbol>;
}

export interface TypeAliasContract {
  members: Set<string>;
  name: string;
  symbol: ts.Symbol;
}

export interface ContractRegistry {
  classContracts: Map<ts.Symbol, ClassContract>;
  interfaceContracts: Map<ts.Symbol, InterfaceContract>;
  scannedFiles: Set<string>;
  typeAliasContracts: Map<ts.Symbol, TypeAliasContract>;
}

export interface UsageAnalysis {
  nominalInstanceMembers: Map<ts.Symbol, Set<string>>;
  nominalStaticMembers: Map<ts.Symbol, Set<string>>;
  structuralContracts: Set<ts.Symbol>;
  structuralMembers: Set<string>;
}

export function createEmptyContractRegistry(): ContractRegistry {
  return {
    classContracts: new Map(),
    interfaceContracts: new Map(),
    scannedFiles: new Set(),
    typeAliasContracts: new Map(),
  };
}

export function collectStructuralContractMembers(
  symbol: ts.Symbol,
  registry: ContractRegistry,
  seen = new Set<ts.Symbol>(),
): Set<string> {
  if (seen.has(symbol)) {
    return new Set();
  }
  seen.add(symbol);

  const interfaceContract = registry.interfaceContracts.get(symbol);
  if (interfaceContract) {
    const members = new Set(interfaceContract.members);
    for (const extendedSymbol of interfaceContract.extends) {
      for (const member of collectStructuralContractMembers(
        extendedSymbol,
        registry,
        seen,
      )) {
        members.add(member);
      }
    }
    return members;
  }

  const typeAliasContract = registry.typeAliasContracts.get(symbol);
  if (typeAliasContract) {
    return new Set(typeAliasContract.members);
  }

  return new Set();
}

export function resolveTypeSymbol(
  type: ts.Type,
  checker: ts.TypeChecker,
): ts.Symbol | null {
  const symbol = type.getSymbol();
  if (!symbol && type.isUnionOrIntersection()) {
    for (const child of type.types) {
      const childSymbol = resolveTypeSymbol(child, checker);
      if (childSymbol) {
        return childSymbol;
      }
    }
    return null;
  }
  return resolveAliasedSymbol(symbol, checker);
}

export function resolveValueSymbol(node: ts.Node, checker: ts.TypeChecker) {
  return resolveAliasedSymbol(checker.getSymbolAtLocation(node), checker);
}

export function resolveAliasedSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
) {
  if (!symbol) {
    return null;
  }
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

export { renderStructuralExternLine } from "./barriers";

export function addMapSetValue<K>(
  map: Map<K, Set<string>>,
  key: K,
  value: string,
) {
  const current = map.get(key);
  if (current) {
    current.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

export function isProjectAppSourceFile(filePath: string, projectRoot: string) {
  const resolvedFilePath = path.resolve(filePath);
  return (
    !resolvedFilePath.includes(`${path.sep}node_modules${path.sep}`) &&
    !resolvedFilePath.endsWith(".d.ts") &&
    resolvedFilePath.startsWith(path.resolve(projectRoot) + path.sep)
  );
}

export function isExportedDeclaration(node: ts.Node) {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

export function hasStaticModifier(node: ts.Node) {
  return hasModifier(node, ts.SyntaxKind.StaticKeyword);
}

export function hasNonPublicModifier(node: ts.Node) {
  return (
    hasModifier(node, ts.SyntaxKind.PrivateKeyword) ||
    hasModifier(node, ts.SyntaxKind.ProtectedKeyword)
  );
}

function hasModifier(
  node: ts.Node,
  kind:
    | ts.SyntaxKind.ExportKeyword
    | ts.SyntaxKind.PrivateKeyword
    | ts.SyntaxKind.ProtectedKeyword
    | ts.SyntaxKind.StaticKeyword,
) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

export function getPropertyNameText(name: ts.PropertyName | undefined) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

export function getStringLiteralMemberName(
  expression: ts.Expression | undefined,
) {
  if (!expression) {
    return null;
  }
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

/**
 * Which evidence source a candidate member name came from. The two sources
 * genuinely need different filters, and the difference is not arbitrary:
 *
 * - `"contract"` — names read off *declaration* files (boundary-aware and
 *   candidates modes). A `_`/`$`-leading member in a `.d.ts` is by convention
 *   private API the application is not supposed to reach, so pinning it is
 *   pure cost. Excluded.
 * - `"runtime"` — names read off *emitted runtime* files (runtime-aware mode).
 *   Here `_`/`$` names are the opposite signal: `__v_isRef`, `$el`, `_value`
 *   are exactly the framework-internal protocol members whose definition and
 *   read sides are spelled differently, i.e. the hazard the mode exists to
 *   catch. Included — excluding them is what left vue's reactivity frozen.
 *   Runtime evidence also drops host-object members (`addEventListener`,
 *   `setAttribute`, …): those are already in Closure's browser externs, so
 *   re-pinning them adds bytes and proves nothing.
 *
 * Previously these were two functions with a silently divergent body and no
 * comment; `boundary-aware` could not emit a name that `runtime-aware` proved
 * necessary, and nothing said why.
 */
export type ExternNameSource = "contract" | "runtime";

export function isExternPropertyName(
  name: string,
  source: ExternNameSource = "contract",
) {
  if (
    name === "prototype" ||
    name === "constructor" ||
    name.startsWith("#") ||
    name.includes("@") ||
    BUILTIN_CONTAINER_NAMES.has(name)
  ) {
    return false;
  }
  return source === "runtime"
    ? !BUILTIN_RUNTIME_MEMBER_NAMES.has(name)
    : !name.startsWith("_") && !name.startsWith("$");
}

/** `isExternPropertyName(name, "runtime")`. */
export function isRuntimeExternPropertyName(name: string) {
  return isExternPropertyName(name, "runtime");
}

export function isThisOrSuperExpression(expression: ts.Node) {
  return (
    expression.kind === ts.SyntaxKind.ThisKeyword ||
    expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

export function isKnownConstructorExpression(
  expression: ts.Expression,
  knownConstructors: Set<string>,
): boolean {
  return ts.isIdentifier(expression) && knownConstructors.has(expression.text);
}

export function isKnownPrototypeExpression(
  expression: ts.Expression,
  knownConstructors: Set<string>,
) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "prototype" &&
    isKnownConstructorExpression(expression.expression, knownConstructors)
  );
}

export function isObjectDefinePropertyCall(
  expression: ts.LeftHandSideExpression,
) {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Object" &&
    expression.name.text === "defineProperty"
  );
}

export function isAssignmentOperator(kind: ts.SyntaxKind) {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

export function getScriptKindForFile(filePath: string) {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".mts") ||
    filePath.endsWith(".cts")
  ) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

export function isScannedDeclarationSymbol(
  symbol: ts.Symbol,
  scannedFiles: Set<string>,
) {
  return (symbol.declarations ?? []).some((declaration) =>
    scannedFiles.has(path.resolve(declaration.getSourceFile().fileName)),
  );
}

export function findPackageDir(filePath: string) {
  let currentDir = path.dirname(filePath);

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (ts.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export function isTypeSourceFile(filePath: string) {
  return DECLARATION_EXTENSIONS.some((extension) =>
    filePath.endsWith(extension),
  );
}

export function isTypescriptLibFile(filePath: string) {
  return filePath.includes(
    `${path.sep}node_modules${path.sep}typescript${path.sep}lib${path.sep}`,
  );
}

export function symbolCacheKey(symbol: ts.Symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration
    ? `${path.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}`
    : symbol.getName();
}

export function uniqueStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function isRecoverableExternConfigError(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("TS18003") ||
      error.message.includes("No inputs were found in config file"))
  );
}
