export { collectViteTypeMetadata } from "./collect";
export { resolveDeclarationOverlays } from "./declaration-overlay";
export {
  joinDeclarationAndRuntimeExports,
  resolveRuntimeExportGraph,
} from "./export-graphs";
export { resolveRuntimeResolutionIdentity } from "./provenance";
export {
  classifyTypeMetadataSource,
  shouldBypassTypeMetadataFusion,
  withOneToOneTypeProvenance,
} from "./provenance";
export type * from "./types";
