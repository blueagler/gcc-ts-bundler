export type {
  ExternModuleInput,
  ExternRuntimePlacement,
  ExternTypeDiagnostic,
  GeneratedExternArtifact,
  GeneratedExternExport,
  GeneratedExternModule,
  GeneratedRenameBarrierArtifact,
  GeneratedTypedExternArtifact,
} from "./types";
export { auditExternFiles } from "./barriers";
export {
  EXTERN_MODES,
  type ExternsProtocolHelpers,
  type GenerateExternsMode,
  type GenerateExternsOptions,
  type GenerateExternsResult,
} from "./generate/options";
export { generateExterns } from "./generate/generate";
