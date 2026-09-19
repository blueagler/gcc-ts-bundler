import path from "path";

import type { ResolvedChunkOutputType } from "../../../api/types";
import type { NativePrepareClosureJobsOutput } from "../../../native/abi";
import { withInternalTiming } from "../../../shared/timing";
import { finalizeJavaScriptOutputs } from "../final-minify";
import { runClosurePostprocess } from "../postprocess";
import { stripUnusedSharedChunkImports } from "../postprocess/strip-unused-shared-imports";
import { pruneEmptyChunks } from "../prune-empty";
import {
  emitPreservedModules,
  prependEntryShebangs,
  publishPreparedClosureOutputs,
} from "../stage-outputs";
import type { ClosureStageInput, ClosureStageResult } from "./types";

export async function finalizeClosureStageOutputs({
  cacheOutputDir,
  chunkOutputType,
  input,
  prepared,
}: {
  cacheOutputDir: string;
  chunkOutputType: ResolvedChunkOutputType;
  input: ClosureStageInput;
  prepared: NativePrepareClosureJobsOutput;
}): Promise<ClosureStageResult> {
  await withInternalTiming("closure:postprocess", () =>
    runClosurePostprocess({
      chunkMode: input.options.chunks.mode,
      chunkOutputType,
      prepared,
    }),
  );

  const preservedOutputFiles = await emitPreservedModules({
    chunkPlan: input.chunkPlan,
    imports: input.preservedImports,
    modules: input.preservedModules,
    outDir: input.outDir,
    postprocessActions: prepared.postprocessActions,
  });
  await prependEntryShebangs({
    chunkPlan: input.chunkPlan,
    entryShebangs: input.entryShebangs,
    postprocessActions: prepared.postprocessActions,
  });
  let publishedOutputs = [
    ...prepared.publishedOutputs,
    ...preservedOutputFiles,
  ];

  if (input.options.chunks.mode !== "off") {
    publishedOutputs = await withInternalTiming(
      "closure:prune-empty-chunks",
      () =>
        pruneEmptyChunks({
          chunkPlan: input.chunkPlan,
          manifestFilePath: input.options.chunks.manifestFile
            ? path.join(input.outDir, input.options.chunks.manifestFile)
            : null,
          outputFiles: publishedOutputs,
        }),
    );
  }

  if (input.options.finalMinify) {
    await withInternalTiming("closure:final-oxc", () =>
      finalizeJavaScriptOutputs({
        excludedOutputFiles: preservedOutputFiles,
        outputFiles: publishedOutputs,
      }),
    );
  }

  if (input.options.chunks.mode === "off" && chunkOutputType === "esm") {
    await stripUnusedSharedChunkImports(publishedOutputs);
  }

  const copyCanonicalOutputs = input.options.cache.mode === "persistent";
  await withInternalTiming("closure:publish", () =>
    publishPreparedClosureOutputs(
      publishedOutputs,
      input.outDir,
      cacheOutputDir,
      copyCanonicalOutputs,
    ),
  );
  const cacheOutputFiles = copyCanonicalOutputs
    ? publishedOutputs.map((outputFile) =>
        path.join(cacheOutputDir, path.relative(input.outDir, outputFile)),
      )
    : [];

  return {
    cacheOutputFiles,
    diagnostics: [],
    exitCode: 0,
    outputFiles: publishedOutputs,
  };
}
