export type {
  ClosureCompilerEnvironment,
  ClosureCompilerOptions,
} from "./compiler/environment-resolve";
export {
  configureClosureCompilerOptions,
  resolveClosureCompilerEnvironment,
} from "./compiler/environment-resolve";
export {
  TYPE_INFERENCE_OPTIONS,
  applyTypeInferenceOptions,
  hasStrictCheckTypes,
  omitEmptyHideWarningsFor,
  shouldEnableTypeInference,
  withExplicitHideWarningsFor,
} from "./compiler/environment-type-inference";
export {
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
} from "./compiler/run";
