import fs from "fs";
import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

import {
  BuildEntry,
  BuildOptions,
  NormalizedBuildOptions,
  ResolvedBuild,
} from "../api/types";
import { createCacheStore, readJsonIfExists, writeJson } from "../cache/store";
import { hashContent, hashJson } from "../cache/hash";
import { resolveGraph } from "../native/load";

interface ResolveMetadata {
  entryFiles: Array<{
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourceRelativePath: string;
  }>;
  graph: Record<string, string[]>;
}

interface ResolveSnapshot {
  compilerOptionsHash: string;
  entryFiles: ResolveMetadata["entryFiles"];
  externalInputHash: string;
  fileHashes: Record<string, string>;
  filePaths: string[];
  finalKey: string;
  graph: Record<string, string[]>;
  nativeEmitKey: string;
  optionsSignature: string;
  packageSignature: string;
  resolveKey: string;
  trackedFiles: Record<string, { mtimeMs: number; size: number }>;
}

export async function resolveBuild(
  options: NormalizedBuildOptions,
): Promise<ResolvedBuild> {
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot,
  });
  const packageRoot = getPackageRoot();
  const packageJsonRaw = await fs.promises.readFile(
    path.join(packageRoot, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonRaw) as { version: string };
  const packageSignature = await getPackageSignature(packageRoot);
  const sourceRoot = path.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);

  const compilerOptions = await loadCompilerOptions(options.projectRoot);
  const compilerOptionsHash = hashJson(compilerOptions);
  const entryRelativePaths = options.entries.map((entry) =>
    path.relative(options.srcDir, entry),
  );
  const optionsSignature = getOptionsSignature(options);
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
    cachedSnapshot.packageSignature === packageSignature &&
    cachedSnapshot.compilerOptionsHash === compilerOptionsHash &&
    cachedSnapshot.optionsSignature === optionsSignature &&
    (await trackedFilesMatch(cachedSnapshot.trackedFiles))
  ) {
    const entryFiles = cachedSnapshot.entryFiles.map(
      (entry): BuildEntry => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        outputPath: path.join(options.outDir, entry.outputName),
        sourcePath: path.join(sourceRoot, entry.sourceRelativePath),
        sourceRelativePath: entry.sourceRelativePath,
      }),
    );
    const shimDir = path.join(cacheStore.workspaceDir, "entries");

    return {
      cacheRoot: cacheStore.rootDir,
      cleanup: cacheStore.cleanup,
      compilerOptions,
      entryFiles,
      externalInputHash: cachedSnapshot.externalInputHash,
      fileHashes: cachedSnapshot.fileHashes,
      filePaths: cachedSnapshot.filePaths,
      finalCacheDir: path.join(
        cacheStore.projectCacheDir,
        "final",
        cachedSnapshot.finalKey,
      ),
      finalKey: cachedSnapshot.finalKey,
      graph: fromRelativeGraph(cachedSnapshot.graph, cacheStore.workspaceDir),
      isFinalCacheHit: false,
      isNativeEmitCacheHit: false,
      isResolveCacheHit: true,
      options,
      packageRoot,
      packageVersion: packageJson.version,
      projectCacheDir: cacheStore.projectCacheDir,
      resolveKey: cachedSnapshot.resolveKey,
      resolveMetadataPath: resolveSnapshotPath,
      sharedChunkName: entryFiles.length > 1 ? "shared" : null,
      shimDir,
      shimFiles: entryFiles.map((entry) =>
        path.join(shimDir, `${entry.chunkName}.ts`),
      ),
      sourceRoot,
      tsConfigPath: path.join(options.projectRoot, "tsconfig.json"),
      nativeEmitCacheDir: path.join(
        cacheStore.projectCacheDir,
        "native-emit",
        cachedSnapshot.nativeEmitKey,
      ),
      nativeEmitKey: cachedSnapshot.nativeEmitKey,
      workspaceDir: cacheStore.workspaceDir,
    };
  }
  const graphResult = resolveGraph({
    entries: overlayEntries,
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
    packageSignature,
  });
  const resolveMetadataPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  let resolveMetadata =
    await readJsonIfExists<ResolveMetadata>(resolveMetadataPath);
  const isResolveCacheHit = resolveMetadata !== null;
  if (!resolveMetadata) {
    resolveMetadata = {
      entryFiles: graphResult.entries.map((entry, index) => ({
        chunkName: sanitizeChunkName(outputNames[index]),
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: outputNames[index],
        sourceRelativePath: path.relative(sourceRoot, entry.sourcePath),
      })),
      graph: toRelativeGraph(graphResult.graph, cacheStore.workspaceDir),
    };
    await writeJson(resolveMetadataPath, resolveMetadata);
  }

  const entryFiles = resolveMetadata.entryFiles.map(
    (entry): BuildEntry => ({
      chunkName: entry.chunkName,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: entry.outputName,
      outputPath: path.join(options.outDir, entry.outputName),
      sourcePath: path.join(sourceRoot, entry.sourceRelativePath),
      sourceRelativePath: entry.sourceRelativePath,
    }),
  );
  const shimDir = path.join(cacheStore.workspaceDir, "entries");
  const externalInputHash = await hashExternalInputs([
    ...options.externs,
    ...options.js,
  ]);
  const nativeEmitKey = hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    packageSignature,
    resolveKey,
  });
  const finalKey = hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash,
    languageOut: options.languageOut,
    packageSignature,
    nativeEmitKey,
    resolveKey,
  });
  const trackedFiles = await collectTrackedFiles([
    ...graphResult.filePaths,
    path.join(options.projectRoot, "tsconfig.json"),
    ...options.externs,
    ...options.js,
  ]);
  await writeJson(resolveSnapshotPath, {
    compilerOptionsHash,
    entryFiles: resolveMetadata.entryFiles,
    externalInputHash,
    fileHashes: graphResult.fileHashes,
    filePaths: graphResult.filePaths,
    finalKey,
    graph: resolveMetadata.graph,
    nativeEmitKey,
    optionsSignature,
    packageSignature,
    resolveKey,
    trackedFiles,
  } satisfies ResolveSnapshot);

  return {
    cacheRoot: cacheStore.rootDir,
    cleanup: cacheStore.cleanup,
    compilerOptions,
    entryFiles,
    externalInputHash,
    fileHashes: graphResult.fileHashes,
    filePaths: graphResult.filePaths,
    finalCacheDir: path.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    graph: fromRelativeGraph(resolveMetadata.graph, cacheStore.workspaceDir),
    isFinalCacheHit: false,
    isNativeEmitCacheHit: false,
    isResolveCacheHit,
    options,
    packageRoot,
    packageVersion: packageJson.version,
    projectCacheDir: cacheStore.projectCacheDir,
    resolveKey,
    resolveMetadataPath,
    sharedChunkName: entryFiles.length > 1 ? "shared" : null,
    shimDir,
    shimFiles: entryFiles.map((entry) =>
      path.join(shimDir, `${entry.chunkName}.ts`),
    ),
    sourceRoot,
    tsConfigPath: path.join(options.projectRoot, "tsconfig.json"),
    nativeEmitCacheDir: path.join(
      cacheStore.projectCacheDir,
      "native-emit",
      nativeEmitKey,
    ),
    nativeEmitKey,
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

async function ensureSourceSymlink(linkPath: string, targetPath: string) {
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

async function loadCompilerOptions(
  projectRoot: string,
): Promise<ts.CompilerOptions> {
  const configPath = ts.findConfigFile(
    projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    projectRoot,
    {},
    configPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsedConfig.errors,
        ts.createCompilerHost({}),
      ),
    );
  }

  return parsedConfig.options;
}

