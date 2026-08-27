import type { CompilerExternArtifacts } from "../compiler-externs";
import type {
  ManifestFileSettings,
  MaterializedGraph,
  OutputChunk,
  ViteAssetPlaceholder,
  ViteCssOwnership,
} from "../internal-types";
import type { ViteTypeMetadataSidecar } from "../type-metadata";

export { compileViteGraph, emitViteGraph } from "../plugin-compile";
export { prepareViteGraph } from "./prepare";

export interface ViteTimingTotals {
  cssAnalysisMs: number;
  cssAugmentMs: number;
  dependencyPrebundleMs: number;
  emitOutputsMs: number;
  externsMs: number;
  materializeMs: number;
  normalizeRetainedMs: number;
  retainedResolutionMs: number;
  transformCaptureMs: number;
  typeMetadataMs: number;
}

export interface PreparedViteGraph {
  assetPlaceholders: ViteAssetPlaceholder[];
  captureRoot: string;
  coreOutDir: string;
  cssOwnership: ViteCssOwnership;
  dynamicRootModuleIds: string[];
  externs: CompilerExternArtifacts;
  finalOutDir: string;
  jsChunks: OutputChunk[];
  manifestSettings: ManifestFileSettings;
  materialized: MaterializedGraph;
  publicPath: string;
  typeMetadata: ViteTypeMetadataSidecar;
}
