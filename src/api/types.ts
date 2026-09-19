import { defineValues, isRecord } from "../shared/validation";
import type { TargetName } from "./targets";

export { TARGET_NAMES } from "./targets";
export type { TargetName } from "./targets";

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
  "ECMASCRIPT_2015",
  "ECMASCRIPT_2016",
  "ECMASCRIPT_2017",
  "ECMASCRIPT_2018",
  "ECMASCRIPT_2019",
  "ECMASCRIPT_2020",
  "ECMASCRIPT_2021",
  "STABLE",
  "ECMASCRIPT_NEXT",
);
export type LanguageOut = (typeof LANGUAGE_OUTPUTS)[number];

export const CACHE_MODES = defineValues("off", "temp", "persistent");
export type CacheMode = (typeof CACHE_MODES)[number];

/**
 * `minimal` uses `--env CUSTOM` and a dependency-closed browser extern slice
 * for eligible ADVANCED jobs; delivered type metadata is not required.
 * Disabled type inference, polyfills, explicit environments, and unavailable
 * slices bypass slicing. A failed sliced compile can retry with full externs.
 * Non-browser targets use their own extern environment.
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
 * `auto` resolves to `esm` in chunked builds (including Vite), or `script`
 * in off mode. ES3/ES5 and worker gates force `script`.
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
   * This can reduce dependency invalidation across application edits, at the
   * cost of another chunk; stable output names are not guaranteed.
   *
   * `"auto"` resolves to `false`. Explicit `true` applies to either chunked
   * mode only when the resolved `outputType` is `"esm"`. Vite owns its chunk
   * graph and does not accept this option.
   */
  vendorChunk?: boolean | "auto" | undefined;
}

/** An entry file, optionally with an explicit output name and published path. */
export type BuildEntryOption =
  | string
  | { file: string; name?: string | undefined; outFile?: string | undefined };

/**
 * A runtime call whose object-literal argument keys must survive property
 * renaming (for example a framework's CSS class-map helper). Framework
 * presets supply these; the core stays framework-agnostic.
 */
export interface CompatClassMapCall {
  argIndex: number;
  callee: string;
  /**
   * Optional regex over the module specifier the callee binding was imported
   * from. Callee spelling is local (default imports and bundler aliases are
   * renamed freely), so import identity is what a rule can rely on.
   */
  calleeModulePattern?: string | undefined;
  /**
   * Where the pinned keys live in the matched argument:
   *
   * - `"objectLiteral"` (default) - keys of an object-literal argument, which
   *   are quoted so Closure keeps them;
   * - `"pairArray"` - the first element of each entry of an array-literal
   *   argument (`[["render", fn], ["__scopeId", id]]`), the shape helpers use
   *   to splat entries onto a target with `target[key] = value`. Those keys are
   *   already strings, so they are preserved instead of quoted. Entries fail
   *   closed: a hole, a spread, a non-array entry, or a non-literal first
   *   element contributes nothing.
   */
  keySource?: "objectLiteral" | "pairArray" | undefined;
  /**
   * Optional regex; keys matching it are left alone even when `keyPattern`
   * admits them. Patterns are compiled by Rust's `regex` crate, which has no
   * lookahead or backreferences; unsupported syntax fails the build.
   */
  keyExcludePattern?: string | undefined;
  /** Optional regex; when set, only matching keys are quoted. */
  keyPattern?: string | undefined;
  /**
   * When set, the rule applies only if the argument at this index is a string
   * literal or an immutable value produced by another matching literal-gated
   * call. Host-element provenance can therefore flow through transforms such
   * as `cloneElement` while component props remain renamable.
   */
  stringLiteralArgIndex?: number | undefined;
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

export interface BuildOptions {
  cache?: CacheOptions | undefined;
  chunks?: ChunkOptions | undefined;
  compat?: CompatOptions | undefined;
  compilationLevel?: CompilationLevel | undefined;
  diagnostics?: DiagnosticsOptions | undefined;
  /**
   * Paths forwarded to Closure `--hide_warnings_for`. `undefined` keeps the
   * silent-inference default (`["/"]`). `[]` keeps `jscomp_warning=checkTypes`
   * but reports the diagnostics.
   */
  hideWarningsFor?: readonly string[] | undefined;
  entries: readonly BuildEntryOption[];
  /**
   * Explicit externs keep their historical dual meaning: Closure consumes
   * them and native preservation scans them for rename barriers.
   */
  externals?: readonly string[] | undefined;
  externs?: readonly string[] | undefined;
  js?: readonly string[] | undefined;
  languageOut?: LanguageOut | undefined;
  outDir?: string | undefined;
  packages?: PackageMode | undefined;
  platformExterns?: PlatformExternsMode | undefined;
  /** Project-relative authored modules published without optimization or identifier renaming. */
  preserveModules?: readonly string[] | undefined;
  projectRoot?: string | undefined;
  srcDir?: string | undefined;
  /** Additive target policy; browser is the unchanged default. */
  target?: TargetName | undefined;
  /**
   * Closure-only typed declarations. Strings apply to every job; scoped entries
   * are configured source entry paths resolved against projectRoot.
   * Native preservation never scans these.
   */
  typedExterns?:
    | readonly (string | { path: string; entries: readonly string[] })[]
    | undefined;
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
    preflight: DiagnosticsPreflight;
    verbose: boolean;
  };
  hideWarningsFor: readonly string[] | undefined;
  /** Absolute entry file paths with explicit or `null` (derived) names. */
  entries: Array<{ file: string; name: string | null; outFile?: string }>;
  externals: string[];
  externs: string[];
  js: string[];
  languageOut: LanguageOut;
  outDir: string;
  packages: PackageMode;
  platformExterns: PlatformExternsMode;
  preserveModules: string[];
  projectRoot: string;
  srcDir: string;
  target: TargetName;
  typedExterns: Array<{ path: string; entryFiles: string[] }>;
}

function deepFreeze<T extends object>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if ((Array.isArray(child) || isRecord(child)) && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const DEFAULT_BUILD_OPTIONS = deepFreeze({
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
    preflight: "errors-only",
    verbose: false,
  },
  hideWarningsFor: undefined,
  entries: [],
  externals: [],
  externs: [],
  js: [],
  languageOut: "ECMASCRIPT_NEXT",
  outDir: "dist",
  packages: "esm-only",
  platformExterns: "minimal",
  preserveModules: [],
  projectRoot: undefined,
  srcDir: "src",
  target: "browser",
  typedExterns: [],
} satisfies BuildOptions);
