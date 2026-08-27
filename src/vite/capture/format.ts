export type { CapturedModuleResolutionCache } from "./specifiers";
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
} from "../capture-analysis";
