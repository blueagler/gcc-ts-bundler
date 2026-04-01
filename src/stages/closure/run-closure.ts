import fs from "fs/promises";
import path from "path";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import { copyOrLinkFiles } from "../../internal/file-state";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import { rewriteGccExports } from "../../native/load";

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

interface ClosureChunk {
  dependencies: string[];
  entryPoint?: string;
  entryFile?: string;
  files: string[];
  name: string;
}

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

const closureLibFilesCache = new Map<string, Promise<string[]>>();

export async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  externPaths,
  finalCacheDir,
  options,
  outDir,
  supportFiles,
  packageRoot,
}: {
  chunkPlan: ChunkPlanChunk[];
  emittedOutDir: string;
  externPaths: string[];
  finalCacheDir: string;
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

  const closureLibFiles = await collectClosureLibFiles(packageRoot);
  const resolvedChunks = resolveChunkPlan(chunkPlan, emittedOutDir);

  const exitCode =
    resolvedChunks.length === 1
      ? await runSingleClosureCompilation({
          closureLibFiles,
          entryChunk: resolvedChunks[0],
          externPaths,
          options,
          supportFiles,
          rawOutputPath: path.join(rawDir, `${resolvedChunks[0].name}.js`),
        })
      : await runChunkedClosureCompilation({
          chunkPlan: resolvedChunks,
          closureLibFiles,
          externPaths,
          options,
          outputDir: rawDir,
          supportFiles,
        });

  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }

  const rawOutputs = resolvedChunks.map((chunk) =>
    path.join(rawDir, `${chunk.name}.js`),
  );
  const outputFiles = resolvedChunks.map((chunk) =>
    path.join(outDir, `${chunk.name}.js`),
  );
  await Promise.all(
    rawOutputs.map(async (rawFile, index) => {
      const contents = await fs.readFile(rawFile, "utf-8");
      const transformed = rewriteGccExports(contents);
      await fs.writeFile(outputFiles[index], transformed);
    }),
  );

  await copyOrLinkFiles(outputFiles, cacheOutputDir);
  const cacheOutputFiles = outputFiles.map((outputFile) =>
    path.join(cacheOutputDir, path.basename(outputFile)),
  );

  return { cacheOutputFiles, exitCode: 0, outputFiles };
}

async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  supportFiles,
  rawOutputPath,
}: {
  closureLibFiles: string[];
  entryChunk: ClosureChunk;
  externPaths: string[];
  options: NormalizedBuildOptions;
  supportFiles: string[];
  rawOutputPath: string;
}) {
  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: uniquePaths([
      ...options.js,
      ...closureLibFiles,
      ...supportFiles,
      ...entryChunk.files,
    ]),
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
  };
  if (entryChunk.entryPoint) {
    closureOptions.entryPoint = [entryChunk.entryPoint];
  }
  return runClosureCompiler(closureOptions);
}

async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir,
  supportFiles,
}: {
  chunkPlan: ClosureChunk[];
  closureLibFiles: string[];
  externPaths: string[];
  options: NormalizedBuildOptions;
  outputDir: string;
  supportFiles: string[];
}) {
  const leadingJs = uniquePaths([
    ...options.js,
    ...closureLibFiles,
    ...supportFiles,
  ]);
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix =
      chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${uniquePaths(chunk.files).length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = uniquePaths([
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files),
  ]);

  const closureOptions: ClosureCompilerOptions = {
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${path.sep}`,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
  };
  const entryPoints = uniquePaths(
    chunkPlan
      .map((chunk) => chunk.entryPoint)
      .filter((entryPoint): entryPoint is string => Boolean(entryPoint)),
  );
  if (entryPoints.length > 0) {
    closureOptions.entryPoint = entryPoints;
  }
  return runClosureCompiler(closureOptions);
}

function resolveChunkPlan(
  chunkPlan: ChunkPlanChunk[],
  emittedOutDir: string,
): ClosureChunk[] {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    entryFile:
      chunk.files.length > 0
        ? path.join(
            emittedOutDir,
            chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js"),
          )
        : undefined,
    entryPoint:
      chunk.files.length > 0
        ? toGoogModuleId(
            path.join(
              emittedOutDir,
              chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js"),
            ),
            emittedOutDir,
          )
        : undefined,
    files: chunk.files.map((filePath) =>
      path.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js")),
    ),
    name: chunk.name,
  }));
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

function uniquePaths(paths: string[]) {
  return [...new Set(paths)];
}

function toGoogModuleId(filePath: string, moduleRoot: string) {
  const relativePath = path.relative(moduleRoot, filePath).replace(/\\/g, "/");
  const withoutExtension = relativePath.replace(/\.[^/.]+$/, "");
  return `gcc.${withoutExtension
    .split("/")
    .map((segment) => segment.replace(/[^A-Za-z0-9_$]/g, "_"))
    .join(".")}`;
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

async function collectJavaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [dir];

  while (pending.length > 0) {
    const currentDir = pending.pop()!;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

function collectClosureLibFiles(packageRoot: string): Promise<string[]> {
  const closureLibDir = path.join(packageRoot, "closure-lib");
  const existing = closureLibFilesCache.get(closureLibDir);
  if (existing) {
    return existing;
  }

  const filesPromise = collectJavaScriptFiles(closureLibDir);
  closureLibFilesCache.set(closureLibDir, filesPromise);
  return filesPromise;
}
