import type {
  BuildOptions,
  CacheOptions,
  ChunkOptions,
  CompilationLevel,
  DiagnosticsOptions,
  LanguageOut,
  PackageOptions,
} from "../api/types";
import type { FileStateSnapshot } from "./file-state";

export interface NormalizedBuildOptions {
  cache: Required<CacheOptions>;
  chunks: Required<ChunkOptions>;
  compilationLevel: CompilationLevel;
  diagnostics: Required<DiagnosticsOptions>;
  entries: string[];
  externs: string[];
  js: string[];
  languageOut: LanguageOut;
  outDir: string;
  outputNames: string[];
  packages: Required<PackageOptions>;
  projectRoot: string;
  srcDir: string;
}

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

export interface ChunkPlanChunk {
  dependencies: string[];
  entryFiles?: string[];
  files: string[];
  kind?: "base" | "entry" | "lazy" | "shared";
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
  options: NormalizedBuildOptions;
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
