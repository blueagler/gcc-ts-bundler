export type {
  ClosureCompilerEnvironment,
  ClosureCompilerOptions,
} from "./environment-resolve";
export {
  configureClosureCompilerOptions,
  resolveClosureCompilerEnvironment,
} from "./environment-resolve";
export {
  TYPE_INFERENCE_OPTIONS,
  applyTypeInferenceOptions,
  hasStrictCheckTypes,
  omitEmptyHideWarningsFor,
  shouldEnableTypeInference,
  withExplicitHideWarningsFor,
} from "./environment-type-inference";
