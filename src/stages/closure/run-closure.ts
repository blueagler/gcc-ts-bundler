import fs from "fs/promises";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
import path from "path";

import { BuildEntry, NormalizedBuildOptions } from "../../api/types";
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
  files: string[];
  isEntryChunk: boolean;
  name: string;
}

export interface ClosureStageResult {
  exitCode: number;
  outputFiles: string[];
}

const closureLibFilesCache = new Map<string, Promise<string[]>>();

export async function runClosureStage({
  emittedOutDir,
  entryFiles,
  externPaths,
  finalCacheDir,
  graph,
  options,
  packageRoot,
  shimFiles,
  workspaceDir,
}: {
  emittedOutDir: string;
  entryFiles: BuildEntry[];
  externPaths: string[];
  finalCacheDir: string;
  graph: Record<string, string[]>;
  options: NormalizedBuildOptions;
  packageRoot: string;
  shimFiles: string[];
  workspaceDir: string;
}): Promise<ClosureStageResult> {
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await fs.mkdir(finalCacheDir, { recursive: true });

  const rawDir = path.join(finalCacheDir, "raw");
  const outputDir = path.join(finalCacheDir, "outputs");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  const closureLibFiles = await collectClosureLibFiles(packageRoot);
  const chunkPlan = buildChunkPlan({
    entryFiles,
    graph,
    shimFiles,
    workspaceDir,
    emittedOutDir,
  });

  const exitCode =
    chunkPlan.length === 1
      ? await runSingleClosureCompilation({
          closureLibFiles,
          entryChunk: chunkPlan[0],
          externPaths,
          options,
          rawOutputPath: path.join(rawDir, `${chunkPlan[0].name}.js`),
        })
      : await runChunkedClosureCompilation({
          chunkPlan,
          closureLibFiles,
          externPaths,
          options,
          outputDir: rawDir,
        });

  if (exitCode !== 0) {
    return { exitCode, outputFiles: [] };
  }

  const rawOutputs = chunkPlan.map((chunk) =>
    path.join(rawDir, `${chunk.name}.js`),
  );
  const outputFiles = chunkPlan.map((chunk) =>
    path.join(outputDir, `${chunk.name}.js`),
  );
  await Promise.all(
    rawOutputs.map(async (rawFile, index) => {
      const contents = await fs.readFile(rawFile, "utf-8");
      const transformed = rewriteGccExports(contents);
      await fs.writeFile(outputFiles[index], transformed);
    }),
  );

  return { exitCode: 0, outputFiles };
}

async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  rawOutputPath,
}: {
  closureLibFiles: string[];
  entryChunk: ClosureChunk;
  externPaths: string[];
  options: NormalizedBuildOptions;
  rawOutputPath: string;
}) {
  return runClosureCompiler({
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "NONE",
    externs: externPaths,
    js: [...options.js, ...closureLibFiles, ...entryChunk.files],
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    moduleResolution: "NODE",
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
  });
}

async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir,
}: {
  chunkPlan: ClosureChunk[];
  closureLibFiles: string[];
  externPaths: string[];
  options: NormalizedBuildOptions;
  outputDir: string;
}) {
  const leadingJs = [...options.js, ...closureLibFiles];
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix =
      chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${chunk.files.length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = [
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files),
  ];

  return runClosureCompiler({
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${path.sep}`,
    chunkOutputType: "ES_MODULES",
    dependencyMode: "NONE",
    externs: externPaths,
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    moduleResolution: "NODE",
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
  });
}

function buildChunkPlan({
  emittedOutDir,
  entryFiles,
  graph,
  shimFiles,
  workspaceDir,
}: {
  emittedOutDir: string;
  entryFiles: BuildEntry[];
  graph: Record<string, string[]>;
  shimFiles: string[];
  workspaceDir: string;
}): ClosureChunk[] {
  const shimToEntry = new Map(
    shimFiles.map((shimFile, index) => [shimFile, entryFiles[index]]),
  );
  const reachability = new Map<string, Set<string>>();
  const counts = new Map<string, number>();

  for (const shimFile of shimFiles) {
    const reachable = walkReachableFiles(shimFile, graph);
    reachability.set(shimFile, reachable);
    for (const filePath of reachable) {
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
    }
  }

  const sharedFiles = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([filePath]) => filePath),
  );
  const chunks: ClosureChunk[] = [];

  if (entryFiles.length === 1) {
    const [onlyEntry] = entryFiles;
    const [onlyShim] = shimFiles;
    chunks.push({
      dependencies: [],
      files: toEmittedPaths(
        topologicalSort(Array.from(reachability.get(onlyShim) ?? []), graph),
        emittedOutDir,
        workspaceDir,
      ),
      isEntryChunk: true,
      name: stripExtension(onlyEntry.outputName),
    });
    return chunks;
  }

  if (sharedFiles.size > 0) {
    chunks.push({
      dependencies: [],
      files: toEmittedPaths(
        topologicalSort(Array.from(sharedFiles), graph),
        emittedOutDir,
        workspaceDir,
      ),
      isEntryChunk: false,
      name: "shared",
    });
  }

  for (const shimFile of shimFiles) {
    const entry = shimToEntry.get(shimFile)!;
    const reachable = reachability.get(shimFile) ?? new Set<string>();
    const uniqueFiles = Array.from(reachable).filter(
      (filePath) => !sharedFiles.has(filePath),
    );
    chunks.push({
      dependencies: sharedFiles.size > 0 ? ["shared"] : [],
      files: toEmittedPaths(
        topologicalSort(uniqueFiles, graph),
        emittedOutDir,
        workspaceDir,
      ),
      isEntryChunk: true,
      name: stripExtension(entry.outputName),
    });
  }

  return chunks;
}

function walkReachableFiles(
  entryFile: string,
  graph: Record<string, string[]>,
): Set<string> {
  const reachable = new Set<string>();
  const pending = [entryFile];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const dependency of graph[current] ?? []) {
      pending.push(dependency);
    }
  }

  return reachable;
}

function topologicalSort(
  files: string[],
  graph: Record<string, string[]>,
): string[] {
  const fileSet = new Set(files);
  const visited = new Set<string>();
  const ordered: string[] = [];

  function visit(filePath: string) {
    if (visited.has(filePath)) {
      return;
    }

    visited.add(filePath);
    for (const dependency of graph[filePath] ?? []) {
      if (fileSet.has(dependency)) {
        visit(dependency);
      }
    }

    ordered.push(filePath);
  }

  [...files].sort((left, right) => left.localeCompare(right)).forEach(visit);
  return ordered;
}

function toEmittedPaths(
  files: string[],
  emittedOutDir: string,
  workspaceDir: string,
): string[] {
  return files.map((filePath) =>
    path.join(
      emittedOutDir,
      path.relative(workspaceDir, filePath).replace(/\.[^/.]+$/, ".js"),
    ),
  );
}

function stripExtension(filePath: string) {
  return filePath.replace(/\.[^/.]+$/, "");
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
