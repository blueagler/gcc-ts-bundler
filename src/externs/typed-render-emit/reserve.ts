import type ts from "@typescript/typescript6";

import { stableExternNamespace, stableSymbolName } from "../module-identity";
import type { ModuleSeed, RenderState } from "../typed-render";

/** A seed export is the boundary itself, so it is always spelled out. */
export function reserveSeedSymbol(
  symbol: ts.Symbol,
  module: ModuleSeed,
  state: RenderState,
): string {
  state.projection?.roots.get(module.specifier)?.add(symbol);
  return state.nameForSymbol.get(symbol) ?? reserveAt(symbol, module, state, 0);
}

/**
 * A type referenced *by* an already-reserved symbol. Returns `undefined` once
 * the reference sits past `MAX_EXTERN_SYMBOL_DEPTH`; callers degrade to `?`.
 * An already-reserved symbol is returned regardless of depth, because it is
 * already queued for emission at its own shorter distance.
 */
export function reserveSymbol(
  symbol: ts.Symbol,
  module: ModuleSeed,
  state: RenderState,
): string | undefined {
  const current = state.nameForSymbol.get(symbol);
  if (current) {
    state.projection?.currentDependencies?.push(symbol);
    return current;
  }
  const depth = state.currentDepth + 1;
  if (state.maxSymbolDepth !== undefined && depth > state.maxSymbolDepth) {
    return undefined;
  }
  const name = reserveAt(symbol, module, state, depth);
  state.projection?.currentDependencies?.push(symbol);
  return name;
}

function reserveAt(
  symbol: ts.Symbol,
  module: ModuleSeed,
  state: RenderState,
  depth: number,
): string {
  const namespace = stableExternNamespace(
    module.specifier,
    module.declarationEntry,
    state.projectRoot,
  );
  state.namespaces.add(namespace);
  const name = stableSymbolName(
    namespace,
    symbol,
    state.checker,
    state.projectRoot,
  );
  state.nameForSymbol.set(symbol, name);
  state.depthForSymbol.set(symbol, depth);
  state.moduleForSymbol.set(symbol, module);
  state.pending.push(symbol);
  if (state.projection) {
    state.projection.symbols.set(symbol, {
      dependencies: [],
      namespace,
      lineStart: 0,
      lineEnd: 0,
    });
  }
  return name;
}
