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
  nextReferenceId: number;
  referencesByToken: Map<string, ClosureTypeReference>;
  sourceFilePath: string;
  symbolIdByDeclaredName: Map<string, string>;
  symbolsById: Map<string, ClosureTypeSymbol>;
  typeDeclarations: ClosureTypeDeclaration[];
  unresolvedTypeReferenceCount: number;
}

const MAX_SYMBOL_CHAIN_DEPTH = 64;

export function createClosureDocRenderContext(
  sourceFile: ts.SourceFile,
): ClosureDocRenderContext {
  return {
    diagnostics: [],
    nextReferenceId: 0,
    referencesByToken: new Map(),
    sourceFilePath: sourceFile.fileName,
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
    diagnosticName: name,
    id,
    kind: "declared",
    localName: name,
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

export function referenceBuiltin(
  name: string,
  context: ClosureDocRenderContext,
) {
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

export function referenceInGraphDeclaredType(
  sourceSymbol: ts.Symbol,
  resolvedSymbol: ts.Symbol,
  diagnosticName: string,
  context: ClosureDocRenderContext,
) {
  const declaration = canonicalDeclaration(resolvedSymbol);
  if (!declaration || !isInGraphEmittedTypeDeclaration(declaration)) {
    return null;
  }
  const aliasDeclaration =
    sourceSymbol.flags & ts.SymbolFlags.Alias
      ? canonicalDeclaration(sourceSymbol)
      : undefined;
  const localName = getDeclarationName(aliasDeclaration) ?? diagnosticName;
  const id = canonicalSymbolId(resolvedSymbol);
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
      ? canonicalDeclaration(sourceSymbol)
      : undefined;
  const localName = getDeclarationName(aliasDeclaration) ?? diagnosticName;
  const identitySymbol = aliasDeclaration ? sourceSymbol : resolvedSymbol;
  const id = canonicalSymbolId(identitySymbol);
  if (!context.symbolsById.has(id)) {
    const declaration = canonicalDeclaration(resolvedSymbol);
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
  const token = `__GCC_TYPE_${context.nextReferenceId}__`;
  context.nextReferenceId += 1;
  context.referencesByToken.set(token, { symbolId: id, token });
  return token;
}

export function recordUnresolvedType(
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

export function safeGetAliasedSymbol(
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

export function safeSymbolToString(
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

export function safeTypeToString(
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

export function recordSymbolRenderingFailure(
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

export function canonicalDeclaration(symbol: ts.Symbol) {
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
