export type CompilationLevel = "WHITESPACE_ONLY" | "SIMPLE" | "ADVANCED";
export type LanguageOut =
  | "ECMASCRIPT3"
  | "ECMASCRIPT5"
  | "ECMASCRIPT6"
  | "ECMASCRIPT_NEXT";
export type CacheMode = "off" | "temp" | "persistent";
export type DiagnosticsPreflight = "off" | "errors-only" | "full";
export type PostProcessMinify = false | "swc";

export interface CacheOptions {
  dir?: string;
  mode?: CacheMode;
}

export interface DiagnosticsOptions {
  fatalWarnings?: boolean;
  preflight?: DiagnosticsPreflight;
  verbose?: boolean;
}

export interface PostProcessOptions {
  minify?: PostProcessMinify;
  rewriteExports?: boolean;
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
  postProcess?: PostProcessOptions;
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
  postProcess: Required<PostProcessOptions>;
  projectRoot: string;
  srcDir: string;
}

export interface CleanCacheOptions {
  cacheDir?: string;
  projectRoot?: string;
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
  isResolveCacheHit: boolean;
  isTsickleCacheHit: boolean;
  options: NormalizedBuildOptions;
  packageRoot: string;
  packageVersion: string;
  projectCacheDir: string;
  resolveKey: string;
  resolveMetadataPath: string;
  sharedChunkName: string | null;
  shimDir: string;
  shimFiles: string[];
  sourceRoot: string;
  tsConfigPath: string;
  tsickleCacheDir: string;
  tsickleKey: string;
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

export declare const DEFAULT_BUILD_OPTIONS: Readonly<NormalizedBuildOptions>;

export declare function build(options: BuildOptions): Promise<BuildResult>;
export declare function cleanCache(options?: CleanCacheOptions): Promise<void>;
export declare function main(args: string[]): Promise<number>;
export declare function normalizeBuildOptions(
  options: BuildOptions,
): NormalizedBuildOptions;
export declare function parseCliArgs(args: string[]): CliParseResult;
export declare function resolveBuild(
  options: NormalizedBuildOptions,
): Promise<ResolvedBuild>;
export declare function runCli(args: string[]): Promise<number>;
