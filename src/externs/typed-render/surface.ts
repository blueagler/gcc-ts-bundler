import path from "node:path";
import ts from "@typescript/typescript6";

import { resolveAliasedSymbol } from "../shared";
import type { ModuleSeed } from "./shared";

export function findModuleSymbol(
  module: ModuleSeed,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  if (module.ambientModuleName) {
    const quotedName = JSON.stringify(module.ambientModuleName);
    return checker
      .getAmbientModules()
      .find((symbol) => symbol.getName() === quotedName);
  }
  if (module.globalSurface) return undefined;
  return checker.getSymbolAtLocation(sourceFile);
}

export function collectGlobalSurfaceExports(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  selectedExports?: ReadonlySet<string>,
  declarationFiles?: ReadonlySet<string>,
) {
  const sourcePaths =
    declarationFiles ?? new Set([path.resolve(sourceFile.fileName)]);
  const byName = new Map<string, ts.Symbol>();
  for (const symbol of checker.getSymbolsInScope(
    sourceFile,
    ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
  )) {
    if (
      symbol.declarations?.some((declaration) =>
        sourcePaths.has(path.resolve(declaration.getSourceFile().fileName)),
      )
    ) {
      byName.set(symbol.getName(), symbol);
    }
  }
  return selectExportedSymbols(byName, selectedExports, checker);
}

export function collectModuleExports(
  moduleSymbol: ts.Symbol,
  checker: ts.TypeChecker,
  selectedExports?: ReadonlySet<string>,
) {
  const byName = new Map<string, ts.Symbol>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = resolveAliasedSymbol(exported, checker);
    if (symbol) byName.set(exported.getName(), symbol);
  }
  const exportEquals = moduleSymbol.exports?.get(
    ts.InternalSymbolName.ExportEquals,
  );
  const resolvedExportEquals = resolveAliasedSymbol(exportEquals, checker);
  if (resolvedExportEquals) byName.set("export=", resolvedExportEquals);
  return selectExportedSymbols(byName, selectedExports, checker);
}

/**
 * Narrows the collected names to `selectedExports` (`*` selects everything) and
 * drops members that only restate something a base type already declares.
 * `byName` insertion order is the emitted order, so both steps filter in place
 * rather than rebuilding the map.
 */
function selectExportedSymbols(
  byName: Map<string, ts.Symbol>,
  selectedExports: ReadonlySet<string> | undefined,
  checker: ts.TypeChecker,
) {
  if (selectedExports && !selectedExports.has("*")) {
    for (const exportName of byName.keys()) {
      if (!selectedExports.has(exportName)) byName.delete(exportName);
    }
  }
  return [...byName]
    .filter(([, symbol]) => !isRedundantInheritedMember(symbol, checker))
    .map(([exportName, symbol]) => ({ exportName, symbol }));
}

/** `ts.Symbol.parent` is not on the public type but is what identifies the
 * class or interface a member was declared on. */
function hasSymbolParent(
  symbol: ts.Symbol,
): symbol is ts.Symbol & { parent: ts.Symbol } {
  return "parent" in symbol && symbol.parent !== undefined;
}

function hasObjectFlags(type: ts.Type): type is ts.ObjectType {
  return "objectFlags" in type;
}

/** Narrowed to `InterfaceType` because only that carries a base-type list. */
function isClassOrInterfaceType(type: ts.Type): type is ts.InterfaceType {
  return (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    hasObjectFlags(type) &&
    (type.objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) !== 0
  );
}

function isRedundantInheritedMember(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
) {
  if (!hasSymbolParent(symbol)) return false;
  const parent = symbol.parent;
  if (
    (parent.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) ===
    0
  ) {
    return false;
  }
  const parentType = checker.getDeclaredTypeOfSymbol(parent);
  if (!isClassOrInterfaceType(parentType)) return false;
  if (
    !checker
      .getBaseTypes(parentType)
      .some((baseType) => checker.getPropertyOfType(baseType, symbol.getName()))
  ) {
    return false;
  }
  return !isDeclaredOnParent(symbol, parent);
}

function isDeclaredOnParent(symbol: ts.Symbol, parent: ts.Symbol) {
  const parentDeclarations = parent.declarations ?? [];
  return (symbol.declarations ?? []).some((declaration) =>
    parentDeclarations.some(
      (parentDeclaration) => parentDeclaration === declaration.parent,
    ),
  );
}
