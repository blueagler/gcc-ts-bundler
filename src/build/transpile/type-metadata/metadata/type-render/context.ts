import crypto from "crypto";
import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import type {
  ClosureTypeDeclaration,
  ClosureTypeReference,
  ClosureTypeSymbol,
  TypeMetadataDiagnostic,
} from "../../types";

export interface ClosureDocRenderContext {
  diagnostics: TypeMetadataDiagnostic[];
  referencesByToken: Map<string, ClosureTypeReference>;
  sourceFilePath: string;
  symbolIdByDeclaredName: Map<string, string>;
  symbolsById: Map<string, ClosureTypeSymbol>;
  typeDeclarations: ClosureTypeDeclaration[];
  // Facts live only as long as this render context. Rendered Closure strings
  // are deliberately not cached: they allocate reference tokens and diagnostics.
  symbolIds?: Map<ts.Symbol, string>;
  canonicalDeclarations?: Map<ts.Symbol, ts.Declaration>;
  normalizedDeclarationPaths?: Map<string, string>;
  builtinIds?: Map<string, string>;
  semanticQueries?: WeakMap<ts.TypeChecker, SemanticQueries>;
}

interface SemanticQueries {
  aliases?: Map<ts.Symbol, ts.Symbol>;
  locationSymbols?: Map<ts.Node, ts.Symbol>;
  symbolNames?: Map<ts.Symbol, string>;
  typeNames?: Map<ts.Type, string>;
}

function semanticQueries(
  context: ClosureDocRenderContext,
  checker: ts.TypeChecker,
): SemanticQueries {
  const byChecker = (context.semanticQueries ??= new WeakMap());
  let queries = byChecker.get(checker);
  if (!queries) {
    queries = {};
    byChecker.set(checker, queries);
  }
  return queries;
}

const MAX_SYMBOL_CHAIN_DEPTH = 64;

export function createClosureDocRenderContext(
  sourceFile: ts.SourceFile,
): ClosureDocRenderContext {
  return {
    diagnostics: [],
    referencesByToken: new Map(),
    sourceFilePath: sourceFile.fileName,
    symbolIdByDeclaredName: new Map(),
    symbolsById: new Map(),
    typeDeclarations: [],
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
    ? canonicalSymbolId(symbol, context)
    : hashIdentity(
        `${normalizeDeclarationPath(declaration.getSourceFile().fileName, context)}:${declaration.getStart()}:${name}:declared`,
      );
  context.symbolIdByDeclaredName.set(name, id);
  context.symbolsById.set(id, {
    declarationFilePath: declaration.getSourceFile().fileName,
    diagnosticName: name,
    id,
    kind: "declared",
    localName: name,
  });
  return id;
}

export function canonicalSymbolId(
  symbol: ts.Symbol,
  context?: ClosureDocRenderContext,
) {
  const cached = context?.symbolIds?.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  const declaration = canonicalDeclaration(symbol, context);
  const id = hashIdentity(
    declaration
      ? `${normalizeDeclarationPath(declaration.getSourceFile().fileName, context)}:${declaration.getStart()}:${symbol.flags}`
      : `symbol:${symbol.getName()}:${symbol.flags}`,
  );
  if (context) {
    (context.symbolIds ??= new Map()).set(symbol, id);
  }
  return id;
}

export function isDeclarationFileSymbol(symbol: ts.Symbol) {
  return (symbol.declarations ?? []).some(
    (declaration) => declaration.getSourceFile().isDeclarationFile,
  );
}

export function isTypescriptDefaultLibPath(filePath: string) {
  return /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/iu.test(
    filePath,
  );
}

export function isReadonlyArrayType(type: ts.Type) {
  const symbol = type.getSymbol();
  return symbol?.getName() === "ReadonlyArray";
}

export function getTypeArguments(type: ts.Type, checker: ts.TypeChecker) {
  return isTypeReference(type) ? checker.getTypeArguments(type) : [];
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return "target" in type;
}

export function symbolParent(symbol: ts.Symbol): ts.Symbol | undefined {
  return hasSymbolParent(symbol) ? symbol.parent : undefined;
}

function hasSymbolParent(
  symbol: ts.Symbol,
): symbol is ts.Symbol & { parent: ts.Symbol } {
  return "parent" in symbol && symbol.parent !== undefined;
}

export function getReferenceNodeSymbol(
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
  const queries = semanticQueries(context, checker);
  const cached = queries.locationSymbols?.get(location);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const symbol = checker.getSymbolAtLocation(location);
    if (symbol !== undefined) {
      (queries.locationSymbols ??= new Map()).set(location, symbol);
    }
    return symbol;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordTypeDiagnostic(context, "symbol-rendering-failed", undefined);
    return null;
  }
}

export function referenceBuiltin(
  name: string,
  context: ClosureDocRenderContext,
) {
  let id = context.builtinIds?.get(name);
  if (id === undefined) {
    id = hashIdentity(`builtin:${name}`);
    (context.builtinIds ??= new Map()).set(name, id);
  }
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

export function referenceInGraphDeclaredType(
  sourceSymbol: ts.Symbol,
  resolvedSymbol: ts.Symbol,
  diagnosticName: string,
  context: ClosureDocRenderContext,
) {
  const declaration = canonicalDeclaration(resolvedSymbol, context);
  if (!declaration || !isInGraphEmittedTypeDeclaration(declaration)) {
    return null;
  }
  const aliasDeclaration =
    sourceSymbol.flags & ts.SymbolFlags.Alias
      ? canonicalDeclaration(sourceSymbol, context)
      : undefined;
  const localName = getDeclarationName(aliasDeclaration) ?? diagnosticName;
  const id = canonicalSymbolId(resolvedSymbol, context);
  if (!context.symbolsById.has(id)) {
    context.symbolsById.set(id, {
      declarationFilePath: declaration.getSourceFile().fileName,
      diagnosticName,
      id,
      kind: "declared",
      localName,
    });
  }
  return referenceSymbolId(id, context);
}

function isInGraphEmittedTypeDeclaration(declaration: ts.Declaration) {
  const file = declaration.getSourceFile();
  if (file.isDeclarationFile) {
    return false;
  }
  if (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) {
    return false;
  }
  // Classes and enums keep the runtime-binding path so hoist renames stick.
  // Interfaces and aliases are type-only and have no JS binding to miss.
  return (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration)
  );
}

