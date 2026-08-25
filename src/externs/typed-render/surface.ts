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
  if (selectedExports && !selectedExports.has("*")) {
    for (const name of byName.keys()) {
      if (!selectedExports.has(name)) byName.delete(name);
    }
  }
  return [...byName].map(([exportName, symbol]) => ({ exportName, symbol }));
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
  if (selectedExports && !selectedExports.has("*")) {
    for (const exportName of byName.keys()) {
      if (!selectedExports.has(exportName)) byName.delete(exportName);
    }
  }
  return [...byName].map(([exportName, symbol]) => ({ exportName, symbol }));
}
