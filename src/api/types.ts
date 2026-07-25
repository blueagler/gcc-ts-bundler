import { defineValues } from "../internal/validation";

export const COMPILATION_LEVELS = defineValues(
  "WHITESPACE_ONLY",
  "SIMPLE",
  "ADVANCED",
);
export type CompilationLevel = (typeof COMPILATION_LEVELS)[number];

export const LANGUAGE_OUTPUTS = defineValues(
  "ECMASCRIPT3",
  "ECMASCRIPT5",
  "ECMASCRIPT6",
  "ECMASCRIPT_NEXT",
);
export type LanguageOut = (typeof LANGUAGE_OUTPUTS)[number];

export const CACHE_MODES = defineValues("off", "temp", "persistent");
export type CacheMode = (typeof CACHE_MODES)[number];

export const DIAGNOSTICS_PREFLIGHT_MODES = defineValues(
  "off",
  "errors-only",
  "full",
);
export type DiagnosticsPreflight = (typeof DIAGNOSTICS_PREFLIGHT_MODES)[number];

export const PACKAGE_MODES = defineValues("off", "esm-only");
export type PackageMode = (typeof PACKAGE_MODES)[number];

export const CHUNK_MODES = defineValues("off", "bundler-runtime");
export type ChunkMode = (typeof CHUNK_MODES)[number];

export const CHUNK_LOADERS = defineValues("script");
export type ChunkLoader = (typeof CHUNK_LOADERS)[number];

export interface CacheOptions {
  dir?: string | undefined;
  mode?: CacheMode | undefined;
}

export interface DiagnosticsOptions {
  fatalWarnings?: boolean | undefined;
  preflight?: DiagnosticsPreflight | undefined;
  verbose?: boolean | undefined;
}

export interface PackageOptions {
  mode?: PackageMode | undefined;
}

export interface ChunkOptions {
  baseChunkName?: string | undefined;
  loader?: ChunkLoader | undefined;
  manifestFile?: string | undefined;
  mode?: ChunkMode | undefined;
  publicPath?: string | undefined;
}

export interface BuildOptions {
  cache?: CacheOptions | undefined;
  chunks?: ChunkOptions | undefined;
  compilationLevel?: CompilationLevel | undefined;
  diagnostics?: DiagnosticsOptions | undefined;
  entries: readonly string[];
  externs?: readonly string[] | undefined;
  js?: readonly string[] | undefined;
  languageOut?: LanguageOut | undefined;
  outDir?: string | undefined;
  outputNames?: readonly string[] | undefined;
  packages?: PackageOptions | undefined;
  projectRoot?: string | undefined;
  srcDir?: string | undefined;
}

export interface CleanCacheOptions {
  cacheDir?: string | undefined;
  projectRoot?: string | undefined;
}

export interface BuildResult {
  cacheHit: boolean;
  diagnostics: readonly unknown[];
  emitSkipped: boolean;
  exitCode: number;
  outputFiles: readonly string[];
}

interface BuildDefaults {
  readonly cache: { readonly dir: string; readonly mode: CacheMode };
  readonly chunks: {
    readonly baseChunkName: string;
    readonly loader: ChunkLoader;
    readonly manifestFile: string;
    readonly mode: ChunkMode;
    readonly publicPath: string;
  };
  readonly compilationLevel: CompilationLevel;
  readonly diagnostics: {
    readonly fatalWarnings: boolean;
    readonly preflight: DiagnosticsPreflight;
    readonly verbose: boolean;
  };
  readonly entries: readonly string[];
  readonly externs: readonly string[];
  readonly js: readonly string[];
  readonly languageOut: LanguageOut;
  readonly outDir: string;
  readonly outputNames: readonly string[];
  readonly packages: { readonly mode: PackageMode };
  readonly projectRoot: string;
  readonly srcDir: string;
}

export const DEFAULT_BUILD_OPTIONS = Object.freeze({
  cache: {
    dir: "",
    mode: "persistent",
  },
  chunks: {
    baseChunkName: "main",
    loader: "script",
    manifestFile: "",
    mode: "off",
    publicPath: "./",
  },
  compilationLevel: "ADVANCED",
  diagnostics: {
    fatalWarnings: false,
    preflight: "errors-only",
    verbose: false,
  },
  entries: [],
  externs: [],
  js: [],
  languageOut: "ECMASCRIPT_NEXT",
  outDir: "",
  outputNames: [],
  packages: {
    mode: "esm-only",
  },
  projectRoot: "",
  srcDir: "",
} satisfies BuildDefaults);
