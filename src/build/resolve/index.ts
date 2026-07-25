import path from "path";

import { planChunks, resolveGraph } from "../../native/load";
import { zipExact } from "../../shared/arrays";
import {
  createCacheStore,
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
} from "../../shared/cache-store";
import {
  collectTrackedFiles,
  trackedFilesMatch,
} from "../../shared/file-state";
import { hashJson } from "../../shared/hash";
import { logInternalDetail } from "../../shared/timing";
import type {
  BuildContext,
  BuildEntry,
  ChunkPlanChunk,
  LazyImport,
  PackageAlias,
  ResolvedBuild,
  ResolvedBuildOptions,
} from "../types";
import type { ResolveMetadata, ResolveSnapshot } from "./cache";
import { isResolveMetadata, isResolveSnapshot, readChunkPlan } from "./cache";
import {
  resolveOutputNames,
  sanitizeChunkName,
  toBuildEntry,
  toShimFiles,
} from "./entries";
import {
  collectTsxRuntimeSupport,
  mergePackageAliases,
  mergeRuntimePackageJsonFiles,
  mergeTsxRuntimeTrackedFiles,
} from "./jsx-runtime";
import {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
  hashExternalInputs,
  hashTsConfig,
} from "./signatures";
import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
  resolveTsConfigPath,
} from "./workspace";

export { normalizeBuildOptions } from "./options";
export {
  getOptionsSignature,
  getPackageRoot,
  getPackageSignature,
} from "./signatures";

interface ResolveEnv {
  cacheStore: Awaited<ReturnType<typeof createCacheStore>>;
  compilerOptionsHash: string;
  sourceRoot: string;
  tsConfigPath: string;
  usesPersistentCache: boolean;
}

interface FreshGraph {
  graphResult: ReturnType<typeof resolveGraph>;
  outputNames: string[];
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  resolveKey: string;
  tsxRuntimeSupport: Awaited<ReturnType<typeof collectTsxRuntimeSupport>>;
}

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
  if (context.options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const env = await prepareResolveWorkspace(context);
  const restored = await restoreResolveSnapshot(context, env);
  if (restored) {
    return restored;
  }

  const fresh = await resolveFreshGraph(context, env);
  const metadata = await loadOrCreateResolveMetadata(context, env, fresh);
  return finalizeResolvedBuild(context, env, fresh, metadata);
}

async function prepareResolveWorkspace(
  context: BuildContext,
): Promise<ResolveEnv> {
  const { options } = context;
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
  return {
    cacheStore,
    compilerOptionsHash: usesPersistentCache
      ? await hashTsConfig(tsConfigPath)
      : "",
    sourceRoot,
    tsConfigPath,
    usesPersistentCache,
  };
}

async function restoreResolveSnapshot(
  context: BuildContext,
  env: ResolveEnv,
): Promise<ResolvedBuild | null> {
  if (!env.usesPersistentCache) {
    return null;
  }

  const snapshot = await readJsonIfExists(
    resolveSnapshotPath(env),
    isResolveSnapshot,
  );
  const snapshotHit =
    !!snapshot &&
    snapshot.packageSignature === context.packageSignature &&
    snapshot.compilerOptionsHash === env.compilerOptionsHash &&
    snapshot.optionsSignature === context.optionsSignature &&
    (await trackedFilesMatch(snapshot.trackedFiles));
  logInternalDetail("cache:resolve-snapshot", snapshotHit ? "hit" : "miss");
  if (!snapshot || !snapshotHit) {
    return null;
  }

  return assembleResolvedBuild(env, {
    chunkPlan: await readChunkPlan(
      env.cacheStore.projectCacheDir,
      snapshot.resolveKey,
    ),
    entryFiles: snapshot.entryFiles.map(
      (entry): BuildEntry => toBuildEntry(entry, env.sourceRoot),
    ),
    finalKey: snapshot.finalKey,
    lazyImports: snapshot.lazyImports,
    nativeEmitKey: snapshot.nativeEmitKey,
    packageAliases: snapshot.packageAliases,
    packageJsonFiles: snapshot.packageJsonFiles,
    sourceFiles: snapshot.sourceFiles,
    trackedFiles: snapshot.trackedFiles,
    tsxRuntimeSourceFiles: snapshot.tsxRuntimeSourceFiles,
  });
}

