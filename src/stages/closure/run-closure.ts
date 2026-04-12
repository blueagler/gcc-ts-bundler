import fs from "fs/promises";
import path from "path";

import {
  copyOrLinkFiles,
  ensureDirectory,
  ensureParentDirectory,
} from "../../internal/files";
import { withInternalTiming } from "../../internal/timing";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import { prepareClosureJobs } from "../../native/load";
import {
  ClosureCompilerOptions,
  configureClosureCompilerOptions,
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
} from "./compiler";
import {
  getCompileJobArtifactFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "./cache";
import { determineClosureConcurrency, runWithConcurrency } from "./concurrency";
import { runClosurePostprocess } from "./postprocess";

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

export async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
  projectCacheDir,
  supportFiles,
  packageRoot,
}: {
  chunkPlan: ChunkPlanChunk[];
  emittedOutDir: string;
  explicitExternPaths: string[];
  finalCacheDir: string;
  generatedExternPaths: string[];
  nativeExternPath: string;
  options: NormalizedBuildOptions;
  outDir: string;
  projectCacheDir: string;
  supportFiles: string[];
  packageRoot: string;
}): Promise<ClosureStageResult> {
  const { cacheOutputDir } = await prepareClosureStageDirectories({
    finalCacheDir,
    outDir,
  });

  const prepared = prepareClosureJobs({
    chunkLoader: options.chunks.loader,
    chunkMode: options.chunks.mode,
    chunkPlan,
    compilationLevel: options.compilationLevel,
    diagnosticsVerbose: options.diagnostics.verbose,
    emittedOutDir,
    explicitExternPaths,
    explicitJsInputs: options.js,
    finalCacheDir,
    generatedExternPaths,
    languageOut: options.languageOut,
    manifestFile: options.chunks.manifestFile,
    nativeExternPath,
    outDir,
    packageRoot,
    publicPath: options.chunks.publicPath,
    supportFiles,
  });

  await writeGeneratedAssets(prepared.generatedAssets);

  const exitCodes = await withInternalTiming("closure:compile", () =>
    compilePreparedClosureJobs({
      chunkMode: options.chunks.mode,
      prepared,
      projectCacheDir,
      usesPersistentCache: options.cache.mode !== "off",
    }),
  );
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }

  await withInternalTiming("closure:postprocess", () =>
    runClosurePostprocess({
      chunkMode: options.chunks.mode,
      languageOut: options.languageOut,
      prepared,
    }),
  );

  await withInternalTiming("closure:publish", () =>
    publishPreparedClosureOutputs(prepared.publishedOutputs, cacheOutputDir),
  );
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) =>
    path.join(cacheOutputDir, path.relative(outDir, outputFile)),
  );

  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs,
  };
}

async function prepareClosureStageDirectories({
  finalCacheDir,
  outDir,
}: {
  finalCacheDir: string;
  outDir: string;
}) {
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  return { cacheOutputDir, rawDir };
}

async function writeGeneratedAssets(
  assets: ReturnType<typeof prepareClosureJobs>["generatedAssets"],
) {
  await Promise.all(
    assets.map(async (asset) => {
      await ensureParentDirectory(asset.path);
      await fs.writeFile(asset.path, asset.text, "utf-8");
    }),
  );
}

async function compilePreparedClosureJobs({
  chunkMode,
  prepared,
  projectCacheDir,
  usesPersistentCache,
}: {
  chunkMode: string;
  prepared: ReturnType<typeof prepareClosureJobs>;
  projectCacheDir: string;
  usesPersistentCache: boolean;
}) {
  const cacheDir = usesPersistentCache
    ? path.join(projectCacheDir, "closure-jobs")
    : null;
  const concurrency =
    chunkMode === "bundler-runtime"
      ? determineClosureConcurrency(prepared.compileJobs.length)
      : 1;
  return runWithConcurrency(prepared.compileJobs, concurrency, async (job) =>
    runPreparedClosureJob({
      cacheDir,
      job,
    }),
  );
}

async function publishPreparedClosureOutputs(
  outputFiles: string[],
  cacheOutputDir: string,
) {
  await copyOrLinkFiles(outputFiles, cacheOutputDir);
}

async function runPreparedClosureJob({
  cacheDir,
  job,
}: {
  cacheDir: string | null;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
}) {
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        artifactFiles,
        cacheDir,
        compilerVersion,
        job,
      })
    : false;
  if (cached) {
    return 0;
  }

  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel as never,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn as never,
    languageOut: job.languageOut as never,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel as never,
  };
  if (job.chunk) {
    closureOptions.chunk = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions.chunkOutputPathPrefix = job.chunkOutputPathPrefix;
  }
  if (job.dependencyMode) {
    closureOptions.dependencyMode = job.dependencyMode as never;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions.entryPoint = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions.jsOutputFile = job.jsOutputFile;
  }
  if (job.propertyRenamingReportPath) {
    (
      closureOptions as ClosureCompilerOptions & {
        propertyRenamingReport?: string;
      }
    ).propertyRenamingReport = job.propertyRenamingReportPath;
  }
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }

  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job,
    });
  }

  return 0;
}
