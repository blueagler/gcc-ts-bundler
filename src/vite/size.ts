import { collectJsGraphStats } from "../shared/lifecycle-size";
import { getCapturedModuleAnalysis } from "./capture";
import { summarizeModuleIdsByPackage } from "./graph";
import type { CapturedModule, MaterializedGraph } from "./internal-types";

export async function collectMaterializedGraphStats(input: {
  capturedModules?: Map<string, CapturedModule>;
  dynamicRootCount: number;
  entryCount: number;
  materialized: MaterializedGraph;
}) {
  const uniqueSourceModuleIds = [
    ...new Set(
      input.materialized.modules.flatMap((module) => module.sourceModuleIds),
    ),
  ].sort((left, right) => left.localeCompare(right));

  const graphStats = await collectJsGraphStats({
    entryCount: input.entryCount,
    filePaths: input.materialized.modules.map((module) => module.filePath),
    forwardingModuleIds: uniqueSourceModuleIds.filter((sourceModuleId) => {
      const capturedModule = input.capturedModules?.get(sourceModuleId);
      if (!capturedModule) {
        return false;
      }
      return getCapturedModuleAnalysis(capturedModule).isForwardingOnly;
    }),
    lazyRootCount: input.dynamicRootCount,
  });

  return {
    ...graphStats,
    packageSummary: summarizeModuleIdsByPackage(uniqueSourceModuleIds),
  };
}
