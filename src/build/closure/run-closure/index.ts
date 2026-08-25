import { withInternalTiming } from "../../../shared/timing";
import { withExplicitHideWarningsFor } from "../compiler";
import { compilePreparedClosureJobs } from "../compile-jobs";
import {
  prepareClosureStageDirectories,
  writeGeneratedAssets,
} from "../stage-outputs";
import { finalizeClosureStageOutputs } from "./finalize";
import { prepareClosureStageJobs } from "./prepare";
import type { ClosureStageInput, ClosureStageResult } from "./types";

export type { ClosureStageResult } from "./types";

export async function runClosureStage(
  input: ClosureStageInput,
): Promise<ClosureStageResult> {
  const { cacheOutputDir } = await prepareClosureStageDirectories({
    finalCacheDir: input.finalCacheDir,
    outDir: input.outDir,
  });
  const { chunkOutputType, prepared } = prepareClosureStageJobs(input);
  await writeGeneratedAssets(prepared.generatedAssets);
  const exitCodes = await withInternalTiming("closure:compile", () =>
    compilePreparedClosureJobs({
      closureCompilerEnvironment: withExplicitHideWarningsFor(
        input.closureCompilerEnvironment,
        input.options.hideWarningsFor,
      ),
      chunkMode: input.options.chunks.mode,
      platformExterns: input.options.platformExterns,
      target: input.options.target,
      packageRoot: input.packageRoot,
      projectRoot: input.options.projectRoot,
      prepared,
      projectCacheDir: input.projectCacheDir,
      typeWorld: input.typeWorld,
      usesPersistentCache: input.options.cache.mode !== "off",
    }),
  );
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }
  return finalizeClosureStageOutputs({
    cacheOutputDir,
    chunkOutputType,
    input,
    prepared,
  });
}
