import path from "path";

import type { BuildResult, CleanCacheOptions } from "../api/types";
import {
  acquireProjectCacheLock,
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
} from "../shared/cache-store";
import { logInternalDetail, withInternalTiming } from "../shared/timing";
import type { ClosureCompilerEnvironment } from "./closure/compiler";
import type {
  BuildContext,
  InternalBuildOptions,
  ResolvedBuild,
} from "./types";
import { appendExternalTypedExterns } from "../externs/build-plan/external-plan";
import { runClosureStage } from "./closure/run-closure";
import { emitNativeStage } from "./transpile/emit";
import {
  createBuildDiagnostic,
  removeProjectCacheDir,
  toBuildDiagnostics,
} from "./helpers";
import {
  createBuildContext,
  normalizeBuildOptions,
  resolveBuild,
} from "./resolve";
import {
  cleanupInvocationStaging,
  createInvocationStaging,
} from "./cache/final";
import type { InvocationStaging } from "./cache/final";
import {
  finalizePipelineBuild,
  lockPersistentProjectCache,
  preparePipelineEmit,
} from "./pipeline/setup";
import {
  collectEntryShebangs,
  createAuthoredPathMapper,
  failedBuild,
} from "./pipeline/shape";

type PipelineBuildContext = BuildContext & {
  closureCompilerEnvironment: ClosureCompilerEnvironment;
};

export async function build(
  options: InternalBuildOptions,
): Promise<BuildResult> {
  const normalizedOptions = normalizeBuildOptions(options);
  let context: PipelineBuildContext;
  try {
    context = await createBuildContext(normalizedOptions);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  }

  let releaseCacheLock: (() => Promise<void>) | null = null;
  try {
    releaseCacheLock = await lockPersistentProjectCache(context);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  }

  let resolved: ResolvedBuild | null = null;
  let staging: InvocationStaging | null = null;
  try {
    resolved = await withInternalTiming("resolve-build", () =>
      resolveBuild(context),
    );
    const prep = await preparePipelineEmit(context, resolved);
    if (prep.kind !== "ready") {
      return prep.result;
    }

    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      chunkPlan: resolved.chunkPlan,
      entryFiles: resolved.entryFiles,
      externalBoundaries: resolved.externalBoundaries,
      fileNames: prep.emitFileNames,
      lazyImports: resolved.lazyImports,
      metadataPath: path.join(resolved.nativeEmitCacheDir, "meta.json"),
      opaqueExternalSpecifiers: prep.externalExternPlan.opaqueSpecifiers,
      options: context.options,
      optionsSignature: context.optionsSignature,
      packageAliases: resolved.packageAliases,
      packageJsonFiles: resolved.packageJsonFiles,
      preservedModules: resolved.preservedModules,
      resolvedImports: resolved.resolvedImports,
      tsConfigPath: resolved.tsConfigPath,
      tsxRuntimeSourceFiles: resolved.tsxRuntimeSourceFiles,
      typeInferenceDisabled:
        context.closureCompilerEnvironment.typeInferenceDisabled,
      typeWorld: prep.typeWorld,
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

    await appendExternalTypedExterns({
      externsPath: nativeEmitResult.externsPath,
      imports: nativeEmitResult.preservedImports,
      typedResolutions: prep.externalExternPlan.typedResolutions,
    });

    staging = await createInvocationStaging(
      context.options.outDir,
      resolved.finalCacheDir,
    );
    const closureResult = await runClosureStage({
      chunkPlan: resolved.chunkPlan,
      closureCompilerEnvironment: context.closureCompilerEnvironment,
      emittedOutDir: nativeEmitResult.outDir,
      entryFiles: resolved.entryFiles,
      entryShebangs:
        context.options.target === "node"
          ? await collectEntryShebangs(resolved.entryFiles)
          : [],
      explicitExternPaths: context.options.externs,
      finalCacheDir: staging.finalCacheDir,
      generatedExternPaths: context.options.typedExterns,
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: staging.outDir,
      preservedImports: nativeEmitResult.preservedImports,
      preservedModules: resolved.preservedModules,
      packageRoot: context.packageRoot,
      projectCacheDir: path.dirname(path.dirname(resolved.finalCacheDir)),
      supportFiles: nativeEmitResult.supportFiles,
      typeMetadata: nativeEmitResult.typeMetadata,
      typeWorld: prep.typeWorld,
    });
    if (closureResult.exitCode !== 0) {
      return failedBuild([
        createBuildDiagnostic(
          `Closure compilation failed with exit code ${closureResult.exitCode}.`,
        ),
      ]);
    }

    return await finalizePipelineBuild({
      cachePaths: prep.cachePaths,
      closureResult,
      context,
      resolved,
      staging,
      typeMetadataDependencies: nativeEmitResult.typeMetadataDependencies,
    });
  } catch (error) {
    logInternalDetail(
      "build:error",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    return failedBuild([createBuildDiagnostic(error)]);
  } finally {
    if (staging) {
      await cleanupInvocationStaging(staging);
    }
    try {
      await resolved?.cleanup();
    } finally {
      await releaseCacheLock?.();
    }
  }
}

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = options.cacheDir
    ? path.resolve(projectRoot, options.cacheDir)
    : getDefaultPersistentCacheRoot();
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  const releaseCacheLock = await acquireProjectCacheLock(projectCacheDir);
  try {
    await removeProjectCacheDir(projectCacheDir);
  } finally {
    await releaseCacheLock();
  }
}
