import path from "node:path";

import {
  collectFileStates,
  matchFileStates,
  type NativeFileStateEntry,
} from "../../../native/load";
import { logInternalDetail } from "../../../shared/timing";
import type { MaterializedGraph } from "../../internal-types";
import type { GccTsBundlerVitePluginOptions } from "../../types";
import {
  hashTypeMetadataSidecarDiskKey,
  hashTypeMetadataSidecarKey,
  readCachedViteTypeMetadataSidecar,
  resolveViteTypeMetadataCacheRoot,
  writeCachedViteTypeMetadataSidecar,
} from "../cache";
import { finalizeSidecar } from "../fusion";
import type {
  ViteTypeMetadataDiagnostic,
  ViteTypeMetadataSidecar,
} from "../types";
import { analyzeViteTypeMetadata } from "./analyze";
import { assembleViteTypeMetadataFiles } from "./assemble";
import { collectOverlayAttachments } from "./overlay";
import { collectMaterializedExternalGlobalProtocol } from "./protocol";
import { collectDirectTargets } from "./targets";

let typeMetadataSidecarMemo:
  | {
      dependencyStates: NativeFileStateEntry[];
      key: string;
      sidecar: ViteTypeMetadataSidecar;
    }
  | undefined;

export async function collectViteTypeMetadata(input: {
  cache?:
    | {
        captureRoot: string;
        options: GccTsBundlerVitePluginOptions;
      }
    | undefined;
  materialized: MaterializedGraph;
  projectRoot: string;
  sourceGraph?: MaterializedGraph | undefined;
}): Promise<ViteTypeMetadataSidecar> {
  const sourceGraph = input.sourceGraph ?? input.materialized;
  const key = hashTypeMetadataSidecarKey({
    materialized: input.materialized,
    projectRoot: input.projectRoot,
    sourceGraph,
  });
  if (
    typeMetadataSidecarMemo !== undefined &&
    typeMetadataSidecarMemo.key === key &&
    matchFileStates(typeMetadataSidecarMemo.dependencyStates)
  ) {
    return typeMetadataSidecarMemo.sidecar;
  }
  const diskCache =
    input.cache === undefined
      ? undefined
      : {
          key: await hashTypeMetadataSidecarDiskKey({
            projectRoot: input.projectRoot,
            sidecarKey: key,
          }),
          root: resolveViteTypeMetadataCacheRoot({
            captureRoot: input.cache.captureRoot,
            options: input.cache.options,
            projectRoot: input.projectRoot,
          }),
        };
  if (diskCache !== undefined) {
    const cached = await readCachedViteTypeMetadataSidecar({
      cacheRoot: diskCache.root,
      key: diskCache.key,
    });
    if (cached !== undefined && matchFileStates(cached.dependencyStates)) {
      typeMetadataSidecarMemo = {
        dependencyStates: cached.dependencyStates,
        key,
        sidecar: cached.sidecar,
      };
      logInternalDetail("cache:vite-type-metadata", "hit");
      return cached.sidecar;
    }
    logInternalDetail("cache:vite-type-metadata", "miss");
  }

  async function rememberSidecar(sidecar: ViteTypeMetadataSidecar) {
    const dependencyStates = collectFileStates(sidecar.dependencies);
    typeMetadataSidecarMemo = {
      dependencyStates,
      key,
      sidecar,
    };
    if (diskCache !== undefined) {
      await writeCachedViteTypeMetadataSidecar({
        cacheRoot: diskCache.root,
        dependencyStates,
        key: diskCache.key,
        sidecar,
      });
    }
    return sidecar;
  }

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
  const overlayAttachments = await collectOverlayAttachments({
    dependencies,
    diagnostics,
    input,
    sourceGraph,
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
    return await rememberSidecar(analysis.sidecar);
  }

  const files = await assembleViteTypeMetadataFiles({
    diagnostics,
    directTargets,
    analysisFiles: analysis.files,
    overlayMetadataBySource: analysis.overlayMetadataBySource,
    overlayPlans: overlayAttachments.plans,
  });

  const sidecar = finalizeSidecar({
    dependencies,
    diagnostics,
    files: files.concat(externalGlobalProtocol.files),
  });
  return await rememberSidecar(sidecar);
}
