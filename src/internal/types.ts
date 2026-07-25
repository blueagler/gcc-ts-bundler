import type { BuildOptions, ResolvedBuildOptions } from "../api/types";
import { defineValues } from "./validation";

export type { ResolvedBuildOptions } from "../api/types";
import type { FileStateSnapshot } from "./file-state";

export interface CliParseResult {
  options: BuildOptions;
  showHelp: boolean;
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

export const CHUNK_KINDS = defineValues("base", "entry", "lazy", "shared");
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export interface ChunkPlanChunk {
  dependencies: string[];
  entryFiles?: string[];
  files: string[];
  kind?: ChunkKind;
  lazyModuleIds?: string[];
  name: string;
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
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  lazyImports: LazyImport[];
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
