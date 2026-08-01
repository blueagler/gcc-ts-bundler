import fs from "fs/promises";
import path from "path";

import { ensureDirectory, ensureParentDirectory } from "../../shared/files";
import { logInternalDetail, withInternalTiming } from "../../shared/timing";
import type { ChunkPlanChunk, ResolvedBuildOptions } from "../types";
import { prepareClosureJobs } from "../../native/load";
import type { NativeEmittedTypeMetadata } from "../../native/load";
import {
  configureClosureCompilerOptions,
  hasStrictCheckTypes,
  resolveClosureCompilerVersionTag,
  runClosureCompiler,
  shouldEnableTypeInference,
  TYPE_INFERENCE_OPTIONS,
  type ClosureCompilerEnvironment,
  type ClosureCompilerOptions,
} from "./compiler";
import {
  getCompileJobArtifactFiles,
  getCompileJobOutputFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "./cache";
import { resolveChunkOutputType } from "../resolve/options";
import {
  generatePlatformExternsText,
  isMissingPlatformExternFailure,
} from "./platform-externs";
import { determineClosureConcurrency, runWithConcurrency } from "./concurrency";
import { runClosurePostprocess } from "./postprocess";
import { pruneEmptyChunks } from "./prune-empty-chunks";

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

export async function runClosureStage({
  closureCompilerEnvironment,
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
  typeMetadata,
  packageRoot,
}: {
  closureCompilerEnvironment: ClosureCompilerEnvironment;
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
  typeMetadata: NativeEmittedTypeMetadata[];
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
    needsCssRuntime: options.cssRuntime,
    outDir,
    packageRoot,
    publicPath: options.chunks.publicPath,
    supportFiles,
    typeMetadata,
  });

  await writeGeneratedAssets(prepared.generatedAssets);

  const exitCodes = await withInternalTiming("closure:compile", () =>
    compilePreparedClosureJobs({
      closureCompilerEnvironment,
      chunkMode: options.chunks.mode,
      platformExterns: options.platformExterns,
      packageRoot,
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
      prepared,
    }),
  );

  let publishedOutputs = prepared.publishedOutputs;

  if (options.chunks.mode !== "off") {
    publishedOutputs = await withInternalTiming(
      "closure:prune-empty-chunks",
      () =>
        pruneEmptyChunks({
          chunkPlan,
          manifestFilePath: options.chunks.manifestFile
            ? path.join(outDir, options.chunks.manifestFile)
            : null,
          outputFiles: publishedOutputs,
        }),
    );
  }

  await withInternalTiming("closure:publish", () =>
    publishPreparedClosureOutputs(publishedOutputs, outDir, cacheOutputDir),
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

function createPlatformExternFallbackWarning() {
  let warned = false;
  return () => {
    if (warned) return;
    warned = true;
    console.warn(
      'gcc-ts-bundler: platform extern slicing fell back to full browser externs. Set platformExterns: "full" to use full externs intentionally.',
    );
  };
}

async function compilePreparedClosureJobs({
  closureCompilerEnvironment,
  chunkMode,
  platformExterns,
  packageRoot,
  prepared,
  projectCacheDir,
  usesPersistentCache,
}: {
  closureCompilerEnvironment: ClosureCompilerEnvironment;
  chunkMode: string;
  platformExterns: string;
  packageRoot: string;
  prepared: ReturnType<typeof prepareClosureJobs>;
  projectCacheDir: string;
  usesPersistentCache: boolean;
}) {
  const cacheDir = usesPersistentCache
    ? path.join(projectCacheDir, "closure-jobs")
    : null;
  const concurrency =
    chunkMode === "off"
      ? 1
      : determineClosureConcurrency(prepared.compileJobs.length);
  const warnPlatformExternFallback = createPlatformExternFallbackWarning();
  const results = await runWithConcurrency(
    prepared.compileJobs,
    concurrency,
    async (job) =>
      runPreparedClosureJob({
        compilerEnvironment: closureCompilerEnvironment,
        cacheDir,
        job: await applyStableRenamingMaps(
          await applyMinimalPlatformExterns(
            applyTypeInference(
              job,
              closureCompilerEnvironment.typeInferenceDisabled,
            ),
            platformExterns,
            packageRoot,
            closureCompilerEnvironment.typeInferenceDisabled,
            projectCacheDir,
            warnPlatformExternFallback,
          ),
          cacheDir,
        ),
        warnPlatformExternFallback,
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
  outDir: string,
  cacheOutputDir: string,
) {
  await Promise.all(
    outputFiles.map(async (outputFile) => {
      const relativePath = path.relative(outDir, outputFile);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(`Published output escaped outDir: ${outputFile}`);
      }
      const cacheFile = path.join(cacheOutputDir, relativePath);
      await ensureParentDirectory(cacheFile);
      await fs.copyFile(outputFile, cacheFile);
    }),
  );
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
  typeInferenceDisabled: boolean,
): PreparedCompileJob {
  const enabled = shouldEnableTypeInference(
    job.compilationLevel,
    job.hasTypeMetadata,
    typeInferenceDisabled,
  );
  logInternalDetail(
    "closure:type-metadata-job",
    `metadata=${job.hasTypeMetadata} annotations=${job.typeMetadataCounts.annotationCount} members=${job.typeMetadataCounts.memberAnnotationCount} declarations=${job.typeMetadataCounts.typeDeclarationCount} enums=${job.typeMetadataCounts.enumDeclarationCount} unresolved=${job.typeMetadataCounts.unresolvedTypeReferenceCount} inference=${enabled}`,
  );
  return enabled ? { ...job, typeInference: true } : job;
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
 * Swaps Closure's full browser externs for a dependency-closed platform slice
 * (`--env CUSTOM`) on ADVANCED jobs. Polyfill jobs stay on the full set because
 * injected polyfills reference names absent from the program scan.
 *
 * Eligibility deliberately does *not* require type metadata. The slice is built
 * by scanning the same program text Closure is about to compile, which is
 * exactly as available for a JS-input job as for a typed one — the seeds
 * collector parses with `ScriptKind.JS` and every failure path (unparseable
 * file, unseedable property, unresolvable dependency) already returns null and
 * falls back to the full browser set. Requiring metadata only mirrored
 * `shouldEnableTypeInference`, and the cost of that coupling was measured: a
 * JS-input job paid 903 ms of externs parsing against ~214 ms for a slice of
 * comparable breadth, 74% of that example's whole closure phase
 * (`/tmp/gcc-w2-closurejs.md`).
 *
 * What the slice does *not* do is change renaming: it declares the same names
 * the program mentions, so an extern-pinned name stays pinned. The one hazard
 * it cannot see is a platform property reached only through a runtime-computed
 * key, and that hazard is identical under the full set — it is boundary D's
 * job (runtime-aware externs), not this gate's, and it predates this change.
 */
async function applyMinimalPlatformExterns(
  job: PreparedCompileJob,
  platformExterns: string,
  packageRoot: string,
  typeInferenceDisabled: boolean,
  projectCacheDir: string,
  warnPlatformExternFallback: () => void,
): Promise<PreparedCompileJob> {
  if (
    platformExterns !== "minimal" ||
    job.compilationLevel !== "ADVANCED" ||
    typeInferenceDisabled ||
    job.rewritePolyfills ||
    job.env !== undefined
  ) {
    return job;
  }
  const closureLibDir = path.join(packageRoot, "closure-lib");
  const closureLibFiles: string[] = [];
  const programJs = job.js.filter((filePath) => {
    const relative = path.relative(closureLibDir, path.resolve(filePath));
    const isClosureLib =
      !relative.startsWith("..") && !path.isAbsolute(relative);
    if (isClosureLib) closureLibFiles.push(filePath);
    return !isClosureLib;
  });
  const externsText = await generatePlatformExternsText(
    programJs,
    [...closureLibFiles, ...job.externs],
    // Program-keyed, so it belongs to the project rather than the machine.
    { sliceCacheRoot: projectCacheDir },
  );
  if (externsText === null) {
    warnPlatformExternFallback();
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
  logInternalDetail(
    "closure:platform-externs",
    `bytes=${externsText.length} metadata=${job.hasTypeMetadata}`,
  );
  return {
    ...job,
    env: "CUSTOM",
    externs: [...job.externs, externsPath],
  };
}

async function runPreparedClosureJob({
  compilerEnvironment,
  cacheDir,
  job,
  warnPlatformExternFallback,
}: {
  compilerEnvironment: ClosureCompilerEnvironment;
  cacheDir: string | null;
  job: PreparedCompileJob;
  warnPlatformExternFallback: () => void;
}) {
  const cacheJob = {
    ...job,
    compilerEnvironment: compilerEnvironment.options,
  };
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        artifactFiles,
        cacheDir,
        compilerVersion,
        job: cacheJob,
      })
    : false;
  if (cached) {
    await persistRenamingMaps(job, cacheDir);
    return {
      cacheHit: true,
      exitCode: 0,
    };
  }

  const strictCheckTypes = hasStrictCheckTypes(compilerEnvironment.options);
  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: strictCheckTypes ? "DEFAULT" : job.warningLevel,
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
  if (job.typeInference && !strictCheckTypes) {
    Object.assign(closureOptions, TYPE_INFERENCE_OPTIONS);
  }
  configureClosureCompilerOptions(closureOptions, compilerEnvironment.options);
  let capturedStdErr = "";
  const exitCode = await runClosureCompiler(closureOptions, (stdErr) => {
    capturedStdErr += stdErr;
  });
  if (exitCode !== 0) {
    // Retry with the full browser externs only when the diagnostics say the
    // slice was incomplete. Retrying on *any* non-zero exit made every real
    // compile error cost two full Closure runs and print itself twice.
    if (
      job.env === "CUSTOM" &&
      isMissingPlatformExternFailure(capturedStdErr)
    ) {
      warnPlatformExternFallback();
      logInternalDetail(
        "closure:platform-externs",
        "fallback to full browser externs",
      );
      const fullJob = { ...job };
      delete fullJob.env;
      return runPreparedClosureJob({
        compilerEnvironment,
        cacheDir,
        warnPlatformExternFallback,
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
      job: cacheJob,
    });
  }
  await persistRenamingMaps(job, cacheDir);

  return {
    cacheHit: false,
    exitCode: 0,
  };
}
