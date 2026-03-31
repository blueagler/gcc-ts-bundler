import fs from "fs";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

import { BuildOptions, DEFAULT_BUILD_OPTIONS } from "../api/types";
import { hashContent, hashJson } from "../cache/hash";
import {
  createCacheStore,
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import { collectTrackedFiles, trackedFilesMatch } from "../internal/file-state";
import {
  BuildContext,
  BuildEntry,
  ChunkPlanChunk,
  NormalizedBuildOptions,
  PackageAlias,
  ResolvedBuild,
} from "../internal/types";
import { resolveGraph } from "../native/load";

interface ResolveMetadata {
  chunkPlan: ChunkPlanChunk[];
  entryFiles: Array<{
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourceRelativePath: string;
  }>;
}

interface ResolveSnapshot {
  compilerOptionsHash: string;
  entryFiles: ResolveMetadata["entryFiles"];
  finalKey: string;
  nativeEmitKey: string;
  optionsSignature: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  packageSignature: string;
  resolveKey: string;
  sourceFiles: string[];
  trackedFiles: Awaited<ReturnType<typeof collectTrackedFiles>>;
}

export async function createBuildContext(
  options: NormalizedBuildOptions,
): Promise<BuildContext> {
  const packageRoot = getPackageRoot();
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot,
    packageSignature: await getPackageSignature(packageRoot),
    projectCacheDir: path.join(
      path.resolve(options.cache.dir || getDefaultPersistentCacheRoot()),
      hashContent(options.projectRoot),
    ),
  };
}

export async function resolveBuild(
  context: BuildContext,
): Promise<ResolvedBuild> {
  const { options } = context;
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot,
  });
  const sourceRoot = path.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);

  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = await hashTsConfig(tsConfigPath);
  const entryRelativePaths = options.entries.map((entry) =>
    path.relative(options.srcDir, entry),
  );
  const overlayEntries = options.entries.map((entry) =>
    path.join(sourceRoot, path.relative(options.srcDir, entry)),
  );
  const resolveSnapshotPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    "latest.json",
  );
  const cachedSnapshot =
    await readJsonIfExists<ResolveSnapshot>(resolveSnapshotPath);
  if (
    cachedSnapshot &&
    Array.isArray(cachedSnapshot.packageAliases) &&
    Array.isArray(cachedSnapshot.sourceFiles) &&
    Array.isArray(cachedSnapshot.packageJsonFiles) &&
    cachedSnapshot.packageSignature === context.packageSignature &&
    cachedSnapshot.compilerOptionsHash === compilerOptionsHash &&
    cachedSnapshot.optionsSignature === context.optionsSignature &&
    (await trackedFilesMatch(cachedSnapshot.trackedFiles))
  ) {
    const entryFiles = cachedSnapshot.entryFiles.map(
      (entry): BuildEntry => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourcePath: path.join(sourceRoot, entry.sourceRelativePath),
        sourceRelativePath: entry.sourceRelativePath,
      }),
    );
    const shimDir = path.join(cacheStore.workspaceDir, "entries");

    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(
        cacheStore.projectCacheDir,
        cachedSnapshot.resolveKey,
      ),
      entryFiles,
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: path.join(
        cacheStore.projectCacheDir,
        "final",
        cachedSnapshot.finalKey,
      ),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: path.join(
        cacheStore.projectCacheDir,
        "native-emit",
        cachedSnapshot.nativeEmitKey,
      ),
      shimDir,
      shimFiles: entryFiles.map((entry) =>
        path.join(shimDir, `${entry.chunkName}.ts`),
      ),
      sourceFiles: cachedSnapshot.sourceFiles,
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir,
    };
  }

  const graphResult = resolveGraph({
    entries: overlayEntries,
    packageMode: options.packages.mode,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir,
  });
  const outputNames = resolveOutputNames(
    entryRelativePaths,
    options.outputNames,
  );
  const resolveKey = hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature,
  });
  const resolveMetadataPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  let resolveMetadata =
    await readJsonIfExists<ResolveMetadata>(resolveMetadataPath);

  if (!resolveMetadata) {
    const entryFiles = graphResult.entries.map(
      (entry, index): BuildEntry => ({
        chunkName: sanitizeChunkName(outputNames[index]),
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: outputNames[index],
        sourcePath: entry.sourcePath,
        sourceRelativePath: path.relative(sourceRoot, entry.sourcePath),
      }),
    );
    const shimDir = path.join(cacheStore.workspaceDir, "entries");
    const shimFiles = entryFiles.map((entry) =>
      path.join(shimDir, `${entry.chunkName}.ts`),
    );
    resolveMetadata = {
      chunkPlan: buildChunkPlan({
        entryFiles,
        graph: {
          ...graphResult.graph,
          ...Object.fromEntries(
            shimFiles.map((shimFile, index) => [
              shimFile,
              [entryFiles[index].sourcePath],
            ]),
          ),
        },
        shimFiles,
        workspaceDir: cacheStore.workspaceDir,
      }),
      entryFiles: entryFiles.map((entry) => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath,
      })),
    };
    await writeJson(resolveMetadataPath, resolveMetadata);
  }

  const entryFiles = resolveMetadata.entryFiles.map(
    (entry): BuildEntry => ({
      chunkName: entry.chunkName,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: entry.outputName,
      sourcePath: path.join(sourceRoot, entry.sourceRelativePath),
      sourceRelativePath: entry.sourceRelativePath,
    }),
  );
  const shimDir = path.join(cacheStore.workspaceDir, "entries");
  const shimFiles = entryFiles.map((entry) =>
    path.join(shimDir, `${entry.chunkName}.ts`),
  );
  const nativeEmitKey = hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    packageSignature: context.packageSignature,
    resolveKey,
  });
  const finalKey = hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash: await hashExternalInputs([
      ...options.externs,
      ...options.js,
    ]),
    languageOut: options.languageOut,
    packageSignature: context.packageSignature,
    resolveKey,
  });
  const trackedFiles = await collectTrackedFiles([
    ...graphResult.trackedFiles,
    tsConfigPath,
    ...options.externs,
    ...options.js,
  ]);
  await writeJson(resolveSnapshotPath, {
    compilerOptionsHash,
    entryFiles: resolveMetadata.entryFiles,
    finalKey,
    nativeEmitKey,
    optionsSignature: context.optionsSignature,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    packageSignature: context.packageSignature,
    resolveKey,
    sourceFiles: graphResult.sourceFiles,
    trackedFiles,
  } satisfies ResolveSnapshot);

  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    finalCacheDir: path.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: path.join(
      cacheStore.projectCacheDir,
      "native-emit",
      nativeEmitKey,
    ),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir,
  };
}

