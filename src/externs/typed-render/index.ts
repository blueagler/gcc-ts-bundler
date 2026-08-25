import path from "node:path";
import type ts from "@typescript/typescript6";

import { renderRuntimeBridge, stableExternNamespace } from "../module-identity";
import { emitSymbol, reserveSymbol } from "../typed-render-emit";
import {
  dedupeDiagnostics,
  diagnostic,
  type ModuleSeed,
  type RenderState,
} from "./shared";
import {
  collectGlobalSurfaceExports,
  collectModuleExports,
  findModuleSymbol,
} from "./surface";
import type { GeneratedExternModule, GeneratedGlobalSurface } from "../types";

export { type ModuleSeed, type RenderState } from "./shared";

export function renderTypedExternalDeclarations({
  checker,
  modules,
  program,
  projectRoot,
}: {
  checker: ts.TypeChecker;
  modules: readonly ModuleSeed[];
  program: ts.Program;
  projectRoot?: string | undefined;
}) {
  const state: RenderState = {
    checker,
    degradedOccurrences: 0,
    degradedSymbols: new Set(),
    projectRoot,
    diagnostics: [],
    emitted: new Set(),
    lines: [],
    moduleForSymbol: new Map(),
    nameForSymbol: new Map(),
    namespaces: new Set(),
    pending: [],
  };
  const globalSurfaces: GeneratedGlobalSurface[] = [];
  const moduleExports: GeneratedExternModule[] = [];

  for (const module of [...modules].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    const sourceFile = program.getSourceFile(
      path.resolve(module.declarationEntry),
    );
    const moduleSymbol = sourceFile
      ? findModuleSymbol(module, sourceFile, checker)
      : undefined;
    if (!sourceFile || (!module.globalSurface && !moduleSymbol)) {
      diagnostic(
        state,
        module,
        undefined,
        "module-symbol",
        "Declaration module has no TypeScript module symbol.",
      );
      continue;
    }
    const namespace = stableExternNamespace(
      module.specifier,
      module.declarationEntry,
      state.projectRoot,
    );
    state.namespaces.add(namespace);
    const exportedSymbols = module.globalSurface
      ? collectGlobalSurfaceExports(
          sourceFile,
          checker,
          module.selectedExports,
          module.globalDeclarationFiles,
        )
      : moduleSymbol
        ? collectModuleExports(moduleSymbol, checker, module.selectedExports)
        : [];
    const exports = exportedSymbols
      .map(({ exportName, symbol }) => ({
        exportName,
        qualifiedName: reserveSymbol(symbol, module, state),
      }))
      .sort((a, b) => a.exportName.localeCompare(b.exportName));
    if (module.globalSurface) {
      globalSurfaces.push({
        collisionPolicy: "owner-qualified",
        exports,
        name: module.globalSurface,
      });
    }
    moduleExports.push({
      declarationEntry: module.declarationEntry,
      exports,
      namespace,
      runtimeBridge: renderRuntimeBridge(module.specifier, namespace),
      specifier: module.specifier,
    });
  }

  while (state.pending.length > 0) {
    const symbol = state.pending.shift();
    if (!symbol || state.emitted.has(symbol)) continue;
    state.emitted.add(symbol);
    state.currentSymbol = symbol;
    emitSymbol(symbol, state);
    state.currentSymbol = undefined;
  }

  const degradations = {
    degradedOccurrences: state.degradedOccurrences,
    degradedSymbolCount: state.degradedSymbols.size,
    reachableSymbolCount: state.emitted.size,
  };
  const warnings = [];
  if (
    degradations.reachableSymbolCount > 0 &&
    degradations.degradedSymbolCount / degradations.reachableSymbolCount > 0.05
  ) {
    warnings.push(
      `Typed extern degradation exceeds 5%: ${degradations.degradedSymbolCount}/${degradations.reachableSymbolCount} reachable symbols rendered as ?.`,
    );
  }
  const header = [
    "/** @externs */",
    "// Owner-qualified declarations for runtimes outside this Closure job.",
    "// Runtime bridge snippets in moduleExports must be compiled, not passed as externs.",
    "",
    ...[...state.namespaces]
      .sort()
      .flatMap((namespace) => ["/** @const */", `var ${namespace} = {};`]),
    "",
  ];
  return {
    degradations,
    diagnostics: dedupeDiagnostics(state.diagnostics),
    globalSurfaces,
    moduleExports,
    text: [...header, ...state.lines, ""].join("\n"),
    warnings,
  };
}

export function renderTypedBoundaryDeclaration(
  externText: string,
  qualifiedName: string,
  boundaryName: string,
  declareVariable = true,
) {
  const referenceIndex = externText.indexOf(qualifiedName);
  if (referenceIndex < 0) return [];
  const commentIndex = externText.lastIndexOf("/**", referenceIndex);
  const statementEnd = externText.indexOf(";", referenceIndex);
  if (commentIndex < 0 || statementEnd < 0) return [];
  const declaration = externText.slice(commentIndex, statementEnd + 1);
  const replaced = declaration.replaceAll(qualifiedName, boundaryName);
  if (!declareVariable) return [replaced];
  const bareReference = `${boundaryName};`;
  if (replaced.endsWith(bareReference)) {
    return [`${replaced.slice(0, -bareReference.length)}var ${bareReference}`];
  }
  const commentEnd = replaced.lastIndexOf("*/");
  const statementStart = commentEnd < 0 ? 0 : commentEnd + 2;
  const statement = replaced.slice(statementStart).trimStart();
  if (statement.startsWith(`${boundaryName} =`)) {
    return [`${replaced.slice(0, statementStart)}\nvar ${statement}`];
  }
  return [replaced];
}
