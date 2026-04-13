import { collectJsGraphStats } from "../internal/lifecycle-size";
import { classifyModuleId, getCapturedModuleAnalysis } from "./capture";
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

function summarizeModuleIdsByPackage(moduleIds: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const moduleId of moduleIds) {
    const bucket = classifyModuleId(moduleId);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) =>
      right[1] === left[1]
        ? left[0].localeCompare(right[0])
        : right[1] - left[1],
    )
    .map(([bucket, count]) => `${bucket}:${count}`)
    .join(", ");
}