export function referenceRuntimeSymbol(
  sourceSymbol: ts.Symbol,
  resolvedSymbol: ts.Symbol,
  diagnosticName: string,
  context: ClosureDocRenderContext,
) {
  const aliasDeclaration =
    sourceSymbol.flags & ts.SymbolFlags.Alias
      ? canonicalDeclaration(sourceSymbol, context)
      : undefined;
  const localName = getDeclarationName(aliasDeclaration) ?? diagnosticName;
  const identitySymbol = aliasDeclaration ? sourceSymbol : resolvedSymbol;
  const id = canonicalSymbolId(identitySymbol, context);
  if (!context.symbolsById.has(id)) {
    const declaration = canonicalDeclaration(resolvedSymbol, context);
    context.symbolsById.set(id, {
      declarationFilePath: declaration?.getSourceFile().fileName,
      diagnosticName,
      id,
      kind: "runtime",
      localName,
    });
  }
  return referenceSymbolId(id, context);
}

export function getDeclarationName(declaration: ts.Declaration | undefined) {
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

export function referenceSymbolId(
  id: string,
  context: ClosureDocRenderContext,
) {
  const token = `__GCC_TYPE_${context.referencesByToken.size}__`;
  context.referencesByToken.set(token, { symbolId: id, token });
  return token;
}

export function recordTypeDiagnostic(
  context: ClosureDocRenderContext,
  reason: TypeMetadataDiagnostic["reason"],
  symbol: ts.Symbol | undefined,
) {
  const declaration = symbol
    ? canonicalDeclaration(symbol, context)
    : undefined;
  context.diagnostics.push({
    declarationFilePath: declaration?.getSourceFile().fileName,
    phase: "analysis",
    reason,
    sourceFilePath: context.sourceFilePath,
    symbolId: symbol ? canonicalSymbolId(symbol, context) : undefined,
    // Diagnostics must never recurse back into the checker renderer after the
    // rendering path already degraded. `getName()` is bounded and sufficient
    // to identify the offending symbol; anonymous types omit the name.
    symbolName: symbol?.getName(),
  });
}

export function safeGetAliasedSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const queries = semanticQueries(context, checker);
  const cached = queries.aliases?.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const resolved = checker.getAliasedSymbol(symbol);
    (queries.aliases ??= new Map()).set(symbol, resolved);
    return resolved;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordTypeDiagnostic(context, "symbol-rendering-failed", symbol);
    return null;
  }
}

export function safeSymbolToString(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const queries = semanticQueries(context, checker);
  const cached = queries.symbolNames?.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  if (!hasBoundedSymbolParentChain(symbol)) {
    recordTypeDiagnostic(context, "symbol-rendering-failed", symbol);
    return null;
  }
  try {
    const name = checker.symbolToString(symbol);
    (queries.symbolNames ??= new Map()).set(symbol, name);
    return name;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordTypeDiagnostic(context, "symbol-rendering-failed", symbol);
    return null;
  }
}

export function safeTypeToString(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const queries = semanticQueries(context, checker);
  const cached = queries.typeNames?.get(type);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const name = checker.typeToString(type);
    (queries.typeNames ??= new Map()).set(type, name);
    return name;
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    recordTypeDiagnostic(
      context,
      "symbol-rendering-failed",
      type.aliasSymbol ?? type.getSymbol(),
    );
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

export function isUnboundAmbientNominal(symbol: ts.Symbol) {
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

export function canonicalDeclaration(
  symbol: ts.Symbol,
  context?: ClosureDocRenderContext,
) {
  const declarations = symbol.declarations;
  // The usual single-declaration case needs neither a copy nor a cache entry.
  if (!declarations || declarations.length < 2) {
    return declarations?.[0];
  }
  const cached = context?.canonicalDeclarations?.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  let first: ts.Declaration | undefined;
  let firstPath = "";
  for (const declaration of declarations) {
    const declarationPath = normalizeDeclarationPath(
      declaration.getSourceFile().fileName,
      context,
    );
    const pathOrder = declarationPath.localeCompare(firstPath);
    if (
      !first ||
      pathOrder < 0 ||
      (pathOrder === 0 && declaration.getStart() < first.getStart())
    ) {
      first = declaration;
      firstPath = declarationPath;
    }
  }
  if (context && first) {
    (context.canonicalDeclarations ??= new Map()).set(symbol, first);
  }
  return first;
}

function normalizeDeclarationPath(
  filePath: string,
  context?: ClosureDocRenderContext,
) {
  const cached = context?.normalizedDeclarationPaths?.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  let normalized = path.resolve(filePath);
  try {
    normalized = fs.realpathSync.native(normalized).replaceAll(path.sep, "/");
    if (context) {
      (context.normalizedDeclarationPaths ??= new Map()).set(
        filePath,
        normalized,
      );
    }
    return normalized;
  } catch {
    // The checker can retain deleted virtual files; do not cache failed lookups.
    return normalized.replaceAll(path.sep, "/");
  }
}

function hashIdentity(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
