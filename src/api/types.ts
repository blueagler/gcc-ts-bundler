export type CompilationLevel = "WHITESPACE_ONLY" | "SIMPLE" | "ADVANCED";
export type LanguageOut =
  | "ECMASCRIPT3"
  | "ECMASCRIPT5"
  | "ECMASCRIPT6"
  | "ECMASCRIPT_NEXT";
export type CacheMode = "off" | "temp" | "persistent";
export type DiagnosticsPreflight = "off" | "errors-only" | "full";
export type PackageMode = "off" | "esm-only";

export interface CacheOptions {
  dir?: string;
  mode?: CacheMode;
}

export interface DiagnosticsOptions {
  fatalWarnings?: boolean;
  preflight?: DiagnosticsPreflight;
  verbose?: boolean;
}

export interface PackageOptions {
  mode?: PackageMode;
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
  outputNames?: string[];
  packages?: PackageOptions;
  projectRoot?: string;
  srcDir?: string;
}

export interface CleanCacheOptions {
  cacheDir?: string;
  projectRoot?: string;
}

export interface BuildResult {
  cacheHit: boolean;
  diagnostics: unknown[];
  emitSkipped: boolean;
  exitCode: number;
  outputFiles: string[];
}

export const DEFAULT_BUILD_OPTIONS = Object.freeze({
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
  entries: [] as string[],
  externs: [] as string[],
  js: [] as string[],
  languageOut: "ECMASCRIPT_NEXT" as LanguageOut,
  outDir: "",
  outputNames: [] as string[],
  packages: {
    mode: "esm-only" as PackageMode,
  },
  projectRoot: "",
  srcDir: "",
});
