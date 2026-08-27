import path from "node:path";
import ts from "@typescript/typescript6";

import { renderRuntimeBridge, stableExternNamespace } from "../module-identity";
import { emitSymbol, reserveSeedSymbol } from "../typed-render-emit";
import type { GeneratedExternExport } from "../types";
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
  maxSymbolDepth,
  modules,
  program,
  projectRoot,
}: {
  checker: ts.TypeChecker;
  maxSymbolDepth?: number | undefined;
  modules: readonly ModuleSeed[];
  program: ts.Program;
  projectRoot?: string | undefined;
}) {
  const state = createRenderState(checker, projectRoot, maxSymbolDepth);
  const globalSurfaces: GeneratedGlobalSurface[] = [];
  const moduleExports: GeneratedExternModule[] = [];

  for (const module of [...modules].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    const seeded = seedTypedModule(module, program, state);
    if (!seeded) continue;
    recordSeededModule(
      module,
      seeded.exports,
      seeded.namespace,
      globalSurfaces,
      moduleExports,
    );
  }

  emitPendingSymbols(state);

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
  return {
    degradations,
    diagnostics: dedupeDiagnostics(state.diagnostics),
    globalSurfaces,
    moduleExports,
    text: [...typedExternsHeader(state.namespaces), ...state.lines, ""].join(
      "\n",
    ),
    warnings,
  };
}

type SeededTypedModule = {
  exports: GeneratedExternExport[];
  namespace: string;
};

function createRenderState(
  checker: ts.TypeChecker,
  projectRoot: string | undefined,
  maxSymbolDepth: number | undefined,
): RenderState {
  return {
    checker,
    maxSymbolDepth,
    degradedOccurrences: 0,
    degradedSymbols: new Set(),
    projectRoot,
    diagnostics: [],
    emitted: new Set(),
    lines: [],
    currentDepth: 0,
    depthForSymbol: new Map(),
    moduleForSymbol: new Map(),
    nameForSymbol: new Map(),
    namespaces: new Set(),
    pending: [],
  };
}

function seedTypedModule(
  module: ModuleSeed,
  program: ts.Program,
  state: RenderState,
): SeededTypedModule | undefined {
  const sourceFile = program.getSourceFile(
    path.resolve(module.declarationEntry),
  );
  const moduleSymbol = sourceFile
    ? findModuleSymbol(module, sourceFile, state.checker)
    : undefined;
  if (!sourceFile || (!module.globalSurface && !moduleSymbol)) {
    diagnostic(
      state,
      module,
      undefined,
      "module-symbol",
      "Declaration module has no TypeScript module symbol.",
    );
    return undefined;
  }
  const namespace = stableExternNamespace(
    module.specifier,
    module.declarationEntry,
    state.projectRoot,
  );
  state.namespaces.add(namespace);
  const exports = reserveBoundaryExports(
    collectSeedExports(module, sourceFile, moduleSymbol, state.checker),
    module,
    state,
  );
  return { exports, namespace };
}

