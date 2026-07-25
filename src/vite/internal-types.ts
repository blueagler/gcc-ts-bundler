import type { Rollup } from "vite";

export type NormalizedOutputOptions = Rollup.NormalizedOutputOptions;
export type OutputAsset = Rollup.OutputAsset;
export type OutputBundle = Rollup.OutputBundle;
export type OutputChunk = Rollup.OutputChunk;
export type PluginContext = Rollup.PluginContext;
export type PreRenderedChunk = Rollup.PreRenderedChunk;

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

export interface ViteWorkspaceLayout {
  captureRoot: string;
  coreOutDir: string;
  finalOutDir: string;
  materializedSrcDir: string;
  srcDir: string;
}

export interface CompiledCoreOutputSet {
  finalOutDir: string;
  outputFiles: string[];
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
