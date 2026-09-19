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
  moduleFragments = false,
}: {
  checker: ts.TypeChecker;
  maxSymbolDepth?: number | undefined;
  modules: readonly ModuleSeed[];
  program: ts.Program;
  projectRoot?: string | undefined;
  moduleFragments?: boolean | undefined;
}) {
  const state = createRenderState(checker, projectRoot, maxSymbolDepth);
  if (moduleFragments) {
    state.projection = {
      roots: new Map(
        modules.map(({ specifier }) => [specifier, new Set<ts.Symbol>()]),
      ),
      symbols: new Map(),
      currentDependencies: undefined,
    };
  }
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
    moduleFragments: factorTypedModules(state, moduleExports),
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
  for (let cursor = 0; cursor < state.pending.length; cursor += 1) {
    const symbol = state.pending[cursor];
    if (!symbol || state.emitted.has(symbol)) continue;
    state.emitted.add(symbol);
    state.currentSymbol = symbol;
    state.currentDepth = state.depthForSymbol.get(symbol) ?? 0;
    const projected = state.projection?.symbols.get(symbol);
    if (projected && state.projection) {
      projected.lineStart = state.lines.length;
      state.projection.currentDependencies = projected.dependencies;
    }
    emitSymbol(symbol, state);
    if (projected && state.projection) {
      projected.lineEnd = state.lines.length;
      state.projection.currentDependencies = undefined;
    }
    state.currentSymbol = undefined;
  }
  state.pending.length = 0;
}

