export type {
  ClosureCompilerEnvironment,
  ClosureCompilerOption,
  ClosureCompilerOptions,
} from "./compiler/environment";
export {
  TYPE_INFERENCE_OPTIONS,
  applyTypeInferenceOptions,
  configureClosureCompilerOptions,
  hasStrictCheckTypes,
  omitEmptyHideWarningsFor,
  resolveClosureCompilerEnvironment,
  shouldEnableTypeInference,
  withExplicitHideWarningsFor,
} from "./compiler/environment";
export {
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
} from "./compiler/run";
