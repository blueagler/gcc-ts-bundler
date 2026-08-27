export type ExternRuntimePlacement = "compiled" | "external";

export interface ExternModuleInput {
  exports?: "all" | "used" | undefined;
  runtime: ExternRuntimePlacement;
  runtimeEntryFiles?: readonly string[] | undefined;
  specifier: string;
}

export interface ExternTypeDiagnostic {
  code: string;
  exportName?: string | undefined;
  message: string;
  module: string;
  symbol?: string | undefined;
}

export interface GeneratedExternExport {
  exportName: string;
  qualifiedName: string;
  /**
   * How the exported TypeScript symbol should be re-bound at a program
   * boundary. Derived from the symbol, not from emitted extern text.
   */
  kind: "constructor" | "value" | "type";
  /** Max constructor/call arity when `kind` is `"constructor"`. */
  parameterCount: number;
}

export interface GeneratedExternModule {
  declarationEntry: string;
  exports: readonly GeneratedExternExport[];
  namespace: string;
  runtimeBridge: string;
  specifier: string;
}

export interface ExternDegradationStats {
  degradedOccurrences: number;
  degradedSymbolCount: number;
  reachableSymbolCount: number;
}

export interface GeneratedGlobalSurface {
  collisionPolicy: "owner-qualified";
  exports: readonly GeneratedExternExport[];
  name: string;
}

export interface GeneratedExternArtifact {
  outputFile?: string | undefined;
  text: string;
}

export interface GeneratedRenameBarrierArtifact extends GeneratedExternArtifact {
  propertyNames: readonly string[];
}

export interface GeneratedTypedExternArtifact extends GeneratedExternArtifact {
  degradations: ExternDegradationStats;
  globalSurfaces: readonly GeneratedGlobalSurface[];
  moduleExports: readonly GeneratedExternModule[];
  /**
   * Property names this artifact pins program-wide. Typed declarations are
   * rename barriers too — an owner-qualified `T.prototype.P` and a record key
   * `{"P": …}` both put `P` in Closure's extern property set — so they are
   * counted here and folded into `renameBarriers.propertyNames`.
   */
  propertyNames: readonly string[];
}

/** Non-fatal cost signal for an extern artifact over the barrier threshold. */
export interface ExternBarrierWarning {
  artifact: string;
  message: string;
  propertyCount: number;
}
