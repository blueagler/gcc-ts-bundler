import fs from "fs/promises";
import path from "path";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

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

export async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
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

  for (const job of prepared.compileJobs) {
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
      return { cacheOutputFiles: [], exitCode, outputFiles: [] };
    }
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