function factorTypedModules(
  state: RenderState,
  modules: readonly GeneratedExternModule[],
): { modules: readonly string[]; text: string }[] | undefined {
  const projection = state.projection;
  if (!projection) return undefined;
  const moduleBySpecifier = new Map(
    modules.map((module) => [module.specifier, module]),
  );
  // Bigint masks are canonical owner sets with no module-count limit. Decode
  // sorted module names only once per distinct emitted owner set.
  const specifiers = [...projection.roots.keys()].sort();
  const moduleBits = new Map(
    specifiers.map((specifier, index) => [specifier, 1n << BigInt(index)]),
  );
  let componentOwners: bigint[] = [];
  const namespaceOwners = new Map<string, bigint>();
  let discoveryOwner = 0;
  let shared = false;
  type OwnershipNode = {
    symbol: ts.Symbol;
    dependencies: OwnershipNode[];
    index: number;
    lowLink: number;
    active: boolean;
    cursor: number;
    component: number;
  };
  const nodes = new Map<ts.Symbol, OwnershipNode>();
  const pending: OwnershipNode[] = [];
  const nodeFor = (symbol: ts.Symbol) => {
    let node = nodes.get(symbol);
    if (!node) {
      node = {
        symbol,
        dependencies: [],
        index: -1,
        lowLink: -1,
        active: false,
        cursor: 0,
        component: discoveryOwner,
      };
      nodes.set(symbol, node);
      pending.push(node);
    } else if (node.component !== discoveryOwner) {
      shared = true;
    }
    return node;
  };
  // Discover each dependency once, retaining the old breadth-first diagnostic
  // order for the first module reaching it. Previously visited closures are valid.
  let cursor = 0;
  for (const [specifier, roots] of projection.roots) {
    const module = moduleBySpecifier.get(specifier);
    if (!module) {
      throw new Error(
        `Unable to factor typed externs for module ${JSON.stringify(specifier)}: no declaration module root.`,
      );
    }
    const bit = moduleBits.get(specifier) ?? 0n;
    componentOwners.push(bit);
    namespaceOwners.set(
      module.namespace,
      (namespaceOwners.get(module.namespace) ?? 0n) | bit,
    );
    for (const symbol of roots) nodeFor(symbol);
    for (; cursor < pending.length; cursor += 1) {
      const node = pending[cursor];
      if (!node) continue;
      const emitted = projection.symbols.get(node.symbol);
      if (!emitted || !state.emitted.has(node.symbol)) {
        throw new Error(
          `Unable to factor typed externs for module ${JSON.stringify(specifier)}: dependency ${node.symbol.getName()} was not emitted.`,
        );
      }
      for (const dependency of emitted.dependencies) {
        node.dependencies.push(nodeFor(dependency));
      }
    }
    discoveryOwner += 1;
  }

  // Discovery already proves complete ownership for disjoint closures, including
  // cycles within one module. Only actual cross-module overlap needs propagation.
  if (shared) {
    // Iterative Tarjan: dependency components finish before their users. Store
    // popped nodes in that order, without allocating a member list per component.
    const active: OwnershipNode[] = [];
    const traversal: OwnershipNode[] = [];
    const ordered: OwnershipNode[] = [];
    let nextIndex = 0;
    let componentCount = 0;
    for (const root of pending) {
      if (root.index !== -1) continue;
      root.index = root.lowLink = nextIndex++;
      root.active = true;
      active.push(root);
      traversal.push(root);
      while (traversal.length > 0) {
        const node = traversal[traversal.length - 1];
        if (!node) break;
        const dependency = node.dependencies[node.cursor++];
        if (dependency) {
          if (dependency.index === -1) {
            dependency.index = dependency.lowLink = nextIndex++;
            dependency.active = true;
            active.push(dependency);
            traversal.push(dependency);
          } else if (dependency.active) {
            node.lowLink = Math.min(node.lowLink, dependency.index);
          }
          continue;
        }
        traversal.pop();
        const parent = traversal[traversal.length - 1];
        if (parent) parent.lowLink = Math.min(parent.lowLink, node.lowLink);
        if (node.lowLink !== node.index) continue;
        let member: OwnershipNode | undefined;
        do {
          member = active.pop();
          if (!member) break;
          member.active = false;
          member.component = componentCount;
          ordered.push(member);
        } while (member !== node);
        componentCount += 1;
      }
    }

    componentOwners = new Array<bigint>(componentCount).fill(0n);
    for (const [specifier, roots] of projection.roots) {
      const bit = moduleBits.get(specifier) ?? 0n;
      for (const symbol of roots) {
        const node = nodes.get(symbol);
        if (node) {
          componentOwners[node.component] =
            (componentOwners[node.component] ?? 0n) | bit;
        }
      }
    }
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const node = ordered[index];
      if (!node) continue;
      const owners = componentOwners[node.component] ?? 0n;
      for (const dependency of node.dependencies) {
        if (dependency.component === node.component) continue;
        componentOwners[dependency.component] =
          (componentOwners[dependency.component] ?? 0n) | owners;
      }
    }
  }
  for (const node of pending) {
    const emitted = projection.symbols.get(node.symbol);
    if (!emitted) continue;
    namespaceOwners.set(
      emitted.namespace,
      (namespaceOwners.get(emitted.namespace) ?? 0n) |
        (componentOwners[node.component] ?? 0n),
    );
  }

  const groups = new Map<
    bigint,
    { key: string; modules: string[]; namespaces: Set<string>; lines: string[] }
  >();
  const groupFor = (owners: bigint) => {
    let group = groups.get(owners);
    if (!group) {
      const modules = specifiers.filter(
        (specifier) => (owners & (moduleBits.get(specifier) ?? 0n)) !== 0n,
      );
      group = {
        key: JSON.stringify(modules),
        modules,
        namespaces: new Set(),
        lines: [],
      };
      groups.set(owners, group);
    }
    return group;
  };
  // Initializers are dependency units too: their owner set is the union of
  // every closure using the namespace, including its own module root.
  for (const [namespace, owners] of namespaceOwners) {
    groupFor(owners).namespaces.add(namespace);
  }
  // Assign each complete block once, preserving original emission order
  // within each group. Namespace names never decide symbol ownership.
  for (const symbol of state.emitted) {
    const node = nodes.get(symbol);
    const owners = node ? componentOwners[node.component] : undefined;
    const emitted = projection.symbols.get(symbol);
    if (!owners || !emitted) {
      throw new Error(
        `Unable to factor typed externs: emitted dependency ${symbol.getName()} has no module owner.`,
      );
    }
    const { lines } = groupFor(owners);
    for (let index = emitted.lineStart; index < emitted.lineEnd; index += 1) {
      const line = state.lines[index];
      if (line === undefined) {
        throw new Error("Typed declaration emission range exceeds its source.");
      }
      lines.push(line);
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((group) => {
      return {
        modules: group.modules,
        text: [
          ...typedExternsHeader(group.namespaces),
          ...group.lines,
          "",
        ].join("\n"),
      };
    });
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
    return [
      "/**",
      " * @constructor",
      ` * @extends {${exported.qualifiedName}}`,
      " */",
      declareVariable ? `var ${assignment}` : assignment,
    ];
  }
  // A value's qualified name is not a nominal type (notably for functions).
  // Query its declared type so callable signatures and object members survive
  // rebinding without manufacturing a constructor or degrading to unknown.
  const annotation = `/** @type {typeof ${exported.qualifiedName}} */`;
  if (!declareVariable) return [annotation, `${boundaryName};`];
  return [annotation, `var ${boundaryName};`];
}
