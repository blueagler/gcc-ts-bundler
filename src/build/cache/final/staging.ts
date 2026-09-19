import fs from "fs/promises";
import path from "path";

import { runWithConcurrency } from "../../../shared/concurrency";

export interface InvocationStaging {
  finalCacheDir: string;
  inputsDir: string;
  outDir: string;
}

export async function createInvocationStaging(
  outDir: string,
  finalCacheDir: string,
): Promise<InvocationStaging> {
  await runWithConcurrency(
    [path.dirname(outDir), path.dirname(finalCacheDir)],
    2,
    async (dir) => {
      await fs.mkdir(dir, { recursive: true });
    },
  );
  const acquired: string[] = [];
  try {
    for (const target of [finalCacheDir, outDir]) {
      acquired.push(
        await fs.mkdtemp(
          path.join(path.dirname(target), `.${path.basename(target)}.staging-`),
        ),
      );
    }
    const stagedFinalCacheDir = acquired[0]!;
    const stagedOutDir = acquired[1]!;
    const inputsDir = path.join(stagedFinalCacheDir, "raw");
    await fs.mkdir(inputsDir, { recursive: true });
    return {
      finalCacheDir: stagedFinalCacheDir,
      outDir: stagedOutDir,
      inputsDir,
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const dir of acquired) {
      try {
        await fs.rm(dir, { force: true, recursive: true });
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Failed to acquire and unwind invocation staging.",
      );
    throw error;
  }
}

export async function cleanupInvocationStaging(staging: InvocationStaging) {
  const failures: unknown[] = [];
  for (const dir of [staging.outDir, staging.finalCacheDir]) {
    try {
      await fs.rm(dir, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Failed to clean invocation staging.");
}
