export {
  build,
  cleanCache,
  main,
  normalizeBuildOptions,
  resolveBuild,
  runCli,
} from "../api/build";
export { parseCliArgs } from "../cli/parse-options";
export { DEFAULT_BUILD_OPTIONS } from "../api/types";
export type {
  BuildEntry,
  BuildOptions,
  BuildResult,
  CacheMode,
  CacheOptions,
  CleanCacheOptions,
  CliParseResult,
  CompilationLevel,
  DiagnosticsOptions,
  DiagnosticsPreflight,
  LanguageOut,
  NormalizedBuildOptions,
  PostProcessMinify,
  PostProcessOptions,
  ResolvedBuild,
} from "../api/types";
