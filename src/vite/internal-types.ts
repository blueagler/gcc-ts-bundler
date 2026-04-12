export interface CapturedModule {
  code: string;
  id: string;
}

export interface CapturedRuntimeModule {
  filePath: string;
  id: string;
  relativePath: string;
}

export interface MaterializedGraph {
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
