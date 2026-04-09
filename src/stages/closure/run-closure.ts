import fs from "fs/promises";
import path from "path";

import {
  copyOrLinkFiles,
  ensureDirectory,
  ensureParentDirectory,
} from "../../internal/files";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import {
  prepareClosureJobs,
  rewriteDecoratorMetadata,
  rewriteGccExports,
} from "../../native/load";
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

  const propertyRenamingReports = new Map<string, Promise<string>>();
  await Promise.all(
    prepared.postprocessActions.map(async (action) => {
      await ensureParentDirectory(action.outputPath);
      const reportText = action.propertyRenamingReportPath
        ? await readPropertyRenamingReport(
            action.propertyRenamingReportPath,
            propertyRenamingReports,
          )
        : "";
      if (action.kind === "copy" && !reportText) {
        await fs.copyFile(action.inputPath, action.outputPath);
        return;
      }
      let contents = await fs.readFile(action.inputPath, "utf-8");
      if (
        action.kind === "rewrite-gcc-exports" ||
        action.kind === "rewrite-gcc-exports-and-decorator-metadata"
      ) {
        contents = rewriteGccExports(contents);
      }
      if (
        reportText &&
        (action.kind === "rewrite-decorator-metadata" ||
          action.kind === "rewrite-gcc-exports-and-decorator-metadata")
      ) {
        contents = rewriteDecoratorMetadata(contents, reportText);
      }
      await fs.writeFile(action.outputPath, contents);
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

async function readPropertyRenamingReport(
  reportPath: string,
  cache: Map<string, Promise<string>>,
) {
  let pending = cache.get(reportPath);
  if (!pending) {
    pending = fs.readFile(reportPath, "utf-8");
    cache.set(reportPath, pending);
  }
  return pending;
}
