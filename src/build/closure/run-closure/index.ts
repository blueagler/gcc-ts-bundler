import {
  countInternalWork,
  withInternalTiming,
  withInternalTimingSync,
} from "../../../shared/timing";
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
  const { cacheOutputDir } = await withInternalTiming(
    "closure:directories",
    () =>
      prepareClosureStageDirectories({
        finalCacheDir: input.finalCacheDir,
        outDir: input.outDir,
      }),
  );
  const { chunkOutputType, prepared } = withInternalTimingSync(
    "closure:assemble-jobs",
    () => prepareClosureStageJobs(input),
  );
  countInternalWork("compileJobs", prepared.compileJobs.length);
  countInternalWork("generatedAssets", prepared.generatedAssets.length);
  await withInternalTiming("closure:write-assets", () =>
    writeGeneratedAssets(prepared.generatedAssets),
  );
  const results = await withInternalTiming("closure:compile", () =>
    compilePreparedClosureJobs({
      closureCompilerEnvironment: withExplicitHideWarningsFor(
        input.closureCompilerEnvironment,
        input.options.hideWarningsFor,
      ),
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
  const failed = results.find((result) => result.exitCode !== 0);
  if (failed) {
    return {
      cacheOutputFiles: [],
      diagnostics: results.flatMap((result) => result.diagnostics),
      exitCode: failed.exitCode,
      outputFiles: [],
    };
  }
  return finalizeClosureStageOutputs({
    cacheOutputDir,
    chunkOutputType,
    input,
    prepared,
  });
}
