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
  generateExterns,
  type ExternsProtocolHelpers,
  type GenerateExternsMode,
  type GenerateExternsOptions,
  type GenerateExternsResult,
} from "./generate";
