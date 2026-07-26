import path from "path";

import type {
  BuildDiagnostic,
  BuildFailure,
  BuildOptions,
  BuildResult,
  CleanCacheOptions,
} from "../api/types";
import {
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
} from "../shared/cache-store";
import {
  collectPublishedOutputStats,
  filesExist,
  publishedOutputsMatchSnapshot,
} from "../shared/file-state";
import { logInternalDetail, withInternalTiming } from "../shared/timing";
import type { BuildContext, ResolvedBuild } from "./types";
import {
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
} from "../shared/validation";
import { writeEntryShims } from "../native/load";
import { writeSplitLazyShims } from "./split-chunks";
import { runClosureStage } from "./closure/run-closure";
import { emitNativeStage } from "./transpile/emit";
import {
  createBuildDiagnostic,
  publishOutputs,
  removeProjectCacheDir,
  toBuildDiagnostics,
  toImportPath,
  toPublishedOutputPaths,
} from "./helpers";
import {
  createBuildContext,
  normalizeBuildOptions,
  resolveBuild,
} from "./resolve";

interface FinalCacheMetadata {
  outputFiles: string[];
}

interface FinalFastSnapshot {
  finalKey: string;
  optionsSignature: string;
  packageSignature: string;
  publishedOutputs: Array<{ name: string; size: number }>;
}

interface FinalCachePaths {
  fastSnapshotPath: string;
  metadataPath: string;
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const context = await createBuildContext(normalizeBuildOptions(options));
  let resolved: ResolvedBuild | null = null;

  try {
    resolved = await withInternalTiming("resolve-build", () =>
      resolveBuild(context),
    );
    const cachePaths = getFinalCachePaths(context, resolved);
    const cachedResult = await restoreCachedBuild(
      context,
      resolved,
      cachePaths,
    );
    if (cachedResult) {
      return cachedResult;
    }

    const validationFailure = validateBuildShape(context, resolved);
    if (validationFailure) {
      return validationFailure;
    }

    writeBuildEntryShims(context, resolved);
    const splitShimFiles =
      context.options.chunks.mode === "split"
        ? writeSplitLazyShims({
            lazyImports: resolved.lazyImports,
            shimDir: resolved.shimDir,
          })
        : [];
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      fileNames:
        context.options.chunks.mode === "off"
          ? [...resolved.sourceFiles, ...resolved.shimFiles]
          : [...resolved.sourceFiles, ...splitShimFiles],
      lazyImports: resolved.lazyImports,
      metadataPath: path.join(resolved.nativeEmitCacheDir, "meta.json"),
      options: context.options,
      packageAliases: resolved.packageAliases,
      packageJsonFiles: resolved.packageJsonFiles,
      tsxRuntimeSourceFiles: resolved.tsxRuntimeSourceFiles,
      tsConfigPath: resolved.tsConfigPath,
      workspaceDir: resolved.workspaceDir,
    });
    if (nativeEmitResult.emitSkipped || nativeEmitResult.diagnostics.length) {
      return failedBuild(
        toBuildDiagnostics(
          nativeEmitResult.diagnostics,
          createAuthoredPathMapper(context, resolved),
        ),
      );
    }

    const closureResult = await runClosureStage({
      chunkPlan: resolved.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      explicitExternPaths: context.options.externs,
      finalCacheDir: resolved.finalCacheDir,
      generatedExternPaths: [],
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: context.options.outDir,
      packageRoot: context.packageRoot,
      projectCacheDir: context.projectCacheDir,
      supportFiles: nativeEmitResult.supportFiles,
    });
    if (closureResult.exitCode !== 0) {
      return failedBuild([
        createBuildDiagnostic(
          `Closure compilation failed with exit code ${closureResult.exitCode}.`,
        ),
      ]);
    }

    await persistFinalCache(context, resolved, cachePaths, closureResult);
    return successfulBuild(closureResult.outputFiles, false);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  } finally {
    await resolved?.cleanup();
  }
}

/**
 * Diagnostics reference the workspace overlay (workspace/src/...), which
 * mirrors srcDir. Map them back so callers see paths they can open.
 */
function createAuthoredPathMapper(
  context: BuildContext,
  resolved: ResolvedBuild,
) {
  const sourceRoot = path.join(resolved.workspaceDir, "src");
  return (filePath: string) =>
    filePath.startsWith(sourceRoot)
      ? path.join(context.options.srcDir, path.relative(sourceRoot, filePath))
      : filePath;
}

function getFinalCachePaths(
  context: BuildContext,
  resolved: ResolvedBuild,
): FinalCachePaths {
  return {
    fastSnapshotPath: path.join(context.projectCacheDir, "final-fast.json"),
    metadataPath: path.join(resolved.finalCacheDir, "meta.json"),
  };
}

