import path from "path";
import ts from "@typescript/typescript6";

import { loadBuildTypeWorldOptions } from "../../externs/build-plan/create-type-world";
import {
  resolveModuleTypeEntry,
  type ResolvedModuleTypeEntry,
} from "../../externs/compiler/target";
import { resolveClosureCompilerEnvironment } from "../closure/compiler";
import type { NativeChunkPlanEntryInput } from "../../native/abi";
import { planChunks, resolveGraph } from "../../native/load";
import { zipExact } from "../../shared/arrays";
import {
  type CacheStore,
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
} from "../../shared/cache-store";
import { collectFileContentSnapshot } from "../../shared/file-state";
import { normalizeRelativePath, uniqueSortedStrings } from "../../shared/files";
import { hashContent, hashJson } from "../../shared/hash";
import { preservesConstEnumObjects } from "../../shared/typescript";
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
import { parseTsConfig, type ParsedTsConfig } from "./compiler-options";
import { toImportPath } from "../helpers";
import { resolveOutputNames, sanitizeChunkName, toShimFiles } from "./entries";
import {
  collectTsxRuntimeSupport,
  mergePackageAliases,
  mergeResolvedImports,
} from "./jsx-runtime";
import { getPackageRootFromBundle } from "../../shared/bundle-location";
import {
  getOptionsSignature,
  getPackageSignature,
  hashExternalInputs,
} from "./signatures";
import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
  resolveTsConfigPath,
} from "./workspace";

import { normalizeBuildOptions, validateOutputPathBoundaries } from "./options";

