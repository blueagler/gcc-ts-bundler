import type ts from "@typescript/typescript6";

import { stableExternNamespace, stableSymbolName } from "../module-identity";
import type { ModuleSeed, RenderState } from "../typed-render";

export function reserveSymbol(
  symbol: ts.Symbol,
  module: ModuleSeed,
  state: RenderState,
) {
  const current = state.nameForSymbol.get(symbol);
  if (current) return current;
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
  state.moduleForSymbol.set(symbol, module);
  state.pending.push(symbol);
  return name;
}
