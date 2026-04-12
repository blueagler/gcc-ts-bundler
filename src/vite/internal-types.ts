export interface CapturedModuleAnalysis {
  bridgeSpecifiers: string[];
  dynamicImportSpecifiers: string[];
  importSpecifiers: string[];
  isEffectivelyEmpty: boolean;
  isForwardingOnly: boolean;
  needsClosureCompatibilityDownlevel: boolean;
  needsTypeScriptCompatibilityDownlevel: boolean;
}

export interface CapturedModule {
  code: string;
  id: string;
  normalizedCode?: string;
  normalizedAnalysis?: CapturedModuleAnalysis;
  rawAnalysis?: CapturedModuleAnalysis;
}

export interface CapturedRuntimeModule {
  filePath: string;
  id: string;
  relativePath: string;
  sourceModuleIds: string[];
}

export interface MaterializedGraph {
  authoredFiles: string[];
  entries: string[];
  modules: CapturedRuntimeModule[];
  prunedEmptyModuleIds: string[];
  retainedEmptyModuleIds: string[];
  runtimeEntries: string[];
  srcDir: string;
}

export interface GccRuntimeManifestChunk {
  css?: string[];
  deps: string[];
  modules: string[];
  url: string;
}

export interface GccRuntimeManifest {
  baseChunk: string;
  chunks: Record<string, GccRuntimeManifestChunk>;
  loader: string;
  modules: Record<string, string>;
  publicPath: string;
}

export interface ViteCssOwnership {
  enabled: boolean;
  htmlLinkedCss: Set<string>;
  moduleCssById: Map<string, string[]>;
}

export interface ManifestFileSettings {
  fileName: string;
  isInternal: boolean;
}

export interface ViteBuildMetrics {
  normalizedRetainedModuleCount: number;
  parseCacheHits: number;
  parseCacheMisses: number;
  retainedEdgeResolutionCount: number;
}
