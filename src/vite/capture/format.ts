export type {
  CapturedModuleResolution,
  CapturedModuleResolutionCache,
} from "./specifiers";
export {
  classifyModuleId,
  isAuthoredModuleId,
  isDependencyModuleId,
  isSupportedExternalSpecifier,
  resolveCapturedSpecifier,
  stripQuery,
  toMaterializedRelativePath,
  toRelativeImportSpecifier,
} from "./specifiers";
export {
  analyzeModuleCode,
  getCapturedModuleAnalysis,
  resolveCapturedModuleFormat,
  resolveScriptKind,
} from "../capture-analysis";