export { normalizeBuildOptions };
interface ResolveEnv {
  cacheStore: CacheStore;
  compilerOptionsHash: string;
  configInputPaths: string[];
  tsConfig: ParsedTsConfig;
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
  const packageRoot = getPackageRootFromBundle();
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
  cacheStore: CacheStore,
): Promise<ResolvedBuild> {
  if (context.options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const env = await prepareResolveWorkspace(context, cacheStore);
  const fresh = await resolveFreshGraph(context, env);
  const plan = createResolvedPlan(context, env, fresh);
  const resolved = await finalizeResolvedBuild(context, env, fresh, plan);
  await validateOutputPathBoundaries(
    context.options,
    cacheStore.workspaceDir,
    [
      ...resolved.sourceFiles,
      ...resolved.tsxRuntimeSourceFiles,
      ...resolved.packageJsonFiles,
      ...env.configInputPaths,
      ...(context.options.authoredFiles ?? []),
    ],
    cacheStore.rootDir,
    resolved.entryFiles.map((entry) => entry.outputName),
  );
  return resolved;
}

async function prepareResolveWorkspace(
  context: BuildContext,
  cacheStore: CacheStore,
): Promise<ResolveEnv> {
  const { options } = context;
  const usesPersistentCache = options.cache.mode === "persistent";
  const sourceRoot = path.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);

  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const tsConfig = parseTsConfig(
    tsConfigPath,
    options.entries.map((entry) => entry.file),
  );
  const { configInputs, parsed } = tsConfig;
  const declarationFiles = parsed.fileNames.filter((fileName) =>
    fileName.endsWith(".d.ts"),
  );
  return {
    cacheStore,
    compilerOptionsHash: usesPersistentCache
      ? hashJson({
          configInputs,
          options: parsed.options,
          declarations: await collectFileContentSnapshot(declarationFiles),
        })
      : "",
    configInputPaths: [...Object.keys(configInputs), ...declarationFiles],
    tsConfig,
    sourceRoot,
    tsConfigPath,
    usesPersistentCache,
  };
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
  // Native graph exports describe source bindings. Only this invocation's
  // compiler options decide whether a const enum also owns a runtime object.
  if (!preservesConstEnumObjects(env.tsConfig.parsed.options)) {
    for (const entries of [graphResult.entries, graphResult.preservedModules]) {
      for (const entry of entries) {
        if (entry.constEnumExportNames.length === 0) continue;
        const erasedNames = new Set(entry.constEnumExportNames);
        entry.exportNames = entry.exportNames.filter(
          (name) => !erasedNames.has(name),
        );
        entry.hasDefaultExport &&= !erasedNames.has("default");
        entry.constEnumExportNames = [];
      }
    }
  }
  const preservedModules = graphResult.preservedModules.map(
    (module): PreservedModule => ({
      // Spelled out rather than rest-spread: these keys reach the native addon,
      // and only a literal written against the boundary type keeps its property
      // names through the self-build's renaming.
      exportNames: module.exportNames,
      filePath: module.filePath,
      hasDefaultExport: module.hasDefaultExport,
      moduleId: module.moduleId,
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
    tsConfig: env.tsConfig,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  let resolveKey = "active";
  if (env.usesPersistentCache) {
    // Native `fileHashes` cover every visited source and every consulted
    // package.json, keyed by `path_relative_to(workspaceDir)` or, when the
    // path is outside the workspace, the original path
    // (`native/src/graph/resolve.rs`). `trackedFiles` are that same set as
    // absolute paths, not a superset. A second `resolveGraph` for the TSX
    // runtime, plus caller `authoredFiles`, can name paths never inserted
    // into `graphResult.fileHashes`. Snapshot those extras. Graph edges,
    // aliases, export metadata, and the TSX support object are functions of
    // those bytes plus `optionsSignature` / `compilerOptionsHash` /
    // `packageSignature`, so hashing `graphResult` itself is not an
    // additional identity.
    const fileHashes = [
      ...graphResult.fileHashes,
      ...tsxRuntimeSupport.fileHashes,
    ];
    const hashedPaths = new Set(fileHashes.map((entry) => entry.filePath));
    const workspaceDir = env.cacheStore.workspaceDir;
    resolveKey = hashJson({
      optionsSignature: context.optionsSignature,
      compilerOptionsHash: env.compilerOptionsHash,
      entries: entryRelativePaths,
      externalDeclarations: await observeExternalDeclarations(
        context,
        env,
        graphResult.externalBoundaries,
      ),
      fileHashes,
      inputContents: await collectFileContentSnapshot(
        uniqueSortedStrings([
          ...graphResult.trackedFiles,
          ...tsxRuntimeSupport.trackedFiles,
          ...tsxRuntimeSupport.sourceFiles,
          ...(options.authoredFiles ?? []),
        ]).filter(
          (filePath) =>
            !isCoveredByNativeFileHashes(filePath, workspaceDir, hashedPaths),
        ),
      ),
      packageSignature: context.packageSignature,
    });
  }
  return {
    externalBoundaries: graphResult.externalBoundaries,
    graphResult,
    outputNames,
    packageAliases: mergePackageAliases([
      ...graphResult.packageAliases,
      ...tsxRuntimeSupport.packageAliases,
    ]),
    packageJsonFiles: uniqueSortedStrings([
      ...graphResult.packageJsonFiles,
      ...tsxRuntimeSupport.packageJsonFiles,
    ]),
    preservedModules,
    resolvedImports: mergeResolvedImports([
      ...graphResult.resolvedImports,
      ...tsxRuntimeSupport.resolvedImports,
    ]),
    resolveKey,
    tsxRuntimeSupport,
  };
}

/**
 * Explicit externals bypass native resolution. Old declaration snapshots cannot
 * see a newly installed or nearer entry, so observe resolution before restoring
 * either cache. The project-root probe and each importer's lookup can differ.
 */
async function observeExternalDeclarations(
  context: BuildContext,
  env: ResolveEnv,
  boundaries: readonly ExternalBoundary[],
) {
  if (boundaries.length === 0) return null;
  const { compilerOptions } = await loadBuildTypeWorldOptions({
    emitFileNames: [],
    tsConfig: env.tsConfig,
    tsConfigPath: env.tsConfigPath,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  const manifests: Record<string, string | null> = {};
  const resolutionHost: ts.ModuleResolutionHost = {
    ...ts.sys,
    readFile(filePath) {
      const content = ts.sys.readFile(filePath);
      if (path.basename(filePath) === "package.json") {
        manifests[path.resolve(filePath)] =
          content === undefined ? null : hashContent(content);
      }
      return content;
    },
  };
  // All memoized successes and misses die with this invocation. Reusing a cache
  // across builds would hide exactly the newly installed entries observed here.
  const resolutionCache = ts.createModuleResolutionCache(
    context.options.projectRoot,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    compilerOptions,
  );
  const roots = new Map<string, Set<string>>();
  for (const boundary of boundaries) {
    for (const root of [
      context.options.projectRoot,
      path.dirname(boundary.importerFilePath),
    ]) {
      let specifiers = roots.get(root);
      if (!specifiers) {
        specifiers = new Set();
        roots.set(root, specifiers);
      }
      specifiers.add(boundary.specifier);
    }
  }
  const entries = [];
  const declarationFiles: string[] = [];
  for (const [projectRoot, specifiers] of roots) {
    for (const specifier of specifiers) {
      let resolved: ResolvedModuleTypeEntry | null;
      try {
        resolved = await resolveModuleTypeEntry({
          compilerOptions,
          projectRoot,
          resolutionCache,
          resolutionHost,
          specifier,
          target: context.options.target,
        });
      } catch {
        // Unresolvable externals retain the existing opaque fallback. A later
        // successful lookup changes this null identity before any restore.
        resolved = null;
      }
      entries.push({ projectRoot, specifier, resolved });
      if (resolved) declarationFiles.push(resolved.declarationEntry);
    }
  }
  return {
    entries,
    manifests,
    declarations: await collectFileContentSnapshot(declarationFiles),
  };
}

interface ResolvedPlan {
  chunkPlan: ChunkPlanChunk[];
  entryFiles: BuildEntry[];
  tsxRuntimeSourceFiles: string[];
}

function createResolvedPlan(
  context: BuildContext,
  env: ResolveEnv,
  fresh: FreshGraph,
): ResolvedPlan {
  const { options } = context;
  const entryFiles = zipExact(
    zipExact(
      fresh.graphResult.entries,
      fresh.outputNames,
      "resolved entries and output names",
    ),
    options.entries,
    "resolved entries and entry options",
  ).map(([[entry, outputName], option]): BuildEntry => ({
    chunkName: sanitizeChunkName(outputName),
    constEnumExportNames: entry.constEnumExportNames,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName,
    ...(option.outFile === undefined ? {} : { outFile: option.outFile }),
    sourcePath: entry.sourcePath,
  }));
  const shimDir = path.join(env.cacheStore.workspaceDir, "entries");
  const planEntries = zipExact(
    entryFiles,
    toShimFiles(entryFiles, shimDir),
    "resolved entries and entry shims",
  ).map(([entry, shimPath]): NativeChunkPlanEntryInput => ({
    outputName: entry.outputName,
    sourcePath: entry.sourcePath,
    shimPath,
  }));
  const preservedFilePaths = new Set(
    fresh.preservedModules.map((module) => module.filePath),
  );
  const chunkPlan = planChunks({
    baseChunkName: options.chunks.baseChunkName,
    chunkMode: options.chunks.mode,
    entryFiles: planEntries,
    graphEntries: [
      ...fresh.graphResult.graph
        .filter(({ filePath }) => !preservedFilePaths.has(filePath))
        .map(({ filePath, dependencies }) => ({
          dependencies: dependencies.filter(
            (dependency) => !preservedFilePaths.has(dependency),
          ),
          filePath,
        })),
      ...planEntries.map((entry) => ({
        dependencies: [entry.sourcePath],
        filePath: entry.shimPath,
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
      fileName: chunk.fileName,
      importedChunkFileNames: chunk.importedChunkFileNames,
      isEntry: chunk.isEntry,
      moduleFiles: chunk.moduleFiles.map((relativePath) =>
        path.join(env.sourceRoot, relativePath),
      ),
      name: chunk.name,
    })),
    vendorChunk: options.chunks.vendorChunk,
    workspaceDir: env.cacheStore.workspaceDir,
  });
  return {
    chunkPlan,
    entryFiles,
    tsxRuntimeSourceFiles: fresh.tsxRuntimeSupport.sourceFiles,
  };
}

async function finalizeResolvedBuild(
  context: BuildContext,
  env: ResolveEnv,
  fresh: FreshGraph,
  metadata: ResolvedPlan,
): Promise<ResolvedBuild> {
  const { options } = context;
  const tsxRuntimeSourceFiles = metadata.tsxRuntimeSourceFiles ?? [];
  const externInputHash = env.usesPersistentCache
    ? await hashExternalInputs(options.externs)
    : "";
  const externalInputHash = env.usesPersistentCache
    ? hashJson({
        externs: externInputHash,
        js: await hashExternalInputs(options.js),
        typedExterns: await hashExternalInputs(
          options.typedExterns.map((extern) => extern.path),
        ),
      })
    : "";
  const nativeEmitKey = env.usesPersistentCache
    ? hashJson({
        optionsSignature: context.optionsSignature,
        compilerOptionsHash: env.compilerOptionsHash,
        diagnostics: options.diagnostics,
        externInputHash,
        packageSignature: context.packageSignature,
        resolveKey: fresh.resolveKey,
        tsxRuntimeSourceFiles,
      })
    : "active";
  const finalKey = env.usesPersistentCache
    ? hashJson({
        optionsSignature: context.optionsSignature,
        compilationLevel: options.compilationLevel,
        externalInputHash,
        languageOut: options.languageOut,
        packageSignature: context.packageSignature,
        resolveKey: fresh.resolveKey,
        tsxRuntimeSourceFiles,
      })
    : "active";
  return assembleResolvedBuild(env, {
    chunkPlan: metadata.chunkPlan,
    externalBoundaries: fresh.externalBoundaries,
    entryFiles: metadata.entryFiles,
    finalKey,
    lazyImports: fresh.graphResult.lazyImports,
    nativeEmitKey,
    packageAliases: fresh.packageAliases,
    packageJsonFiles: fresh.packageJsonFiles,
    preservedModules: fresh.preservedModules,
    resolvedImports:
      context.options.chunks.mode === "off"
        ? mergeResolvedImports([
            ...fresh.resolvedImports,
            ...zipExact(
              toShimFiles(
                metadata.entryFiles,
                path.join(env.cacheStore.workspaceDir, "entries"),
              ),
              metadata.entryFiles,
              "entry shim imports",
            ).map(([shimFile, entry]) => ({
              importerFilePath: shimFile,
              moduleId: `gcc.${path
                .relative(env.cacheStore.workspaceDir, entry.sourcePath)
                .replace(/\\/gu, "/")
                .replace(/\.[^/.]+$/u, "")
                .split("/")
                .map((segment) => segment.replace(/[^a-zA-Z0-9_$]/gu, "_"))
                .join(".")}`,
              specifier: toImportPath(
                path.relative(path.dirname(shimFile), entry.sourcePath),
              ),
              targetPath: entry.sourcePath,
            })),
          ])
        : fresh.resolvedImports,
    sourceFiles: fresh.graphResult.sourceFiles,
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
    tsxRuntimeSourceFiles: string[];
  },
): ResolvedBuild {
  const shimDir = path.join(env.cacheStore.workspaceDir, "entries");
  return {
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
    tsConfigPath: env.tsConfigPath,
    tsConfig: env.tsConfig,
    workspaceDir: env.cacheStore.workspaceDir,
  };
}

function isCoveredByNativeFileHashes(
  filePath: string,
  workspaceDir: string,
  hashedPaths: Set<string>,
): boolean {
  if (hashedPaths.has(filePath)) {
    return true;
  }
  const relative = path.relative(workspaceDir, filePath);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return false;
  }
  return (
    hashedPaths.has(relative) ||
    hashedPaths.has(normalizeRelativePath(relative))
  );
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
