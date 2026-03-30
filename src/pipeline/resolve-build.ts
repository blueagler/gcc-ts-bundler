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
  const runtimeSignature = await readRuntimeSignature(packageRoot);
  const nativeSignature = await readNativeSignature(packageRoot);
  const packageSignature = hashContent(
    `${packageJsonRaw}\n${runtimeSignature}\n${nativeSignature}`,
  );
  const sourceRoot = path.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);

  const compilerOptions = await loadCompilerOptions(options.projectRoot);
  const overlayEntries = options.entries.map((entry) =>
    path.join(sourceRoot, path.relative(options.srcDir, entry)),
  );
  const graphResult = resolveGraph({
    entries: overlayEntries,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir,
  });
  const outputNames = resolveOutputNames(
    options.entries.map((entry) => path.relative(options.srcDir, entry)),
  );
  const resolveKey = hashJson({
    compilerOptions,
    entries: options.entries.map((entry) =>
      path.relative(options.srcDir, entry),
    ),
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
    compilerOptions,
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

function resolveOutputNames(entryPaths: string[]): string[] {
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

function getPackageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function readRuntimeSignature(packageRoot: string) {
  try {
    return await fs.promises.readFile(
      path.join(packageRoot, "dist", "index.mjs"),
      "utf-8",
    );
  } catch {
    return "";
  }
}

async function readNativeSignature(packageRoot: string) {
  try {
    const contents = await fs.promises.readFile(
      path.join(packageRoot, "native", "index.node"),
    );
    return hashContent(contents.toString("base64"));
  } catch {
    return "";
  }
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
    projectRoot,
    srcDir,
  };
}
