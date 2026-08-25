import fs from "fs/promises";
import path from "path";

import type { BuildContext, ResolvedBuild } from "../../types";

export interface FinalCachePaths {
  fastSnapshotPath: string;
  metadataPath: string;
}

export interface InvocationStaging {
  finalCacheDir: string;
  outDir: string;
}

export function getFinalCachePaths(
  context: BuildContext,
  resolved: ResolvedBuild,
): FinalCachePaths {
  return {
    fastSnapshotPath: path.join(context.projectCacheDir, "final-fast.json"),
    metadataPath: path.join(resolved.finalCacheDir, "meta.json"),
  };
}

export async function createInvocationStaging(
  outDir: string,
  finalCacheDir: string,
): Promise<InvocationStaging> {
  await Promise.all([
    fs.mkdir(path.dirname(outDir), { recursive: true }),
    fs.mkdir(path.dirname(finalCacheDir), { recursive: true }),
  ]);
  return {
    finalCacheDir: await fs.mkdtemp(
      path.join(
        path.dirname(finalCacheDir),
        `.${path.basename(finalCacheDir)}.staging-`,
      ),
    ),
    outDir: await fs.mkdtemp(
      path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`),
    ),
  };
}