async function restoreCachedBuild(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
): Promise<BuildResult | null> {
  if (context.options.cache.mode !== "persistent") {
    return null;
  }
  return (
    (await restoreFastSnapshot(
      context,
      resolved,
      cachePaths.fastSnapshotPath,
    )) ?? restoreFinalMetadata(context, cachePaths.metadataPath)
  );
}

async function restoreFastSnapshot(
  context: BuildContext,
  resolved: ResolvedBuild,
  snapshotPath: string,
): Promise<BuildResult | null> {
  const snapshot = await readJsonIfExists(snapshotPath, isFinalFastSnapshot);
  const cacheHit = Boolean(
    snapshot &&
    snapshot.finalKey === resolved.finalKey &&
    snapshot.optionsSignature === context.optionsSignature &&
    snapshot.packageSignature === context.packageSignature &&
    (await publishedOutputsMatchSnapshot(
      snapshot.publishedOutputs,
      context.options.outDir,
    )),
  );
  logInternalDetail("cache:final-fast", cacheHit ? "hit" : "miss");
  return snapshot && cacheHit
    ? successfulBuild(
        toPublishedOutputPaths(
          snapshot.publishedOutputs,
          context.options.outDir,
        ),
        true,
      )
    : null;
}

async function restoreFinalMetadata(
  context: BuildContext,
  metadataPath: string,
): Promise<BuildResult | null> {
  const metadata = await readJsonIfExists(metadataPath, isFinalCacheMetadata);
  const cacheHit = Boolean(
    metadata && (await filesExist(metadata.outputFiles)),
  );
  logInternalDetail("cache:final-metadata", cacheHit ? "hit" : "miss");
  if (!metadata || !cacheHit) {
    return null;
  }

  await publishOutputs(metadata.outputFiles, context.options.outDir);
  return successfulBuild(
    toPublishedOutputPaths(
      metadata.outputFiles.map((outputFile) => ({
        name: path.basename(outputFile),
      })),
      context.options.outDir,
    ),
    true,
  );
}

function validateBuildShape(
  context: BuildContext,
  resolved: ResolvedBuild,
): BuildFailure | null {
  if (
    context.options.chunks.mode !== "off" &&
    resolved.entryFiles.some(
      (entry) => entry.exportNames.length > 0 || entry.hasDefaultExport,
    )
  ) {
    return failedBuild([
      createBuildDiagnostic(
        "Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.",
      ),
    ]);
  }

  if (
    context.options.chunks.mode === "off" &&
    resolved.lazyImports.length > 0
  ) {
    return failedBuild([
      createBuildDiagnostic(
        'Dynamic import() requires chunks.mode = "split" or "bundler-runtime".',
      ),
    ]);
  }
  return null;
}

function writeBuildEntryShims(context: BuildContext, resolved: ResolvedBuild) {
  if (context.options.chunks.mode !== "off") {
    return;
  }
  writeEntryShims({
    entries: resolved.entryFiles.map((entry) => ({
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      importPath: toImportPath(
        path.relative(
          path.dirname(path.join(resolved.shimDir, `${entry.chunkName}.ts`)),
          entry.sourcePath,
        ),
      ),
      shimPath: path.join(resolved.shimDir, `${entry.chunkName}.ts`),
    })),
  });
}

async function persistFinalCache(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
  closureResult: Awaited<ReturnType<typeof runClosureStage>>,
) {
  if (context.options.cache.mode !== "persistent") {
    return;
  }
  await Promise.all([
    writeJson(cachePaths.metadataPath, {
      outputFiles: closureResult.cacheOutputFiles,
    } satisfies FinalCacheMetadata),
    collectPublishedOutputStats(closureResult.outputFiles).then(
      (publishedOutputs) =>
        writeJson(cachePaths.fastSnapshotPath, {
          finalKey: resolved.finalKey,
          optionsSignature: context.optionsSignature,
          packageSignature: context.packageSignature,
          publishedOutputs,
        } satisfies FinalFastSnapshot),
    ),
  ]);
}

function successfulBuild(
  outputFiles: readonly string[],
  cacheHit: boolean,
): BuildResult {
  return { cacheHit, ok: true, outputFiles };
}

function failedBuild(diagnostics: readonly BuildDiagnostic[]): BuildFailure {
  return { diagnostics, ok: false };
}

const isFinalCacheMetadata = isObjectOf<FinalCacheMetadata>({
  outputFiles: isStringArray,
});

const isPublishedOutput = isObjectOf<
  FinalFastSnapshot["publishedOutputs"][number]
>({
  name: isString,
  size: isNumber,
});

const isFinalFastSnapshot = isObjectOf<FinalFastSnapshot>({
  finalKey: isString,
  optionsSignature: isString,
  packageSignature: isString,
  publishedOutputs: arrayOf(isPublishedOutput),
});

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path.resolve(
    options.cacheDir || getDefaultPersistentCacheRoot(),
  );
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  await removeProjectCacheDir(projectCacheDir);
}
