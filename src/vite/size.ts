import fs from "node:fs/promises";

import { classifyModuleId, getCapturedModuleAnalysis } from "./capture";
import type { CapturedModule, MaterializedGraph } from "./internal-types";

export async function collectMaterializedGraphStats(input: {
  capturedModules?: Map<string, CapturedModule>;
  dynamicRootCount: number;
  entryCount: number;
  materialized: MaterializedGraph;
}) {
  const totalBytes = (
    await Promise.all(
      input.materialized.modules.map(async (module) => {
        try {
          return (await fs.stat(module.filePath)).size;
        } catch {
          return 0;
        }
      }),
    )
  ).reduce((sum, size) => sum + size, 0);

  const uniqueSourceModuleIds = [
    ...new Set(
      input.materialized.modules.flatMap((module) => module.sourceModuleIds),
    ),
  ].sort((left, right) => left.localeCompare(right));

  let forwardingModuleCount = 0;
  if (input.capturedModules) {
    for (const sourceModuleId of uniqueSourceModuleIds) {
      const capturedModule = input.capturedModules.get(sourceModuleId);
      if (!capturedModule) {
        continue;
      }
      if (getCapturedModuleAnalysis(capturedModule).isForwardingOnly) {
        forwardingModuleCount += 1;
      }
    }
  }

  return {
    entryCount: input.entryCount,
    forwardingModuleCount,
    lazyRootCount: input.dynamicRootCount,
    moduleCount: input.materialized.modules.length,
    packageSummary: summarizeModuleIdsByPackage(uniqueSourceModuleIds),
    totalBytes,
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
