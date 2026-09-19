import type { ResolvedConfig } from "vite";
import type { TransformOptions } from "rolldown/utils";

import type { CapturedModuleResolutionCache } from "../capture";
import type {
  CapturedModule,
  MaterializedGraph,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";
import {
  assembleMaterializedGraph,
  assembleMaterializedModuleRecords,
  classifyEmptyCapturedModules,
} from "./graph";
import { writeMaterializedModuleCopies } from "./write";

export async function materializeCapturedGraph(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    cssModuleIdsWithOwnership?: Iterable<string>;
    config: ResolvedConfig;
    dynamicRootModuleIds: string[];
    entryModuleIds: string[];
    metrics?: ViteBuildMetrics | undefined;
    moduleIds: string[];
    nativeDefines: TransformOptions["define"];
    resolutionCache: CapturedModuleResolutionCache;
    srcDir: string;
  },
): Promise<MaterializedGraph> {
  if (input.entryModuleIds.length === 0) {
    this.error("gccTsBundler() could not determine a Vite entry facade.");
  }

  const classified = classifyEmptyCapturedModules.call(this, {
    capturedModules: input.capturedModules,
    cssModuleIdsWithOwnership: input.cssModuleIdsWithOwnership,
    dynamicRootModuleIds: input.dynamicRootModuleIds,
    entryModuleIds: input.entryModuleIds,
    metrics: input.metrics,
    moduleIds: input.moduleIds,
  });
  const records = assembleMaterializedModuleRecords({
    capturedModules: input.capturedModules,
    materializedModuleIds: classified.materializedModuleIds,
    projectRoot: input.config.root,
    srcDir: input.srcDir,
  });
  const runtimeResolutions = await writeMaterializedModuleCopies.call(this, {
    capturedModules: input.capturedModules,
    config: input.config,
    filePathByModuleId: records.filePathByModuleId,
    materializedModuleIds: classified.materializedModuleIds,
    metrics: input.metrics,
    nativeDefines: input.nativeDefines,
    resolutionCache: input.resolutionCache,
    srcDir: input.srcDir,
  });

  return assembleMaterializedGraph.call(this, {
    authoredFiles: records.authoredFiles,
    dependencySourceFileByMaterializedFile:
      records.dependencySourceFileByMaterializedFile,
    entryModuleIds: input.entryModuleIds,
    filePathByModuleId: records.filePathByModuleId,
    materializedModuleIds: classified.materializedModuleIds,
    modules: records.modules,
    prunedEmptyModuleIds: classified.prunedEmptyModuleIds,
    retainedEmptyModuleIds: classified.retainedEmptyModuleIds,
    runtimeResolutions,
    srcDir: input.srcDir,
  });
}
