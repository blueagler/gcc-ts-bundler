import fs from "fs/promises";
import os from "os";
import path from "path";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import { hashContent, hashJson } from "../../cache/hash";
import { readJsonIfExists, writeJson } from "../../cache/store";
import { copyOrLinkFiles } from "../../internal/file-state";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import { prepareClosureJobs, rewriteGccExports } from "../../native/load";

type ClosureCompilerClass = (typeof closureCompilerPackage)["compiler"] & {
  JAR_PATH?: unknown;
};

type ClosureCompilerInstance = InstanceType<ClosureCompilerClass> & {
  JAR_PATH?: null | string;
  javaPath?: string;
};

type ClosureCompilerPackageShape = typeof closureCompilerPackage & {
  JAR_PATH?: unknown;
};
type ClosureCompilerOptions = ConstructorParameters<ClosureCompilerClass>[0];

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

interface ClosureJobCacheMetadata {
  outputFiles: string[];
  version: number;
}

const CLOSURE_JOB_CACHE_VERSION = 1;
const closureInputHashCache = new Map<string, Promise<string>>();

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
  await fs.mkdir(finalCacheDir, { recursive: true });

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(cacheOutputDir, { recursive: true });
  await fs.rm(outDir, { force: true, recursive: true });
  await fs.mkdir(outDir, { recursive: true });

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
      await fs.mkdir(path.dirname(asset.path), { recursive: true });
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
      await fs.mkdir(path.dirname(action.outputPath), { recursive: true });
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

function applyInternalClosureDebugOptions(
  closureOptions: ClosureCompilerOptions,
) {
  const mutableOptions = closureOptions as ClosureCompilerOptions & {
    debug?: boolean;
    formatting?: string;
    useTypesForOptimization?: boolean;
  };
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
    mutableOptions.useTypesForOptimization = false;
  }
}

function getDefaultString(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "string"
  ) {
    return value.default;
  }

  return undefined;
}

function resolveClosureCompilerJarPath(): string | undefined {
  const closureCompilerModule =
    closureCompilerPackage as ClosureCompilerPackageShape;
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;
  const jarPath =
    typeof closureCompiler.JAR_PATH === "string"
      ? closureCompiler.JAR_PATH
      : typeof closureCompilerModule.JAR_PATH === "string"
        ? closureCompilerModule.JAR_PATH
        : (getDefaultString(closureCompiler.JAR_PATH) ??
          getDefaultString(closureCompilerModule.JAR_PATH));

  return jarPath;
}

function configureClosureCompilerInstance(
  instance: ClosureCompilerInstance,
): ClosureCompilerInstance {
  const nativeImagePath = getNativeImagePath();
  if (nativeImagePath) {
    instance.JAR_PATH = null;
    instance.javaPath = nativeImagePath;
    return instance;
  }

  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    instance.JAR_PATH = jarPath;
  }

  return instance;
}

async function runClosureCompiler(
  options: ClosureCompilerOptions,
): Promise<number> {
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;

  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(
      new closureCompiler(options),
    );
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      if (stdOut) {
        console.log(stdOut);
      }
      if (stdErr) {
        console.error(stdErr);
      }
      resolve(exitCode);
    });
  });
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths)];
}

async function runPreparedClosureJob({
  cacheDir,
  job,
}: {
  cacheDir: string | null;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
}) {
  const outputFiles = getCompileJobOutputFiles(job);
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        cacheDir,
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
    externs: uniquePaths(job.externs),
    js: uniquePaths(job.js),
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
  applyInternalClosureDebugOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }

  if (cacheDir) {
    await persistCachedClosureJob({
      cacheDir,
      job,
      outputFiles,
    });
  }

  return 0;
}

async function tryRestoreCachedClosureJob({
  cacheDir,
  job,
  outputFiles,
}: {
  cacheDir: string;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
  outputFiles: string[];
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job);
  const metadata = await readJsonIfExists<ClosureJobCacheMetadata>(
    path.join(jobCacheDir, "meta.json"),
  );
  if (
    !metadata ||
    metadata.version !== CLOSURE_JOB_CACHE_VERSION ||
    metadata.outputFiles.length !== outputFiles.length
  ) {
    return false;
  }

  const cachedFiles = metadata.outputFiles.map((fileName) =>
    path.join(jobCacheDir, fileName),
  );
  const filesReady = await Promise.all(
    cachedFiles.map((filePath) =>
      fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (filesReady.some((ready) => !ready)) {
    return false;
  }

  await Promise.all(
    outputFiles.map(async (outputFile, index) => {
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      await fs.copyFile(cachedFiles[index], outputFile);
    }),
  );
  return true;
}

async function persistCachedClosureJob({
  cacheDir,
  job,
  outputFiles,
}: {
  cacheDir: string;
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number];
  outputFiles: string[];
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job);
  await fs.rm(jobCacheDir, { force: true, recursive: true });
  await fs.mkdir(jobCacheDir, { recursive: true });
  const outputNames = outputFiles.map((outputFile) => path.basename(outputFile));
  await Promise.all(
    outputFiles.map((outputFile, index) =>
      fs.copyFile(outputFile, path.join(jobCacheDir, outputNames[index])),
    ),
  );
  await writeJson(path.join(jobCacheDir, "meta.json"), {
    outputFiles: outputNames,
    version: CLOSURE_JOB_CACHE_VERSION,
  } satisfies ClosureJobCacheMetadata);
}

async function getClosureJobCacheDir(
  cacheDir: string,
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number],
) {
  const outputFiles = getCompileJobOutputFiles(job);
  const compilerVersion = resolveClosureCompilerJarPath() ?? getNativeImagePath() ?? "native";
  const [jsInputs, externInputs] = await Promise.all([
    hashFilesInOrder(job.js),
    hashFilesInOrder(job.externs),
  ]);
  const key = hashJson({
    compilerVersion,
    externInputs,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      jsOutputKinds: outputFiles.map((outputFile) => path.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel,
    },
    jsInputs,
    version: CLOSURE_JOB_CACHE_VERSION,
  });
  return path.join(cacheDir, key);
}

async function hashFilesInOrder(filePaths: string[]) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}

async function hashFileInput(filePath: string) {
  const stat = await fs.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = closureInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = fs
    .readFile(filePath, "utf-8")
    .then((contents) => hashContent(contents));
  closureInputHashCache.set(cacheKey, pending);
  return pending;
}

function getCompileJobOutputFiles(
  job: ReturnType<typeof prepareClosureJobs>["compileJobs"][number],
) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) =>
      path.join(job.chunkOutputPathPrefix!, `${chunkSpec.split(":", 1)[0]}.js`),
    );
  }
  throw new Error("Closure compile job is missing output configuration.");
}

function determineClosureConcurrency(jobCount: number) {
  const fromEnv = Number.parseInt(
    process.env.GCC_CLOSURE_CONCURRENCY ?? "",
    10,
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(jobCount, fromEnv);
  }
  return Math.min(
    jobCount,
    Math.max(1, (os.availableParallelism?.() ?? 2) - 1),
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}