async function resolveFreshGraph(
  context: BuildContext,
  env: ResolveEnv,
): Promise<FreshGraph> {
  const { options } = context;
  const entryRelativePaths = options.entries.map((entry) =>
    path.relative(options.srcDir, entry.file),
  );
  const graphResult = resolveGraph({
    entries: options.entries.map((entry) =>
      path.join(env.sourceRoot, path.relative(options.srcDir, entry.file)),
    ),
    packageMode: options.packages,
    srcDir: env.sourceRoot,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  const outputNames = resolveOutputNames(
    zipExact(options.entries, entryRelativePaths, "entries").map(
      ([entry, relativePath]) => ({ name: entry.name, relativePath }),
    ),
  );
  const tsxRuntimeSupport = await collectTsxRuntimeSupport({
    fileNames: graphResult.sourceFiles,
    tsConfigPath: env.tsConfigPath,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  return {
    graphResult,
    outputNames,
    packageAliases: mergePackageAliases([
      ...graphResult.packageAliases,
      ...tsxRuntimeSupport.packageAliases,
    ]),
    packageJsonFiles: mergeRuntimePackageJsonFiles(
      graphResult.packageJsonFiles,
      tsxRuntimeSupport.packageJsonFiles,
    ),
    resolveKey: env.usesPersistentCache
      ? hashJson({
          compilerOptionsHash: env.compilerOptionsHash,
          entries: entryRelativePaths,
          files: graphResult.fileHashes,
          packageSignature: context.packageSignature,
          tsxRuntimeSourceFiles: tsxRuntimeSupport.sourceFiles,
        })
      : "active",
    tsxRuntimeSupport,
  };
}

async function loadOrCreateResolveMetadata(
  context: BuildContext,
  env: ResolveEnv,
  fresh: FreshGraph,
): Promise<ResolveMetadata> {
  const resolveMetadataPath = path.join(
    env.cacheStore.projectCacheDir,
    "resolve",
    `${fresh.resolveKey}.json`,
  );
  const cached = env.usesPersistentCache
    ? await readJsonIfExists(resolveMetadataPath, isResolveMetadata)
    : null;
  if (cached) {
    const needsUpgrade =
      !Array.isArray(cached.packageAliases) ||
      !Array.isArray(cached.packageJsonFiles) ||
      !Array.isArray(cached.tsxRuntimeSourceFiles);
    const metadata = {
      ...cached,
      packageAliases: cached.packageAliases ?? fresh.packageAliases,
      packageJsonFiles: cached.packageJsonFiles ?? fresh.packageJsonFiles,
      tsxRuntimeSourceFiles:
        cached.tsxRuntimeSourceFiles ?? fresh.tsxRuntimeSupport.sourceFiles,
    };
    if (env.usesPersistentCache && needsUpgrade) {
      await writeJson(resolveMetadataPath, metadata);
    }
    return metadata;
  }

  const metadata = createResolveMetadata(context, env, fresh);
  if (env.usesPersistentCache) {
    await writeJson(resolveMetadataPath, metadata);
  }
  return metadata;
}

function createResolveMetadata(
  context: BuildContext,
  env: ResolveEnv,
  fresh: FreshGraph,
): ResolveMetadata {
  const { options } = context;
  const entryFiles = zipExact(
    fresh.graphResult.entries,
    fresh.outputNames,
    "resolved entries and output names",
  ).map(
    ([entry, outputName]): BuildEntry => ({
      chunkName: sanitizeChunkName(outputName),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName,
      sourcePath: entry.sourcePath,
      sourceRelativePath: path.relative(env.sourceRoot, entry.sourcePath),
    }),
  );
  const shimDir = path.join(env.cacheStore.workspaceDir, "entries");
  const shimFiles = toShimFiles(entryFiles, shimDir);
  return {
    chunkPlan: planChunks({
      baseChunkName: options.chunks.baseChunkName,
      chunkMode: options.chunks.mode,
      entryFiles: entryFiles.map((entry) => ({
        chunkName: entry.chunkName,
        outputName: entry.outputName,
        sourcePath: entry.sourcePath,
      })),
      graphEntries: [
        ...Object.entries(fresh.graphResult.graph).map(
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
      lazyImports: fresh.graphResult.lazyImports,
      shimFiles,
      workspaceDir: env.cacheStore.workspaceDir,
    }),
    entryFiles: entryFiles.map((entry) => ({
      chunkName: entry.chunkName,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: entry.outputName,
      sourceRelativePath: entry.sourceRelativePath,
    })),
    lazyImports: fresh.graphResult.lazyImports,
    packageAliases: fresh.packageAliases,
    packageJsonFiles: fresh.packageJsonFiles,
    tsxRuntimeSourceFiles: fresh.tsxRuntimeSupport.sourceFiles,
  };
}

async function finalizeResolvedBuild(
  context: BuildContext,
  env: ResolveEnv,
  fresh: FreshGraph,
  metadata: ResolveMetadata,
): Promise<ResolvedBuild> {
  const { options } = context;
  const tsxRuntimeSourceFiles = metadata.tsxRuntimeSourceFiles ?? [];
  const nativeEmitKey = env.usesPersistentCache
    ? hashJson({
        compilerOptionsHash: env.compilerOptionsHash,
        diagnostics: options.diagnostics,
        externInputHash: await hashExternalInputs(options.externs),
        packageSignature: context.packageSignature,
        resolveKey: fresh.resolveKey,
        tsxRuntimeSourceFiles,
      })
    : "active";
  const finalKey = env.usesPersistentCache
    ? hashJson({
        compilationLevel: options.compilationLevel,
        externalInputHash: await hashExternalInputs([
          ...options.externs,
          ...options.js,
        ]),
        languageOut: options.languageOut,
        packageSignature: context.packageSignature,
        resolveKey: fresh.resolveKey,
        tsxRuntimeSourceFiles,
      })
    : "active";
  const trackedFiles = env.usesPersistentCache
    ? await collectTrackedFiles([
        ...mergeTsxRuntimeTrackedFiles(
          fresh.graphResult.trackedFiles,
          fresh.tsxRuntimeSupport.trackedFiles,
        ),
        env.tsConfigPath,
        ...options.externs,
        ...options.js,
      ])
    : {};
  if (env.usesPersistentCache) {
    await writeJson(resolveSnapshotPath(env), {
      compilerOptionsHash: env.compilerOptionsHash,
      entryFiles: metadata.entryFiles,
      finalKey,
      lazyImports: fresh.graphResult.lazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases: fresh.packageAliases,
      packageJsonFiles: fresh.packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey: fresh.resolveKey,
      sourceFiles: fresh.graphResult.sourceFiles,
      tsxRuntimeSourceFiles,
      trackedFiles,
    } satisfies ResolveSnapshot);
  }

  return assembleResolvedBuild(env, {
    chunkPlan: metadata.chunkPlan,
    entryFiles: metadata.entryFiles.map(
      (entry): BuildEntry => toBuildEntry(entry, env.sourceRoot),
    ),
    finalKey,
    lazyImports: fresh.graphResult.lazyImports,
    nativeEmitKey,
    packageAliases: fresh.packageAliases,
    packageJsonFiles: fresh.packageJsonFiles,
    sourceFiles: fresh.graphResult.sourceFiles,
    trackedFiles,
    tsxRuntimeSourceFiles,
  });
}

function assembleResolvedBuild(
  env: ResolveEnv,
  parts: {
    chunkPlan: ChunkPlanChunk[];
    entryFiles: BuildEntry[];
    finalKey: string;
    lazyImports: LazyImport[];
    nativeEmitKey: string;
    packageAliases: PackageAlias[];
    packageJsonFiles: string[];
    sourceFiles: string[];
    trackedFiles: ResolveSnapshot["trackedFiles"];
    tsxRuntimeSourceFiles: string[];
  },
): ResolvedBuild {
  const shimDir = path.join(env.cacheStore.workspaceDir, "entries");
  return {
    cleanup: env.cacheStore.cleanup,
    chunkPlan: parts.chunkPlan,
    entryFiles: parts.entryFiles,
    lazyImports: parts.lazyImports,
    packageAliases: parts.packageAliases,
    packageJsonFiles: parts.packageJsonFiles,
    finalCacheDir: path.join(
      env.cacheStore.projectCacheDir,
      "final",
      parts.finalKey,
    ),
    finalKey: parts.finalKey,
    nativeEmitCacheDir: path.join(
      env.cacheStore.projectCacheDir,
      "native-emit",
      parts.nativeEmitKey,
    ),
    shimDir,
    shimFiles: toShimFiles(parts.entryFiles, shimDir),
    sourceFiles: parts.sourceFiles,
    tsxRuntimeSourceFiles: parts.tsxRuntimeSourceFiles,
    trackedFiles: parts.trackedFiles,
    tsConfigPath: env.tsConfigPath,
    workspaceDir: env.cacheStore.workspaceDir,
  };
}

function resolveSnapshotPath(env: ResolveEnv) {
  return path.join(env.cacheStore.projectCacheDir, "resolve", "latest.json");
}
