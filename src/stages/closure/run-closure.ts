import fs from "fs/promises";
import path from "path";

import {
  copyOrLinkFiles,
  ensureDirectory,
  ensureParentDirectory,
} from "../../internal/files";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import { prepareClosureJobs, rewriteGccExports } from "../../native/load";
import {
  ClosureCompilerOptions,
  configureClosureCompilerOptions,
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
} from "./compiler";
import {
  getCompileJobOutputFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "./cache";
import { determineClosureConcurrency, runWithConcurrency } from "./concurrency";

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
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

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

  await Promise.all(
    prepared.generatedAssets.map(async (asset) => {
      await ensureParentDirectory(asset.path);
      await fs.writeFile(asset.path, asset.text, "utf-8");
    }),
  );

  const closureJobCacheDir =
    options.cache.mode === "off"
      ? null
      : path.join(projectCacheDir, "closure-jobs");
  const concurrency =
    options.chunks.mode === "bundler-runtime"
      ? determineClosureConcurrency(prepared.compileJobs.length)
      : 1;
  const exitCodes = await runWithConcurrency(
    prepared.compileJobs,
    concurrency,
    async (job) =>
      runPreparedClosureJob({
        cacheDir: closureJobCacheDir,
        job,
      }),
  );
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }

  await Promise.all(
    prepared.postprocessActions.map(async (action) => {
      await ensureParentDirectory(action.outputPath);
      if (action.kind === "rewrite-gcc-exports") {
        const contents = await fs.readFile(action.inputPath, "utf-8");
        await fs.writeFile(action.outputPath, rewriteGccExports(contents));
        return;
      }
      await fs.copyFile(action.inputPath, action.outputPath);
    }),
  );

  await copyOrLinkFiles(prepared.publishedOutputs, cacheOutputDir);
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) =>
    path.join(cacheOutputDir, path.relative(outDir, outputFile)),
  );

  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs,
  };
}

async function runPreparedClosureJob({
  cacheDir,
  job,
}: {
  cacheDir: string | null;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
}) {
  const outputFiles = getCompileJobOutputFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        cacheDir,
        compilerVersion,
        job,
        outputFiles,
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
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }

  if (cacheDir) {
    await persistCachedClosureJob({
      cacheDir,
      compilerVersion,
      job,
      outputFiles,
    });
  }

  return 0;
}
