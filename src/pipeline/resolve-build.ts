import path from "path";

import { hashContent, hashJson } from "../cache/hash";
import {
  createCacheStore,
  readJsonIfExists,
  writeJson,
  getDefaultPersistentCacheRoot,
} from "../cache/store";
import { collectTrackedFiles, trackedFilesMatch } from "../internal/file-state";
import {
  BuildContext,
  BuildEntry,
  ChunkPlanChunk,
  LazyImport,
  NormalizedBuildOptions,
  PackageAlias,
  ResolvedBuild,
} from "../internal/types";
import { planChunks, resolveGraph } from "../native/load";
import {
  resolveOutputNames,
  sanitizeChunkName,
  toBuildEntry,
  toShimFiles,
} from "./resolve-build/entries";
import {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
  hashExternalInputs,
  hashTsConfig,
} from "./resolve-build/signatures";
import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
  resolveTsConfigPath,
} from "./resolve-build/workspace";

export { normalizeBuildOptions } from "./resolve-build/options";
export {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
} from "./resolve-build/signatures";

interface ResolveMetadata {
  chunkPlan: ChunkPlanChunk[];
  entryFiles: Array<{
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourceRelativePath: string;
  }>;
  lazyImports: LazyImport[];
}

interface ResolveSnapshot {
  compilerOptionsHash: string;
  entryFiles: ResolveMetadata["entryFiles"];
  finalKey: string;
  lazyImports: LazyImport[];
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
  const usesPersistentCache = options.cache.mode === "persistent";
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot,
    packageSignature: usesPersistentCache
      ? await getPackageSignature(packageRoot)
      : "",
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
  const usesPersistentCache = options.cache.mode === "persistent";
  const sourceRoot = path.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);

  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = usesPersistentCache
    ? await hashTsConfig(tsConfigPath)
    : "";
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
  const cachedSnapshot = usesPersistentCache
    ? await readJsonIfExists<ResolveSnapshot>(resolveSnapshotPath)
    : null;
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
      (entry): BuildEntry => toBuildEntry(entry, sourceRoot),
    );
    const shimDir = path.join(cacheStore.workspaceDir, "entries");
    const shimFiles = toShimFiles(entryFiles, shimDir);

    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(
        cacheStore.projectCacheDir,
        cachedSnapshot.resolveKey,
      ),
      entryFiles,
      lazyImports: cachedSnapshot.lazyImports ?? [],
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
      shimFiles,
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
  const resolvedLazyImports = graphResult.lazyImports;
  const resolveKey = usesPersistentCache
    ? hashJson({
        compilerOptionsHash,
        entries: entryRelativePaths,
        files: graphResult.fileHashes,
        packageSignature: context.packageSignature,
      })
    : "active";
  const resolveMetadataPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  let resolveMetadata = usesPersistentCache
    ? await readJsonIfExists<ResolveMetadata>(resolveMetadataPath)
    : null;

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
    const shimFiles = toShimFiles(entryFiles, shimDir);
    resolveMetadata = {
      chunkPlan: planChunks({
        baseChunkName: options.chunks.baseChunkName,
        chunkMode: options.chunks.mode,
        entryFiles: entryFiles.map((entry) => ({
          chunkName: entry.chunkName,
          outputName: entry.outputName,
          sourcePath: entry.sourcePath,
        })),
        graphEntries: [
          ...Object.entries(graphResult.graph).map(
            ([filePath, dependencies]) => ({
              dependencies,
              filePath,
            }),
          ),
          ...shimFiles.map((shimFile, index) => ({
            dependencies: [entryFiles[index].sourcePath],
            filePath: shimFile,
          })),
        ],
        lazyImports: resolvedLazyImports,
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
      lazyImports: resolvedLazyImports,
    };
    if (usesPersistentCache) {
      await writeJson(resolveMetadataPath, resolveMetadata);
    }
  }

  const entryFiles = resolveMetadata.entryFiles.map(
    (entry): BuildEntry => toBuildEntry(entry, sourceRoot),
  );
  const shimDir = path.join(cacheStore.workspaceDir, "entries");
  const shimFiles = toShimFiles(entryFiles, shimDir);
  const nativeEmitKey = usesPersistentCache
    ? hashJson({
        compilerOptionsHash,
        diagnostics: options.diagnostics,
        packageSignature: context.packageSignature,
        resolveKey,
      })
    : "active";
  const finalKey = usesPersistentCache
    ? hashJson({
        compilationLevel: options.compilationLevel,
        externalInputHash: await hashExternalInputs([
          ...options.externs,
          ...options.js,
        ]),
        languageOut: options.languageOut,
        packageSignature: context.packageSignature,
        resolveKey,
      })
    : "active";
  const trackedFiles = usesPersistentCache
    ? await collectTrackedFiles([
        ...graphResult.trackedFiles,
        tsConfigPath,
        ...options.externs,
        ...options.js,
      ])
    : {};
  if (usesPersistentCache) {
    await writeJson(resolveSnapshotPath, {
      compilerOptionsHash,
      entryFiles: resolveMetadata.entryFiles,
      finalKey,
      lazyImports: resolvedLazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases: graphResult.packageAliases,
      packageJsonFiles: graphResult.packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey,
      sourceFiles: graphResult.sourceFiles,
      trackedFiles,
    } satisfies ResolveSnapshot);
  }

  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    lazyImports: resolvedLazyImports,
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
