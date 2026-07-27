import fs from "fs/promises";
import path from "path";

import {
  publishFilesToDirectory,
  ensureDirectory,
  ensureParentDirectory,
} from "../../shared/files";
import { logInternalDetail, withInternalTiming } from "../../shared/timing";
import type { ChunkPlanChunk, ResolvedBuildOptions } from "../types";
import { prepareClosureJobs } from "../../native/load";
import { finalizeSplitChunks } from "../split-chunks";
import {
  configureClosureCompilerOptions,
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
  shouldEnableTypeInference,
  TYPE_INFERENCE_OPTIONS,
} from "./compiler";
import type { ClosureCompilerOptions } from "./compiler";
import {
  getCompileJobArtifactFiles,
  getCompileJobOutputFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "./cache";
import { resolveChunkOutputType } from "../resolve/options";
import { generatePlatformExternsText } from "./platform-externs";
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
  options: ResolvedBuildOptions;
  outDir: string;
  projectCacheDir: string;
  supportFiles: string[];
  packageRoot: string;
}): Promise<ClosureStageResult> {
  const { cacheOutputDir } = await prepareClosureStageDirectories({
    finalCacheDir,
    outDir,
  });

  const chunkOutputType = resolveChunkOutputType({
    chunkMode: options.chunks.mode,
    languageOut: options.languageOut,
    outputType: options.chunks.outputType,
  });
  logInternalDetail("closure:chunk-output-type", chunkOutputType);

  const prepared = prepareClosureJobs({
    chunkLoader: "script",
    chunkMode: options.chunks.mode,
    chunkOutputType,
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
      hasTypedInput: options.typedAnnotations.length > 0,
      platformExterns: options.platformExterns,
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
      chunkOutputType,
      languageOut: options.languageOut,
      prepared,
    }),
  );

  const publishedOutputs =
    options.chunks.mode === "split"
      ? await finalizeSplitChunks({
          chunkPlan,
          manifestFile: options.chunks.manifestFile,
          outDir,
          publicPath: options.chunks.publicPath,
          publishedOutputs: prepared.publishedOutputs,
        })
      : prepared.publishedOutputs;

  await withInternalTiming("closure:publish", () =>
    publishPreparedClosureOutputs(publishedOutputs, cacheOutputDir),
  );
  const cacheOutputFiles = publishedOutputs.map((outputFile) =>
    path.join(cacheOutputDir, path.relative(outDir, outputFile)),
  );

  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: publishedOutputs,
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
  hasTypedInput,
  platformExterns,
  prepared,
  projectCacheDir,
  usesPersistentCache,
}: {
  chunkMode: string;
  hasTypedInput: boolean;
  platformExterns: string;
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
  const results = await runWithConcurrency(
    prepared.compileJobs,
    concurrency,
    async (job) =>
      runPreparedClosureJob({
        cacheDir,
        job: await applyStableRenamingMaps(
          await applyMinimalPlatformExterns(
            applyTypeInference(job, chunkMode),
            platformExterns,
            hasTypedInput,
          ),
          cacheDir,
        ),
      }),
  );
  if (cacheDir) {
    const hits = results.filter((result) => result.cacheHit).length;
    logInternalDetail(
      "cache:closure-jobs",
      `hits=${hits} misses=${results.length - hits} jobs=${results.length}`,
    );
  }
  return results.map((result) => result.exitCode);
}

async function publishPreparedClosureOutputs(
  outputFiles: string[],
  cacheOutputDir: string,
) {
  await publishFilesToDirectory(outputFiles, cacheOutputDir, "copy");
}

type PreparedCompileJob = ReturnType<
  typeof prepareClosureJobs
>["compileJobs"][number] & {
  env?: string;
  propertyMapInputFile?: string;
  variableMapInputFile?: string;
  variableRenamingReportPath?: string;
  typeInference?: boolean;
};

/** Records the inference decision on the job so it reaches the cache key
 * as well as the compiler; see `shouldEnableTypeInference`. */
function applyTypeInference(
  job: PreparedCompileJob,
  chunkMode: string,
): PreparedCompileJob {
  return shouldEnableTypeInference(chunkMode, job.compilationLevel)
    ? { ...job, typeInference: true }
    : job;
}

/**
 * Feeds renaming maps from the previous build back into Closure so
 * unchanged chunks stay byte-identical across builds. Without this, one new
 * property name reshuffles the global renaming tables and invalidates every
 * emitted chunk; with pinned maps only genuinely changed chunks differ.
 * Maps live in the persistent cache and reset with `clean-cache`.
 */
