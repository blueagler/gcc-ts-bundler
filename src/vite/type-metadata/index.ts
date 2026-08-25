export { collectViteTypeMetadata } from "./collect";
export { resolveDeclarationOverlay } from "./declaration-overlay";
export {
  joinDeclarationAndRuntimeExports,
  parseRuntimeExportGraph,
  resolveRuntimeExportGraph,
} from "./export-graphs";
export { resolveRuntimeResolutionIdentity } from "./provenance";
export {
  classifyTypeMetadataSource,
  shouldBypassTypeMetadataFusion,
  withOneToOneTypeProvenance,
} from "./provenance";
export type * from "./types";
