export { collectViteTypeMetadata } from "./collect";
export { resolveDeclarationOverlay } from "./declaration-overlay";
export {
  joinDeclarationAndRuntimeExports,
  parseRuntimeExportGraph,
  resolveRuntimeExportGraph,
} from "./export-graphs";
export { resolveRuntimeResolutionIdentity } from "./resolution-provenance";
export {
  classifyTypeMetadataSource,
  shouldBypassTypeMetadataFusion,
  withOneToOneTypeProvenance,
} from "./source-provenance";
export type * from "./types";
