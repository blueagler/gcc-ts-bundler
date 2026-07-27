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

/**
 * `minimal` compiles with `--env CUSTOM` plus a generated flat externs file
 * covering only the platform globals and properties the program references,
 * instead of Closure's full multi-megabyte browser externs. This roughly
 * halves Closure compile time. On any compile error the build automatically
 * retries with the full browser externs.
 */
export const PLATFORM_EXTERNS_MODES = defineValues("minimal", "full");
export type PlatformExternsMode = (typeof PLATFORM_EXTERNS_MODES)[number];

export const DIAGNOSTICS_PREFLIGHT_MODES = defineValues(
  "off",
  "errors-only",
  "full",
);
export type DiagnosticsPreflight = (typeof DIAGNOSTICS_PREFLIGHT_MODES)[number];

export const PACKAGE_MODES = defineValues("off", "esm-only");
export type PackageMode = (typeof PACKAGE_MODES)[number];

export const CHUNK_MODES = defineValues("off", "bundler-runtime", "split");
export type ChunkMode = (typeof CHUNK_MODES)[number];

/**
 * Shape of the emitted chunk boundary.
 *
 * `script` is Closure's `GLOBAL_NAMESPACE` output: plain scripts sharing one
 * `$gcc` namespace object, loaded by injecting `<script>` elements.
 * `esm` is Closure's `ES_MODULES` output: native `import`/`export` between
 * chunks, loaded with dynamic `import()`.
 * `auto` picks `esm` wherever it is safe (see `resolveChunkOutputType`).
 */
export const CHUNK_OUTPUT_TYPES = defineValues("auto", "script", "esm");
export type ChunkOutputType = (typeof CHUNK_OUTPUT_TYPES)[number];

/** `ChunkOutputType` after the `auto` gates have been applied. */
export type ResolvedChunkOutputType = Exclude<ChunkOutputType, "auto">;

export interface CacheOptions {
  dir?: string | undefined;
  mode?: CacheMode | undefined;
}

export interface DiagnosticsOptions {
  fatalWarnings?: boolean | undefined;
  preflight?: DiagnosticsPreflight | undefined;
  verbose?: boolean | undefined;
}

export interface ChunkOptions {
  baseChunkName?: string | undefined;
  manifestFile?: string | undefined;
  mode?: ChunkMode | undefined;
  outputType?: ChunkOutputType | undefined;
  publicPath?: string | undefined;
  /**
   * Move eagerly reachable dependency modules out of the base chunk into a
   * separate `<baseChunkName>-vendor` chunk.
   *
   * Under ES module output the base chunk's name is embedded in every other
   * chunk's `import` statement, so any edit to app code re-hashes the base
   * chunk and cascades new file names through the whole graph. Splitting the
   * dependency half out means an app edit only re-hashes the entry, and the
   * vendor and lazy chunks keep their names (and their cache entries).
   *
   * `"auto"` (the default) enables it exactly where it works: `bundler-runtime`
   * chunks whose resolved `outputType` is `"esm"`.
   */
  vendorChunk?: boolean | "auto" | undefined;
}

/** An entry file, optionally with an explicit output name. */
export type BuildEntryOption =
  | string
  | { file: string; name?: string | undefined };

/**
 * A runtime call whose object-literal argument keys must survive property
 * renaming (for example a framework's CSS class-map helper). Framework
 * presets supply these; the core stays framework-agnostic.
 */
export interface CompatClassMapCall {
  argIndex: number;
  callee: string;
  /** Optional regex; when set, only matching keys are quoted. */
  keyPattern?: string | undefined;
}

export interface CompatOptions {
  classMapCalls?: readonly CompatClassMapCall[] | undefined;
  /**
   * Callees whose results have no side effects (framework template
   * builders). Declarations initialized by them are annotated
   * `@pureOrBreakMyCode`, which is what lets Closure's cross-chunk code
   * motion sink them out of the entry chunk into the chunk that uses them.
   */
  pureCallees?: readonly string[] | undefined;
}

/**
 * One top-level binding of a module, paired with the JSDoc block to emit
 * immediately before its declaration.
 *
 * Type references inside `jsdoc` use **pre-suffix** names: hoisted emission
 * renames every top-level binding to `name$$ordinal`, and the native emitter
 * rewrites same-module type references inside the block to match. Only types
 * declared in the same module may be referenced.
 */
/** One class member's JSDoc, rendered before that member in the class body. */
export interface TypedAnnotationMember {
  /** Complete JSDoc block ending in a newline. */
  jsdoc: string;
  /** Member key as authored; computed and quoted keys are never matched. */
  name: string;
}

export interface TypedAnnotationBinding {
  /** Top-level binding name as authored, before the `$$` hoist suffix. */
  name: string;
  /** Complete JSDoc block ending in a newline, or `""` for a binding that
   * takes no block of its own (a class: Closure reads ES6 `class` structure
   * natively and rejects `@constructor` on one). */
  jsdoc: string;
  /** Per-member JSDoc when the binding is a class. */
  members?: readonly TypedAnnotationMember[] | undefined;
}

/** Typed annotations for one materialized module fed to native emit. */
export interface TypedAnnotationFile {
  bindings: readonly TypedAnnotationBinding[];
  /** Absolute path of the materialized module native emit reads. */
  filePath: string;
}

export interface BuildOptions {
  cache?: CacheOptions | undefined;
  chunks?: ChunkOptions | undefined;
  compat?: CompatOptions | undefined;
  compilationLevel?: CompilationLevel | undefined;
  diagnostics?: DiagnosticsOptions | undefined;
  entries: readonly BuildEntryOption[];
  externs?: readonly string[] | undefined;
  js?: readonly string[] | undefined;
  languageOut?: LanguageOut | undefined;
  outDir?: string | undefined;
  packages?: PackageMode | undefined;
  platformExterns?: PlatformExternsMode | undefined;
  projectRoot?: string | undefined;
  srcDir?: string | undefined;
  /**
   * Internal: TypeScript-derived JSDoc for materialized modules, produced by
   * the Vite stage. Not part of the public option surface.
   */
  typedAnnotations?: readonly TypedAnnotationFile[] | undefined;
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
    manifestFile: string;
    mode: ChunkMode;
    /** Requested value; apply `resolveChunkOutputType` before use. */
    outputType: ChunkOutputType;
    publicPath: string;
    /** Already gated: `"auto"` has been resolved against mode and output type. */
    vendorChunk: boolean;
  };
  compat: { classMapCalls: CompatClassMapCall[]; pureCallees: string[] };
  compilationLevel: CompilationLevel;
  diagnostics: {
    fatalWarnings: boolean;
    preflight: DiagnosticsPreflight;
    verbose: boolean;
  };
  /** Absolute entry file paths with explicit or `null` (derived) names. */
  entries: Array<{ file: string; name: string | null }>;
  externs: string[];
  js: string[];
  languageOut: LanguageOut;
  outDir: string;
  packages: PackageMode;
  platformExterns: PlatformExternsMode;
  projectRoot: string;
  srcDir: string;
  typedAnnotations: TypedAnnotationFile[];
}

export const DEFAULT_BUILD_OPTIONS = Object.freeze({
  cache: {
    dir: "",
    mode: "persistent",
  },
  chunks: {
    baseChunkName: "main",
    manifestFile: "",
    mode: "off",
    outputType: "auto",
    publicPath: "./",
    vendorChunk: false,
  },
  compat: { classMapCalls: [], pureCallees: [] },
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
  packages: "esm-only",
  platformExterns: "minimal",
  projectRoot: "",
  srcDir: "",
  typedAnnotations: [],
} satisfies ResolvedBuildOptions);