function toRelativeGraph(
  graph: Record<string, string[]>,
  workspaceDir: string,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(graph).map(([filePath, dependencies]) => [
      path.relative(workspaceDir, filePath),
      dependencies.map((dependency) => path.relative(workspaceDir, dependency)),
    ]),
  );
}

function fromRelativeGraph(
  graph: Record<string, string[]>,
  workspaceDir: string,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(graph).map(([filePath, dependencies]) => [
      path.join(workspaceDir, filePath),
      dependencies.map((dependency) => path.join(workspaceDir, dependency)),
    ]),
  );
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

async function collectTrackedFiles(filePaths: string[]) {
  const trackedEntries = await Promise.all(
    [...new Set(filePaths)]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => {
        const stat = await fs.promises.stat(filePath);
        return [
          filePath,
          {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          },
        ] as const;
      }),
  );

  return Object.fromEntries(trackedEntries);
}

async function trackedFilesMatch(
  trackedFiles: Record<string, { mtimeMs: number; size: number }>,
) {
  return (
    await Promise.all(
      Object.entries(trackedFiles).map(async ([filePath, expected]) => {
        try {
          const stat = await fs.promises.stat(filePath);
          return (
            stat.mtimeMs === expected.mtimeMs && stat.size === expected.size
          );
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
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
    projectRoot: options.projectRoot,
    srcDir: options.srcDir,
  });
}

export function normalizeBuildOptions(
  options: BuildOptions,
): NormalizedBuildOptions {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? "src");
  const outDir = path.resolve(projectRoot, options.outDir ?? "dist");

  return {
    cache: {
      dir: options.cache?.dir
        ? path.resolve(projectRoot, options.cache.dir)
        : "",
      mode: options.cache?.mode ?? "persistent",
    },
    compilationLevel: options.compilationLevel ?? "ADVANCED",
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? false,
      preflight: options.diagnostics?.preflight ?? "errors-only",
      verbose: options.diagnostics?.verbose ?? false,
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
    languageOut: options.languageOut ?? "ECMASCRIPT_NEXT",
    outDir,
    outputNames: [...(options.outputNames ?? [])],
    projectRoot,
    srcDir,
  };
}
