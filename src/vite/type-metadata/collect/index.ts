import path from "node:path";

import type { MaterializedGraph } from "../../internal-types";
import { finalizeSidecar } from "../fusion";
import type {
  ViteTypeMetadataDiagnostic,
  ViteTypeMetadataSidecar,
} from "../types";
import { analyzeViteTypeMetadata } from "./analyze";
import { assembleViteTypeMetadataFiles } from "./assemble";
import { collectOverlayAttachments, readRuntimeModuleSources } from "./overlay";
import { collectMaterializedExternalGlobalProtocol } from "./protocol";
import { collectDirectTargets } from "./targets";

export async function collectViteTypeMetadata(input: {
  materialized: MaterializedGraph;
  projectRoot: string;
  sourceGraph?: MaterializedGraph | undefined;
}): Promise<ViteTypeMetadataSidecar> {
  const sourceGraph = input.sourceGraph ?? input.materialized;
  const diagnostics: ViteTypeMetadataDiagnostic[] = [];
  const dependencies = new Set<string>();
  const externalGlobalProtocol =
    await collectMaterializedExternalGlobalProtocol(input.materialized);
  for (const filePath of externalGlobalProtocol.filePaths) {
    dependencies.add(filePath);
  }

  const directTargets = await collectDirectTargets({
    materialized: input.materialized,
    diagnostics,
    dependencies,
  });
  const sourceTextByModuleId = await readRuntimeModuleSources(
    sourceGraph.modules,
    dependencies,
    diagnostics,
  );
  const overlayAttachments = await collectOverlayAttachments({
    diagnostics,
    input,
    sourceGraph,
    sourceTextByModuleId,
  });
  for (const overlay of overlayAttachments.results) {
    for (const cacheFile of overlay.cacheFiles) {
      dependencies.add(path.normalize(cacheFile));
    }
  }

  const analysis = await analyzeViteTypeMetadata({
    projectRoot: input.projectRoot,
    diagnostics,
    dependencies,
    directTargets,
    overlayAttachments,
    externalGlobalFiles: externalGlobalProtocol.files,
  });
  if (analysis.status === "done") {
    return analysis.sidecar;
  }

  const files = await assembleViteTypeMetadataFiles({
    diagnostics,
    directTargets,
    analysisFiles: analysis.files,
    overlayMetadataBySource: analysis.overlayMetadataBySource,
    overlayPlans: overlayAttachments.plans,
  });

  return finalizeSidecar({
    dependencies,
    diagnostics,
    files: files.concat(externalGlobalProtocol.files),
  });
}
