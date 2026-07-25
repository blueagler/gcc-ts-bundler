import { defineValues } from "../shared/validation";

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

export interface BuildDiagnostic {
  file?: string | undefined;
  line?: number | undefined;
  message: string;
}

export interface BuildSuccess {
  cacheHit: boolean;
  ok: true;
  outputFiles: readonly string[];
}

export interface BuildFailure {
  diagnostics: readonly BuildDiagnostic[];
  ok: false;
}

export type BuildResult = BuildFailure | BuildSuccess;

/** `BuildOptions` after defaulting and path resolution: every field present. */
export interface ResolvedBuildOptions {
  cache: { dir: string; mode: CacheMode };
  chunks: {
    baseChunkName: string;
    loader: ChunkLoader;
    manifestFile: string;
    mode: ChunkMode;
    publicPath: string;
  };
  compilationLevel: CompilationLevel;
  diagnostics: {
    fatalWarnings: boolean;
    preflight: DiagnosticsPreflight;
    verbose: boolean;
  };
  entries: string[];
  externs: string[];
  js: string[];
  languageOut: LanguageOut;
  outDir: string;
  outputNames: string[];
  packages: { mode: PackageMode };
  projectRoot: string;
  srcDir: string;
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
} satisfies ResolvedBuildOptions);
