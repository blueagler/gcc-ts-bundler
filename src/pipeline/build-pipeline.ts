import path from "path";

import type {
  BuildOptions,
  BuildResult,
  CleanCacheOptions,
} from "../api/types";
import {
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import {
  collectPublishedOutputStats,
  filesExist,
  publishedOutputsMatchSnapshot,
} from "../internal/file-state";
import { logInternalDetail, withInternalTiming } from "../internal/timing";
import type { BuildContext, ResolvedBuild } from "../internal/types";
import {
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
} from "../internal/validation";
import { writeEntryShims } from "../native/load";
import { runClosureStage } from "../stages/closure/run-closure";
import { emitNativeStage } from "../stages/native/emit";
import {
  createBuildDiagnostic,
  publishOutputs,
  removeProjectCacheDir,
  toImportPath,
  toPublishedOutputPaths,
} from "./build-helpers";
import {
  createBuildContext,
  normalizeBuildOptions,
  resolveBuild,
} from "./resolve-build";

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
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      fileNames:
        context.options.chunks.mode === "off"
          ? [...resolved.sourceFiles, ...resolved.shimFiles]
          : resolved.sourceFiles,
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
      return failedBuild(nativeEmitResult.diagnostics);
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
      return failedBuild([], closureResult.exitCode);
    }

    await persistFinalCache(context, resolved, cachePaths, closureResult);
    return successfulBuild(closureResult.outputFiles, false);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  } finally {
    await resolved?.cleanup();
  }
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
): BuildResult | null {
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
        'Dynamic import() requires chunks.mode = "bundler-runtime".',
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
  return {
    cacheHit,
    diagnostics: [],
    emitSkipped: false,
    exitCode: 0,
    outputFiles,
  };
}

function failedBuild(
  diagnostics: readonly unknown[],
  exitCode = 1,
): BuildResult {
  return {
    cacheHit: false,
    diagnostics,
    emitSkipped: true,
    exitCode,
    outputFiles: [],
  };
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
