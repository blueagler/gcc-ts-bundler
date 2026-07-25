import path from "path";

import { hashJson } from "../../shared/hash";
import {
  createCacheStore,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
  getDefaultPersistentCacheRoot,
} from "../../shared/cache-store";
import { zipExact } from "../../shared/arrays";
import { collectTrackedFiles, trackedFilesMatch } from "../../shared/file-state";
import type {
  BuildContext,
  BuildEntry,
  ResolvedBuildOptions,
  ResolvedBuild,
} from "../types";
import { planChunks, resolveGraph } from "../../native/load";
import {
  resolveOutputNames,
  sanitizeChunkName,
  toBuildEntry,
  toShimFiles,
} from "./entries";
import {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
  hashExternalInputs,
  hashTsConfig,
} from "./signatures";
import type { ResolveSnapshot } from "./cache";
import {
  isResolveMetadata,
  isResolveSnapshot,
  readChunkPlan,
} from "./cache";
import {
  collectTsxRuntimeSupport,
  mergePackageAliases,
  mergeRuntimePackageJsonFiles,
  mergeTsxRuntimeTrackedFiles,
} from "./jsx-runtime";
import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
  resolveTsConfigPath,
} from "./workspace";
import { logInternalDetail } from "../../shared/timing";

export { normalizeBuildOptions } from "./options";
export {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
} from "./signatures";

export async function createBuildContext(
  options: ResolvedBuildOptions,
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
    projectCacheDir: getProjectCacheDir(
      path.resolve(options.cache.dir || getDefaultPersistentCacheRoot()),
      options.projectRoot,
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
    path.relative(options.srcDir, entry.file),
  );
  const overlayEntries = options.entries.map((entry) =>
    path.join(sourceRoot, path.relative(options.srcDir, entry.file)),
  );
  const resolveSnapshotPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    "latest.json",
  );
  const cachedSnapshot = usesPersistentCache
    ? await readJsonIfExists(resolveSnapshotPath, isResolveSnapshot)
    : null;
  const resolveSnapshotHit =
    !!cachedSnapshot &&
    Array.isArray(cachedSnapshot.packageAliases) &&
    Array.isArray(cachedSnapshot.sourceFiles) &&
    Array.isArray(cachedSnapshot.packageJsonFiles) &&
    cachedSnapshot.packageSignature === context.packageSignature &&
    cachedSnapshot.compilerOptionsHash === compilerOptionsHash &&
    cachedSnapshot.optionsSignature === context.optionsSignature &&
    (await trackedFilesMatch(cachedSnapshot.trackedFiles));
  if (usesPersistentCache) {
    logInternalDetail(
      "cache:resolve-snapshot",
      resolveSnapshotHit ? "hit" : "miss",
    );
  }
  if (cachedSnapshot && resolveSnapshotHit) {
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
      tsxRuntimeSourceFiles: cachedSnapshot.tsxRuntimeSourceFiles ?? [],
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir,
    };
  }

  const graphResult = resolveGraph({
    entries: overlayEntries,
    packageMode: options.packages,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir,
  });
  const outputNames = resolveOutputNames(
    zipExact(options.entries, entryRelativePaths, "entries").map(
      ([entry, relativePath]) => ({ name: entry.name, relativePath }),
    ),
  );
  const resolvedLazyImports = graphResult.lazyImports;
  const tsxRuntimeSupport = await collectTsxRuntimeSupport({
    fileNames: graphResult.sourceFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir,
  });
  const packageAliases = mergePackageAliases([
    ...graphResult.packageAliases,
    ...tsxRuntimeSupport.packageAliases,
  ]);
  const packageJsonFiles = mergeRuntimePackageJsonFiles(
    graphResult.packageJsonFiles,
    tsxRuntimeSupport.packageJsonFiles,
  );
  const resolveKey = usesPersistentCache
    ? hashJson({
        compilerOptionsHash,
        entries: entryRelativePaths,
        files: graphResult.fileHashes,
        packageSignature: context.packageSignature,
        tsxRuntimeSourceFiles: tsxRuntimeSupport.sourceFiles,
      })
    : "active";
  const resolveMetadataPath = path.join(
    cacheStore.projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  let resolveMetadata = usesPersistentCache
    ? await readJsonIfExists(resolveMetadataPath, isResolveMetadata)
    : null;
  if (resolveMetadata) {
    resolveMetadata = {
      ...resolveMetadata,
      packageAliases: resolveMetadata.packageAliases ?? packageAliases,
      packageJsonFiles: resolveMetadata.packageJsonFiles ?? packageJsonFiles,
      tsxRuntimeSourceFiles:
        resolveMetadata.tsxRuntimeSourceFiles ?? tsxRuntimeSupport.sourceFiles,
    };
  }

  if (!resolveMetadata) {
    const entryFiles = zipExact(
      graphResult.entries,
      outputNames,
      "resolved entries and output names",
    ).map(
      ([entry, outputName]): BuildEntry => ({
        chunkName: sanitizeChunkName(outputName),
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName,
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
          ...zipExact(
            shimFiles,
            entryFiles,
            "entry shims and resolved entries",
          ).map(([shimFile, entry]) => ({
            dependencies: [entry.sourcePath],
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
      packageAliases,
      packageJsonFiles,
      tsxRuntimeSourceFiles: tsxRuntimeSupport.sourceFiles,
    };
    if (usesPersistentCache) {
      await writeJson(resolveMetadataPath, resolveMetadata);
    }
  } else if (
    usesPersistentCache &&
    (!Array.isArray(resolveMetadata.packageAliases) ||
      !Array.isArray(resolveMetadata.packageJsonFiles) ||
      !Array.isArray(resolveMetadata.tsxRuntimeSourceFiles))
  ) {
    await writeJson(resolveMetadataPath, resolveMetadata);
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
        externInputHash: await hashExternalInputs(options.externs),
        packageSignature: context.packageSignature,
        resolveKey,
        tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
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
        tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
      })
    : "active";
  const trackedFiles = usesPersistentCache
    ? await collectTrackedFiles([
        ...mergeTsxRuntimeTrackedFiles(
          graphResult.trackedFiles,
          tsxRuntimeSupport.trackedFiles,
        ),
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
      packageAliases,
      packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey,
      sourceFiles: graphResult.sourceFiles,
      tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
      trackedFiles,
    } satisfies ResolveSnapshot);
  }

  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    lazyImports: resolvedLazyImports,
    packageAliases,
    packageJsonFiles,
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
    tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir,
  };
}