async function applyStableRenamingMaps(
  job: PreparedCompileJob,
  cacheDir: string | null,
): Promise<PreparedCompileJob> {
  if (!cacheDir || !job.propertyRenamingReportPath) {
    return job;
  }
  const stableJob = { ...job };
  stableJob.variableRenamingReportPath = path.join(
    path.dirname(job.propertyRenamingReportPath),
    "variable-renaming-report.txt",
  );
  const mapsDir = renamingMapsDirectory(cacheDir, job);
  const propertyMap = path.join(mapsDir, "property.map");
  const variableMap = path.join(mapsDir, "variable.map");
  const [hasPropertyMap, hasVariableMap] = await Promise.all(
    [propertyMap, variableMap].map((filePath) =>
      fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (hasPropertyMap) {
    stableJob.propertyMapInputFile = propertyMap;
  }
  if (hasVariableMap) {
    stableJob.variableMapInputFile = variableMap;
  }
  return stableJob;
}

function renamingMapsDirectory(cacheDir: string, job: PreparedCompileJob) {
  const firstOutput = getCompileJobOutputFiles(job)[0] ?? "job";
  // Sibling of the closure-jobs cache: job cache entries are content-keyed
  // and immutable, while these maps are mutable per-project state.
  return path.join(
    path.dirname(cacheDir),
    "renaming-maps",
    path.basename(firstOutput, ".js"),
  );
}

async function persistRenamingMaps(
  job: PreparedCompileJob,
  cacheDir: string | null,
) {
  if (
    !cacheDir ||
    !job.propertyRenamingReportPath ||
    !job.variableRenamingReportPath
  ) {
    return;
  }
  const mapsDir = renamingMapsDirectory(cacheDir, job);
  await ensureDirectory(mapsDir);
  await Promise.all([
    fs
      .copyFile(
        job.propertyRenamingReportPath,
        path.join(mapsDir, "property.map"),
      )
      .catch(() => {}),
    fs
      .copyFile(
        job.variableRenamingReportPath,
        path.join(mapsDir, "variable.map"),
      )
      .catch(() => {}),
  ]);
}

/**
 * Swaps Closure's full browser externs for a generated flat platform externs
 * file (`--env CUSTOM`); see `platform-externs.ts`. Applies only to ADVANCED
 * jobs without polyfill rewriting, because injected polyfills reference
 * platform names the input scan cannot see.
 */
async function applyMinimalPlatformExterns(
  job: PreparedCompileJob,
  platformExterns: string,
  hasTypedInput: boolean,
): Promise<PreparedCompileJob> {
  if (
    platformExterns !== "minimal" ||
    job.compilationLevel !== "ADVANCED" ||
    job.rewritePolyfills ||
    job.env !== undefined
  ) {
    return job;
  }
  const externsText = await generatePlatformExternsText(job.js, {
    typedConstructors: hasTypedInput,
  });
  if (externsText === null) {
    logInternalDetail(
      "closure:platform-externs",
      "unavailable, using full browser externs",
    );
    return job;
  }
  const outputFiles = getCompileJobOutputFiles(job);
  const firstOutput = outputFiles[0];
  if (!firstOutput) {
    return job;
  }
  const externsPath = path.join(
    path.dirname(firstOutput),
    `platform-externs.${path.basename(firstOutput, ".js")}.js`,
  );
  await ensureParentDirectory(externsPath);
  await fs.writeFile(externsPath, externsText, "utf-8");
  logInternalDetail("closure:platform-externs", `bytes=${externsText.length}`);
  return {
    ...job,
    env: "CUSTOM",
    externs: [...job.externs, externsPath],
  };
}

async function runPreparedClosureJob({
  cacheDir,
  job,
}: {
  cacheDir: string | null;
  job: PreparedCompileJob;
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
    await persistRenamingMaps(job, cacheDir);
    return {
      cacheHit: true,
      exitCode: 0,
    };
  }

  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel,
  };
  if (job.chunk) {
    closureOptions["chunk"] = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions["chunkOutputPathPrefix"] = job.chunkOutputPathPrefix;
  }
  if (job.chunkOutputType) {
    closureOptions["chunkOutputType"] = job.chunkOutputType;
  }
  if (job.dependencyMode) {
    closureOptions["dependencyMode"] = job.dependencyMode;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions["entryPoint"] = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions["jsOutputFile"] = job.jsOutputFile;
  }
  if (job.propertyRenamingReportPath) {
    closureOptions["propertyRenamingReport"] = job.propertyRenamingReportPath;
  }
  if (job.variableRenamingReportPath) {
    closureOptions["variableRenamingReport"] = job.variableRenamingReportPath;
  }
  if (job.propertyMapInputFile) {
    closureOptions["propertyMapInputFile"] = job.propertyMapInputFile;
  }
  if (job.variableMapInputFile) {
    closureOptions["variableMapInputFile"] = job.variableMapInputFile;
  }
  if (job.renamePrefixNamespace) {
    closureOptions["renamePrefixNamespace"] = job.renamePrefixNamespace;
  }
  if (job.env) {
    closureOptions["env"] = job.env;
  }
  if (job.typeInference) {
    Object.assign(closureOptions, TYPE_INFERENCE_OPTIONS);
  }
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    if (job.env === "CUSTOM") {
      // The generated platform externs missed a name; recompile with the
      // full browser externs (slower but complete).
      logInternalDetail(
        "closure:platform-externs",
        "fallback to full browser externs",
      );
      const fullJob = { ...job };
      delete fullJob.env;
      return runPreparedClosureJob({
        cacheDir,
        job: {
          ...fullJob,
          externs: fullJob.externs.filter(
            (externPath) =>
              !path.basename(externPath).startsWith("platform-externs."),
          ),
        },
      });
    }
    return {
      cacheHit: false,
      exitCode,
    };
  }

  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job,
    });
  }
  await persistRenamingMaps(job, cacheDir);

  return {
    cacheHit: false,
    exitCode: 0,
  };
}
