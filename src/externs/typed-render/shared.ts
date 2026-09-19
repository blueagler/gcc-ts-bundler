import type ts from "@typescript/typescript6";

import type { ExternTypeDiagnostic } from "../types";

export type ModuleSeed = {
  ambientModuleName?: string | undefined;
  declarationEntry: string;
  globalSurface?: string | undefined;
  globalDeclarationFiles?: ReadonlySet<string> | undefined;
  selectedExports?: ReadonlySet<string> | undefined;
  specifier: string;
};
export type RenderState = {
  checker: ts.TypeChecker;
  currentSymbol?: ts.Symbol | undefined;
  /**
   * Distance from a seed export for the symbol being emitted. Seeds are 0.
   * `reserveSymbol` refuses anything past `MAX_EXTERN_SYMBOL_DEPTH`, which is
   * what bounds the emitted type closure.
   */
  currentDepth: number;
  degradedOccurrences: number;
  degradedSymbols: Set<ts.Symbol>;
  projectRoot?: string | undefined;
  diagnostics: ExternTypeDiagnostic[];
  emitted: Set<ts.Symbol>;
  lines: string[];
  depthForSymbol: Map<ts.Symbol, number>;
  moduleForSymbol: Map<ts.Symbol, ModuleSeed>;
  nameForSymbol: Map<ts.Symbol, string>;
  namespaces: Set<string>;
  /** Unbounded when undefined. See `GenerateExternsOptions.maxSymbolDepth`. */
  maxSymbolDepth?: number | undefined;
  pending: ts.Symbol[];
  /** Allocated only when disjoint module fragments are requested. */
  projection?:
    | {
        roots: Map<string, Set<ts.Symbol>>;
        symbols: Map<
          ts.Symbol,
          {
            dependencies: ts.Symbol[];
            namespace: string;
            lineStart: number;
            lineEnd: number;
          }
        >;
        currentDependencies: ts.Symbol[] | undefined;
      }
    | undefined;
};

export function diagnostic(
  state: RenderState,
  module: ModuleSeed,
  symbol: ts.Symbol | undefined,
  code: string,
  message: string,
) {
  state.diagnostics.push({
    code,
    message,
    module: module.specifier,
    symbol: symbol?.getName(),
  });
}

export function dedupeDiagnostics(diagnostics: ExternTypeDiagnostic[]) {
  const seen = new Set<string>();
  return diagnostics
    .filter((item) => {
      const key = `${item.module}\0${item.symbol ?? ""}\0${item.code}\0${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      `${a.module}:${a.symbol ?? ""}:${a.code}`.localeCompare(
        `${b.module}:${b.symbol ?? ""}:${b.code}`,
      ),
    );
}
