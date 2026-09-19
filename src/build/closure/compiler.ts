export type {
  ClosureCompilerEnvironment,
  ClosureCompilerOptions,
} from "./compiler/environment-resolve";
export {
  configureClosureCompilerOptions,
  resolveClosureCompilerEnvironment,
} from "./compiler/environment-resolve";
export {
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
