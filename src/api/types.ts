export type CompilationLevel = "WHITESPACE_ONLY" | "SIMPLE" | "ADVANCED";
export type LanguageOut =
  | "ECMASCRIPT3"
  | "ECMASCRIPT5"
  | "ECMASCRIPT6"
  | "ECMASCRIPT_NEXT";
export type CacheMode = "off" | "temp" | "persistent";
export type DiagnosticsPreflight = "off" | "errors-only" | "full";

export interface CacheOptions {
  dir?: string;
  mode?: CacheMode;
}

export interface DiagnosticsOptions {
  fatalWarnings?: boolean;
  preflight?: DiagnosticsPreflight;
  verbose?: boolean;
}

export interface BuildOptions {
  cache?: CacheOptions;
  compilationLevel?: CompilationLevel;
  diagnostics?: DiagnosticsOptions;
  entries: string[];
  externs?: string[];
  js?: string[];
  languageOut?: LanguageOut;
  outDir?: string;
  projectRoot?: string;
  srcDir?: string;
}

export interface NormalizedBuildOptions {
  cache: Required<CacheOptions>;
  compilationLevel: CompilationLevel;
  diagnostics: Required<DiagnosticsOptions>;
  entries: string[];
  externs: string[];
  js: string[];
  languageOut: LanguageOut;
  outDir: string;
  projectRoot: string;
  srcDir: string;
}

export interface CliParseResult {
  options: BuildOptions;
  showHelp: boolean;
}

export interface CleanCacheOptions {
  cacheDir?: string;
  projectRoot?: string;
}

export interface BuildEntry {
  chunkName: string;
  exportNames: string[];
  hasDefaultExport: boolean;
  outputName: string;
  outputPath: string;
  sourcePath: string;
  sourceRelativePath: string;
}

export interface ResolvedBuild {
  cacheRoot: string;
  cleanup(): Promise<void>;
  compilerOptions: Record<string, unknown>;
  entryFiles: BuildEntry[];
  externalInputHash: string;
  fileHashes: Record<string, string>;
  filePaths: string[];
  finalCacheDir: string;
  finalKey: string;
  graph: Record<string, string[]>;
  isFinalCacheHit: boolean;
  isNativeEmitCacheHit: boolean;
  isResolveCacheHit: boolean;
  options: NormalizedBuildOptions;
  packageRoot: string;
  packageVersion: string;
  projectCacheDir: string;
  resolveKey: string;
  resolveMetadataPath: string;
  sharedChunkName: null | string;
  shimDir: string;
  shimFiles: string[];
  sourceRoot: string;
  tsConfigPath: string;
  nativeEmitCacheDir: string;
  nativeEmitKey: string;
  workspaceDir: string;
}

export interface BuildResult {
  cacheHit: boolean;
  diagnostics: unknown[];
  emitSkipped: boolean;
  exitCode: number;
  options: NormalizedBuildOptions;
  outputFiles: string[];
  workspaceDir: string;
}

export const DEFAULT_BUILD_OPTIONS: Readonly<NormalizedBuildOptions> =
  Object.freeze({
    cache: {
      dir: "",
      mode: "persistent" as CacheMode,
    },
    compilationLevel: "ADVANCED" as CompilationLevel,
    diagnostics: {
      fatalWarnings: false,
      preflight: "errors-only" as DiagnosticsPreflight,
      verbose: false,
    },
    entries: [],
    externs: [],
    js: [],
    languageOut: "ECMASCRIPT_NEXT" as LanguageOut,
    outDir: "",
    projectRoot: "",
    srcDir: "",
  });