function resolveOutputNames(
  entryPaths: string[],
  outputNames: string[],
): string[] {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }

    return outputNames;
  }

  const basenameCounts = new Map<string, number>();
  const basenames = entryPaths.map((entryPath) =>
    path.basename(entryPath).replace(/\.[^/.]+$/, ".js"),
  );

  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }

  return entryPaths.map((entryPath, index) => {
    const basename = basenames[index];
    if ((basenameCounts.get(basename) ?? 0) === 1) {
      return basename;
    }

    return `${entryPath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
  });
}

function sanitizeChunkName(outputName: string): string {
  return outputName.replace(/\.js$/, "").replace(/[^\w-]/g, "-");
}

async function ensureDirectorySymlink(linkPath: string, targetPath: string) {
  try {
    const currentTarget = await fs.promises.readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await fs.promises.rm(linkPath, { force: true, recursive: true });
    }
  }

  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.promises.symlink(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function ensureWorkspaceNodeModules(
  workspaceDir: string,
  options: NormalizedBuildOptions,
) {
  const linkPath = path.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }

  const nodeModulesPath = path.join(options.projectRoot, "node_modules");
  const hasNodeModules = await fs.promises
    .access(nodeModulesPath)
    .then(() => true)
    .catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }

  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}

async function removePathIfExists(targetPath: string) {
  try {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function resolveTsConfigPath(projectRoot: string): Promise<string> {
  const configPath = ts.findConfigFile(
    projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }

  return configPath;
}

async function hashTsConfig(configPath: string): Promise<string> {
  return hashContent(await fs.promises.readFile(configPath, "utf-8"));
}

async function hashExternalInputs(filePaths: string[]): Promise<string> {
  const entries = await Promise.all(
    [...filePaths]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        filePath,
        hash: hashContent(await fs.promises.readFile(filePath, "utf-8")),
      })),
  );
  return hashJson(entries);
}

async function readChunkPlan(projectCacheDir: string, resolveKey: string) {
  const resolveMetadataPath = path.join(
    projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  const metadata = await readJsonIfExists<ResolveMetadata>(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }

  return metadata.chunkPlan;
}

function buildChunkPlan({
  entryFiles,
  graph,
  shimFiles,
  workspaceDir,
}: {
  entryFiles: BuildEntry[];
  graph: Record<string, string[]>;
  shimFiles: string[];
  workspaceDir: string;
}): ChunkPlanChunk[] {
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
  const chunks: ChunkPlanChunk[] = [];

  if (entryFiles.length === 1) {
    const [onlyEntry] = entryFiles;
    const [onlyShim] = shimFiles;
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(
        topologicalSort(Array.from(reachability.get(onlyShim) ?? []), graph),
        workspaceDir,
      ),
      name: stripExtension(onlyEntry.outputName),
    });
    return chunks;
  }

  if (sharedFiles.size > 0) {
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(
        topologicalSort(Array.from(sharedFiles), graph),
        workspaceDir,
      ),
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
      files: toRelativeFiles(topologicalSort(uniqueFiles, graph), workspaceDir),
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

function toRelativeFiles(files: string[], workspaceDir: string): string[] {
  const seenEmittedPaths = new Set<string>();
  const relativeFiles: string[] = [];

  for (const filePath of files) {
    if (filePath.endsWith(".d.ts")) {
      continue;
    }

    const relativeFile = path.relative(workspaceDir, filePath);
    const emittedRelativeFile = relativeFile.replace(/\.[^/.]+$/, ".js");
    if (seenEmittedPaths.has(emittedRelativeFile)) {
      continue;
    }

    seenEmittedPaths.add(emittedRelativeFile);
    relativeFiles.push(relativeFile);
  }

  return relativeFiles;
}

function stripExtension(filePath: string) {
  return filePath.replace(/\.[^/.]+$/, "");
}

export function getPackageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function readRuntimeSignature(packageRoot: string) {
  try {
    const stat = await fs.promises.stat(
      path.join(packageRoot, "dist", "index.mjs"),
    );
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch {
    return "";
  }
}

async function readNativeSignature(packageRoot: string) {
  try {
    const stat = await fs.promises.stat(
      path.join(packageRoot, "native", "index.node"),
    );
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch {
    return "";
  }
}

let packageSignaturePromise: Promise<string> | null = null;

export async function getPackageSignature(packageRoot = getPackageRoot()) {
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await fs.promises.stat(
        path.join(packageRoot, "package.json"),
      );
      const runtimeSignature = await readRuntimeSignature(packageRoot);
      const nativeSignature = await readNativeSignature(packageRoot);
      return hashContent(
        JSON.stringify({
          nativeSignature,
          packageJson: {
            mtimeMs: packageJsonStat.mtimeMs,
            size: packageJsonStat.size,
          },
          runtimeSignature,
        }),
      );
    })();
  }

  return packageSignaturePromise;
}

export function getOptionsSignature(options: NormalizedBuildOptions) {
  return hashJson({
    compilationLevel: options.compilationLevel,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) =>
      path.relative(options.srcDir, entry),
    ),
    externs: [...options.externs].sort(),
    js: [...options.js].sort(),
    languageOut: options.languageOut,
    outDir: options.outDir,
    outputNames: [...options.outputNames],
    packages: options.packages,
    projectRoot: options.projectRoot,
    srcDir: options.srcDir,
  });
}

export function normalizeBuildOptions(
  options: BuildOptions,
): NormalizedBuildOptions {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(
    projectRoot,
    options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"),
  );
  const outDir = path.resolve(
    projectRoot,
    options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"),
  );

  return {
    cache: {
      dir: options.cache?.dir
        ? path.resolve(projectRoot, options.cache.dir)
        : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode,
    },
    compilationLevel:
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings:
        options.diagnostics?.fatalWarnings ??
        DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight:
        options.diagnostics?.preflight ??
        DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose:
        options.diagnostics?.verbose ??
        DEFAULT_BUILD_OPTIONS.diagnostics.verbose,
    },
    entries: options.entries.map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(srcDir, entry),
    ),
    externs: [...(options.externs ?? [])].map((filePath) =>
      path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath),
    ),
    js: [...(options.js ?? [])].map((filePath) =>
      path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath),
    ),
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    outputNames: [...(options.outputNames ?? [])],
    packages: {
      mode: options.packages?.mode ?? DEFAULT_BUILD_OPTIONS.packages.mode,
    },
    projectRoot,
    srcDir,
  };
}
