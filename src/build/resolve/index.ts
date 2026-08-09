import path from "path";

import { resolveClosureCompilerEnvironment } from "../closure/compiler";
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
  ExternalBoundary,
  LazyImport,
  PackageAlias,
  PreservedModule,
  ResolvedBuild,
  ResolvedImport,
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
  mergeResolvedImports,
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

import { normalizeBuildOptions, validateOutputPathBoundaries } from "./options";

export { normalizeBuildOptions };
interface ResolveEnv {
  cacheStore: Awaited<ReturnType<typeof createCacheStore>>;
  compilerOptionsHash: string;
  sourceRoot: string;
  tsConfigPath: string;
  usesPersistentCache: boolean;
}

interface FreshGraph {
  externalBoundaries: ExternalBoundary[];
  graphResult: ReturnType<typeof resolveGraph>;
  outputNames: string[];
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  resolvedImports: ResolvedImport[];
  resolveKey: string;
  tsxRuntimeSupport: Awaited<ReturnType<typeof collectTsxRuntimeSupport>>;
}

export async function createBuildContext(
  options: ResolvedBuildOptions,
): Promise<
  BuildContext & {
    closureCompilerEnvironment: ReturnType<
      typeof resolveClosureCompilerEnvironment
    >;
  }
> {
  const packageRoot = getPackageRoot();
  const usesPersistentCache = options.cache.mode === "persistent";
  const closureCompilerEnvironment = resolveClosureCompilerEnvironment();
  const projectCacheDir = getProjectCacheDir(
    path.resolve(options.cache.dir || getDefaultPersistentCacheRoot()),
    options.projectRoot,
  );
  await validateOutputPathBoundaries(
    options,
    usesPersistentCache ? path.join(projectCacheDir, "workspace") : null,
  );
  return {
    closureCompilerEnvironment,
    options,
    optionsSignature: getOptionsSignature(options, closureCompilerEnvironment),
    packageRoot,
    packageSignature: usesPersistentCache
      ? await getPackageSignature(packageRoot)
      : "",
    projectCacheDir,
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
    await validateResolvedOutputPaths(context, restored);
    return restored;
  }

  const fresh = await resolveFreshGraph(context, env);
  const metadata = await loadOrCreateResolveMetadata(context, env, fresh);
  const resolved = await finalizeResolvedBuild(context, env, fresh, metadata);
  await validateResolvedOutputPaths(context, resolved);
  return resolved;
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

  const chunkPlan = await readChunkPlan(
    env.cacheStore.projectCacheDir,
    snapshot.resolveKey,
    context.optionsSignature,
  );
  if (!chunkPlan) {
    return null;
  }

  return assembleResolvedBuild(env, {
    chunkPlan,
    externalBoundaries: snapshot.externalBoundaries,
    entryFiles: snapshot.entryFiles.map(
      (entry): BuildEntry => toBuildEntry(entry, env.sourceRoot),
    ),
    finalKey: snapshot.finalKey,
    lazyImports: snapshot.lazyImports,
    nativeEmitKey: snapshot.nativeEmitKey,
    packageAliases: snapshot.packageAliases,
    packageJsonFiles: snapshot.packageJsonFiles,
    preservedModules: snapshot.preservedModules,
    resolvedImports: snapshot.resolvedImports,
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
    externalSpecifiers: options.externals,
    packageMode: options.packages,
    preservedFilePaths: options.preserveModules.map((filePath) =>
      path.join(env.sourceRoot, path.relative(options.srcDir, filePath)),
    ),
    srcDir: env.sourceRoot,
    target: options.target,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  const preservedModules = graphResult.preservedModules.map(
    (module): PreservedModule => ({
      ...module,
      outputRelativePath: toPreservedOutputRelativePath(
        env.sourceRoot,
        module.filePath,
      ),
    }),
  );
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
    externalBoundaries: graphResult.externalBoundaries,
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
    preservedModules,
    resolvedImports: mergeResolvedImports([
      ...graphResult.resolvedImports,
      ...tsxRuntimeSupport.resolvedImports,
    ]),
    resolveKey: env.usesPersistentCache
      ? hashJson({
          optionsSignature: context.optionsSignature,
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
  if (cached?.optionsSignature === context.optionsSignature) {
    const needsUpgrade =
      !Array.isArray(cached.externalBoundaries) ||
      !Array.isArray(cached.packageAliases) ||
      !Array.isArray(cached.packageJsonFiles) ||
      !Array.isArray(cached.preservedModules) ||
      !Array.isArray(cached.resolvedImports) ||
      !Array.isArray(cached.tsxRuntimeSourceFiles);
    const metadata = {
      ...cached,
      externalBoundaries: cached.externalBoundaries ?? fresh.externalBoundaries,
      packageAliases: cached.packageAliases ?? fresh.packageAliases,
      packageJsonFiles: cached.packageJsonFiles ?? fresh.packageJsonFiles,
      preservedModules: cached.preservedModules ?? fresh.preservedModules,
      resolvedImports: cached.resolvedImports ?? fresh.resolvedImports,
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
  const preservedFilePaths = new Set(
    fresh.preservedModules.map((module) => module.filePath),
  );
  const chunkPlan = planChunks({
    baseChunkName: options.chunks.baseChunkName,
    chunkMode: options.chunks.mode,
    entryFiles: entryFiles.map((entry) => ({
      chunkName: entry.chunkName,
      outputName: entry.outputName,
      sourcePath: entry.sourcePath,
    })),
    graphEntries: [
      ...Object.entries(fresh.graphResult.graph)
        .filter(([filePath]) => !preservedFilePaths.has(filePath))
        .map(([filePath, dependencies]) => ({
          dependencies: dependencies.filter(
            (dependency) => !preservedFilePaths.has(dependency),
          ),
          filePath,
        })),
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
    // The plugin reports module files relative to the source root it
    // materialized; the graph is keyed by their path inside the build
    // workspace, which only this side knows.
    // Spelled out rather than spread: these keys reach the native addon, and
    // only a literal written against the boundary type keeps its property
    // names through the self-build's renaming.
    rollupChunks: options.rollupChunks.map((chunk) => ({
      dynamicImportedChunkFileNames: chunk.dynamicImportedChunkFileNames,
      fileName: chunk.fileName,
      importedChunkFileNames: chunk.importedChunkFileNames,
      isEntry: chunk.isEntry,
      moduleFiles: chunk.moduleFiles.map((relativePath) =>
        path.join(env.sourceRoot, relativePath),
      ),
      name: chunk.name,
    })),
    shimFiles,
    vendorChunk: options.chunks.vendorChunk,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  return {
    optionsSignature: context.optionsSignature,
    chunkPlan,
    externalBoundaries: fresh.externalBoundaries,
    entryFiles: entryFiles.map(
      (entry): ResolveMetadata["entryFiles"][number] => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath,
      }),
    ),
    lazyImports: fresh.graphResult.lazyImports,
    packageAliases: fresh.packageAliases,
    packageJsonFiles: fresh.packageJsonFiles,
    preservedModules: fresh.preservedModules,
    resolvedImports: fresh.resolvedImports,
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
        optionsSignature: context.optionsSignature,
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
        optionsSignature: context.optionsSignature,
        compilationLevel: options.compilationLevel,
        externalInputHash: await hashExternalInputs([
          ...options.externs,
          ...options.js,
          ...options.typedExterns,
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
        ...options.typedExterns,
      ])
    : {};
  if (env.usesPersistentCache) {
    await writeJson(resolveSnapshotPath(env), {
      compilerOptionsHash: env.compilerOptionsHash,
      entryFiles: metadata.entryFiles,
      externalBoundaries: fresh.externalBoundaries,
      finalKey,
      lazyImports: fresh.graphResult.lazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases: fresh.packageAliases,
      packageJsonFiles: fresh.packageJsonFiles,
      preservedModules: fresh.preservedModules,
      resolvedImports: fresh.resolvedImports,
      packageSignature: context.packageSignature,
      resolveKey: fresh.resolveKey,
      sourceFiles: fresh.graphResult.sourceFiles,
      tsxRuntimeSourceFiles,
      trackedFiles,
    } satisfies ResolveSnapshot);
  }

  return assembleResolvedBuild(env, {
    chunkPlan: metadata.chunkPlan,
    externalBoundaries: fresh.externalBoundaries,
    entryFiles: metadata.entryFiles.map(
      (entry): BuildEntry => toBuildEntry(entry, env.sourceRoot),
    ),
    finalKey,
    lazyImports: fresh.graphResult.lazyImports,
    nativeEmitKey,
    packageAliases: fresh.packageAliases,
    packageJsonFiles: fresh.packageJsonFiles,
    preservedModules: fresh.preservedModules,
    resolvedImports: fresh.resolvedImports,
    sourceFiles: fresh.graphResult.sourceFiles,
    trackedFiles,
    tsxRuntimeSourceFiles,
  });
}

function assembleResolvedBuild(
  env: ResolveEnv,
  parts: {
    chunkPlan: ChunkPlanChunk[];
    externalBoundaries: ExternalBoundary[];
    entryFiles: BuildEntry[];
    finalKey: string;
    lazyImports: LazyImport[];
    nativeEmitKey: string;
    packageAliases: PackageAlias[];
    packageJsonFiles: string[];
    preservedModules: PreservedModule[];
    resolvedImports: ResolvedImport[];
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
    externalBoundaries: parts.externalBoundaries,
    lazyImports: parts.lazyImports,
    packageAliases: parts.packageAliases,
    packageJsonFiles: parts.packageJsonFiles,
    preservedModules: parts.preservedModules,
    resolvedImports: parts.resolvedImports,
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

function toPreservedOutputRelativePath(sourceRoot: string, filePath: string) {
  const relativePath = path.relative(sourceRoot, filePath).replace(/\\/g, "/");
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Preserved module ${filePath} is outside the authored source root.`,
    );
  }
  return path.posix.join(
    "__gcc_preserved",
    relativePath.replace(/\.[^/.]+$/u, ".js"),
  );
}

function resolveSnapshotPath(env: ResolveEnv) {
  return path.join(env.cacheStore.projectCacheDir, "resolve", "latest.json");
}

async function validateResolvedOutputPaths(
  context: BuildContext,
  resolved: ResolvedBuild,
) {
  await validateOutputPathBoundaries(context.options, resolved.workspaceDir, [
    ...resolved.sourceFiles,
    resolved.tsConfigPath,
  ]);
}