function recordSeededModule(
  module: ModuleSeed,
  exports: GeneratedExternExport[],
  namespace: string,
  globalSurfaces: GeneratedGlobalSurface[],
  moduleExports: GeneratedExternModule[],
) {
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

function collectSeedExports(
  module: ModuleSeed,
  sourceFile: ts.SourceFile,
  moduleSymbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
) {
  if (module.globalSurface) {
    return collectGlobalSurfaceExports(
      sourceFile,
      checker,
      module.selectedExports,
      module.globalDeclarationFiles,
    );
  }
  if (moduleSymbol) {
    return collectModuleExports(moduleSymbol, checker, module.selectedExports);
  }
  return [];
}

type SeedExport = {
  exportName: string;
  symbol: ts.Symbol;
};

function reserveBoundaryExports(
  exportedSymbols: readonly SeedExport[],
  module: ModuleSeed,
  state: RenderState,
): GeneratedExternExport[] {
  return exportedSymbols
    .map(({ exportName, symbol }) => ({
      exportName,
      kind: classifyBoundarySymbol(symbol, state.checker),
      parameterCount: boundaryParameterCount(symbol, state.checker),
      qualifiedName: reserveSeedSymbol(symbol, module, state),
    }))
    .sort((a, b) => a.exportName.localeCompare(b.exportName));
}

function emitPendingSymbols(state: RenderState) {
  while (state.pending.length > 0) {
    const symbol = state.pending.shift();
    if (!symbol || state.emitted.has(symbol)) continue;
    state.emitted.add(symbol);
    state.currentSymbol = symbol;
    state.currentDepth = state.depthForSymbol.get(symbol) ?? 0;
    emitSymbol(symbol, state);
    state.currentSymbol = undefined;
  }
}

function typedExternsHeader(namespaces: Set<string>) {
  return [
    "/** @externs */",
    "// Owner-qualified declarations for runtimes outside this Closure job.",
    "// Runtime bridge snippets in moduleExports must be compiled, not passed as externs.",
    "",
    ...[...namespaces]
      .sort()
      .flatMap((namespace) => ["/** @const */", `var ${namespace} = {};`]),
    "",
  ];
}

function classifyBoundarySymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): GeneratedExternExport["kind"] {
  if (!(symbol.flags & ts.SymbolFlags.Value)) return "type";
  return constructorBoundaryKind(symbol, checker);
}

function constructorBoundaryKind(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): GeneratedExternExport["kind"] {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  const type = declaration
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getTypeOfSymbol(symbol);
  if (
    (symbol.flags & ts.SymbolFlags.Class) !== 0 ||
    type.getConstructSignatures().length > 0
  ) {
    return "constructor";
  }
  return "value";
}

function boundaryParameterCount(symbol: ts.Symbol, checker: ts.TypeChecker) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return 0;
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const signatures = [
    ...type.getConstructSignatures(),
    ...type.getCallSignatures(),
  ];
  return Math.max(
    0,
    ...signatures.map((signature) => signature.getParameters().length),
  );
}

export function renderTypedBoundaryDeclaration(
  exported: GeneratedExternExport,
  boundaryName: string,
  declareVariable = true,
) {
  if (!exported.qualifiedName) return [];
  if (exported.kind === "type") {
    return [`/** @typedef {!${exported.qualifiedName}} */`, `${boundaryName};`];
  }
  if (exported.kind === "constructor") {
    const params = Array.from(
      { length: exported.parameterCount },
      (_, index) => `param${index}`,
    );
    const assignment = `${boundaryName} = function(${params.join(", ")}) {};`;
    const tags = [" * @constructor"];
    if (exported.qualifiedName) {
      tags.push(` * @extends {${exported.qualifiedName}}`);
    }
    const seenTagNames = new Set<string>();
    const uniqueTags = tags.filter((line) => {
      const tagName = /^\s*\*\s*@([^\s{]+)/.exec(line)?.[1];
      if (!tagName) return true;
      if (seenTagNames.has(tagName)) return false;
      seenTagNames.add(tagName);
      return true;
    });
    return [
      "/**",
      ...uniqueTags,
      " */",
      declareVariable ? `var ${assignment}` : assignment,
    ];
  }
  const annotation = `/** @type {!${exported.qualifiedName}} */`;
  if (!declareVariable) return [annotation, `${boundaryName};`];
  return [annotation, `var ${boundaryName};`];
}

export interface TypedBoundaryRecord {
  declaredName: string | null;
  lines: string[];
  target: string;
}

export function renderTypedBoundaryRecord(
  exported: GeneratedExternExport,
  boundaryName: string,
  declareVariable = true,
): TypedBoundaryRecord {
  const lines = renderTypedBoundaryDeclaration(
    exported,
    boundaryName,
    declareVariable,
  );
  const declaresVariable =
    declareVariable &&
    exported.kind !== "type" &&
    /^[$A-Z_a-z][$\w]*$/u.test(boundaryName);
  return {
    declaredName: declaresVariable ? boundaryName : null,
    lines,
    target: boundaryName,
  };
}
