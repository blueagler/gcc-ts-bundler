import type {
  BuildOptions,
  ResolvedBuildOptions as PublicResolvedBuildOptions,
} from "../api/types";
import type {
  ClosureTypeMetadataFile,
  TypeMetadataCounts,
} from "./transpile/closure-ir";
import type { FileStateSnapshot } from "../shared/file-state";
import { defineValues } from "../shared/validation";

export interface BuildTypeMetadataSidecar {
  dependencies: string[];
  diagnostics: readonly unknown[];
  extractedCounts: TypeMetadataCounts;
  files: ClosureTypeMetadataFile[];
}

/**
 * One chunk of the host bundler's own output graph.
 *
 * `fileName` is the identity: Rollup chunk names are not unique, file names
 * are, so import edges travel as file names too. `moduleFiles` are the
 * materialized source files of that chunk, relative to `srcDir` until the
 * resolver rebases them onto the build workspace.
 */
export interface RollupChunkInput {
  dynamicImportedChunkFileNames: string[];
  fileName: string;
  importedChunkFileNames: string[];
  isEntry: boolean;
  moduleFiles: string[];
  name: string;
}

export type InternalBuildOptions = BuildOptions & {
  /**
   * Whether the caller attaches CSS rows to the runtime manifest after the
   * compile. Only the Vite plugin does, and it answers from the CSS-ownership
   * scan it runs before compiling. Gates the `<link>` loader and the
   * per-chunk CSS fan-out out of the runtime preamble: a standalone build
   * never fills a CSS row, so shipping the loader is 797 dead bytes.
   */
  cssRuntime?: boolean | undefined;
  /** Vite runs this after its URL and import finalization instead. */
  finalMinify?: boolean | undefined;
  /**
   * The host bundler's final chunk layout. Only the Vite plugin has one, and
   * when it does the planner mirrors it instead of deriving its own
   * boundaries, so Closure optimizes inside a split that already ships.
   */
  rollupChunks?: readonly RollupChunkInput[] | undefined;
  typeMetadata?: BuildTypeMetadataSidecar | undefined;
};

export interface ResolvedBuildOptions extends PublicResolvedBuildOptions {
  cssRuntime: boolean;
  finalMinify: boolean;
  rollupChunks: readonly RollupChunkInput[];
  typeMetadata: BuildTypeMetadataSidecar | undefined;
}

export interface BuildEntry {
  chunkName: string;
  exportNames: string[];
  hasDefaultExport: boolean;
  outputName: string;
  sourcePath: string;
  sourceRelativePath: string;
}

export interface PackageAlias {
  packageName: string;
  subpath: string;
  targetPath: string;
}

export interface ExternalBoundary {
  importerFilePath: string;
  specifier: string;
}

export interface ResolvedImport {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

export interface PreservedImport {
  boundaryExports: string[];
  boundaryNames: string[];
  externalSpecifier?: string | undefined;
  importClause: string;
  importerFilePath: string;
  targetModuleId: string;
}

export interface PreservedModule {
  exportNames: string[];
  filePath: string;
  hasDefaultExport: boolean;
  moduleId: string;
  outputRelativePath: string;
}

export const CHUNK_KINDS = defineValues(
  "base",
  "entry",
  "lazy",
  "shared",
  "vendor",
);
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface ChunkPlanChunk {
  dependencies: string[];
  entryFiles?: string[];
  files: string[];
  kind?: ChunkKind;
  lazyModuleIds?: string[];
  name: string;
  outputName?: string;
}

export interface LazyImport {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

export interface BuildContext {
  options: ResolvedBuildOptions;
  optionsSignature: string;
  packageRoot: string;
  packageSignature: string;
  projectCacheDir: string;
}

export interface ResolvedBuild {
  cleanup(): Promise<void>;
  chunkPlan: ChunkPlanChunk[];
  entryFiles: BuildEntry[];
  externalBoundaries: ExternalBoundary[];
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  lazyImports: LazyImport[];
  resolvedImports: ResolvedImport[];
  sourceFiles: string[];
  tsxRuntimeSourceFiles: string[];
  finalCacheDir: string;
  finalKey: string;
  nativeEmitCacheDir: string;
  shimDir: string;
  shimFiles: string[];
  trackedFiles: Record<string, FileStateSnapshot>;
  tsConfigPath: string;
  workspaceDir: string;
}
