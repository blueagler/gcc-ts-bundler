import path from "path";

import type {
  BuildDiagnostic,
  BuildResult,
  CleanCacheOptions,
} from "../api/types";
import {
  acquireProjectCacheLock,
  createCacheStore,
  type CacheStore,
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
} from "../shared/cache-store";
import {
  countInternalWork,
  logInternalDetail,
  withInternalBuildProfile,
  withInternalTiming,
} from "../shared/timing";
import type { ClosureCompilerEnvironment } from "./closure/compiler";
import type { BuildContext, InternalBuildOptions } from "./types";
import { assembleExternalExterns } from "../externs/build-plan/external-plan";
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
  return withInternalBuildProfile("build", () => buildInvocation(options));
}

async function buildInvocation(
  options: InternalBuildOptions,
): Promise<BuildResult> {
  let releaseCacheLock: (() => Promise<void>) | null = null;
  let cacheStore: CacheStore | null = null;
  let staging: InvocationStaging | null = null;
  let result: BuildResult;
  try {
    const context: PipelineBuildContext = await withInternalTiming(
      "build:context",
      () => createBuildContext(normalizeBuildOptions(options)),
    );
    releaseCacheLock = await withInternalTiming("cache:lock", () =>
      lockPersistentProjectCache(context),
    );
    const ownedCacheStore = await withInternalTiming("cache:store", () =>
      createCacheStore({
        cacheDir: context.options.cache.dir || undefined,
        mode: context.options.cache.mode,
        projectRoot: context.options.projectRoot,
      }),
    );
    cacheStore = ownedCacheStore;
    result = await (async (): Promise<BuildResult> => {
      const resolved = await withInternalTiming("resolve-build", () =>
        resolveBuild(context, ownedCacheStore),
      );
      countInternalWork("sourceFiles", resolved.sourceFiles.length);
      countInternalWork("entryFiles", resolved.entryFiles.length);
      const prep = await withInternalTiming("build:prepare", () =>
        preparePipelineEmit(context, resolved),
      );
      if (prep.kind !== "ready") {
        return prep.result;
      }

      const nativeEmitResult = await withInternalTiming(
        "native-emit:stage",
        () =>
          emitNativeStage({
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
          }),
      );
      if (nativeEmitResult.emitSkipped || nativeEmitResult.diagnostics.length) {
        return failedBuild(
          toBuildDiagnostics(
            nativeEmitResult.diagnostics,
            createAuthoredPathMapper(context, resolved),
          ),
        );
      }

      const invocationStaging = await withInternalTiming("build:staging", () =>
        createInvocationStaging(context.options.outDir, resolved.finalCacheDir),
      );
      staging = invocationStaging;
      const nativeExternPath = await withInternalTiming(
        "externs:assemble",
        () =>
          assembleExternalExterns({
            externsPath: nativeEmitResult.externsPath,
            imports: nativeEmitResult.preservedImports,
            plan: prep.externalExternPlan,
            outputPath: path.join(invocationStaging.inputsDir, "externs.js"),
          }),
      );
      const closureResult = await withInternalTiming(
        "closure:stage",
        async () =>
          runClosureStage({
            chunkPlan: resolved.chunkPlan,
            closureCompilerEnvironment: context.closureCompilerEnvironment,
            emittedOutDir: nativeEmitResult.outDir,
            entryFiles: resolved.entryFiles,
            entryShebangs:
              context.options.target === "node"
                ? await collectEntryShebangs(resolved.entryFiles)
                : [],
            explicitExternPaths: context.options.externs,
            finalCacheDir: invocationStaging.finalCacheDir,
            generatedExterns: context.options.typedExterns,
            nativeExternPath,
            options: context.options,
            outDir: invocationStaging.outDir,
            preservedImports: nativeEmitResult.preservedImports,
            preservedModules: resolved.preservedModules,
            packageRoot: context.packageRoot,
            projectCacheDir: path.dirname(path.dirname(resolved.finalCacheDir)),
            supportFiles: nativeEmitResult.supportFiles,
            typeMetadata: nativeEmitResult.typeMetadata,
            typeWorld: prep.typeWorld,
          }),
      );
      if (closureResult.exitCode !== 0) {
        return failedBuild(
          (closureResult.diagnostics.length
            ? closureResult.diagnostics
            : [
                `Closure compilation failed with exit code ${closureResult.exitCode}.`,
              ]
          ).map((message) => createBuildDiagnostic(message)),
        );
      }

      return await withInternalTiming("build:finalize", () =>
        finalizePipelineBuild({
          closureResult,
          context,
          resolved,
          staging: invocationStaging,
          typeMetadataDependencies: nativeEmitResult.typeMetadataDependencies,
        }),
      );
    })();
  } catch (error) {
    logInternalDetail(
      "build:error",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    result = failedBuild(errorDiagnostics(error));
  }
  const cleanupDiagnostics = [];
  // Every owned resource is attempted, with the lock held until mutations drain.
  for (const [label, cleanup] of [
    [
      "cleanup:staging",
      () => (staging ? cleanupInvocationStaging(staging) : undefined),
    ],
    ["cleanup:cache", () => cacheStore?.cleanup()],
    ["cleanup:lock", () => releaseCacheLock?.()],
  ] as const) {
    try {
      await withInternalTiming(label, cleanup);
    } catch (error) {
      cleanupDiagnostics.push(...errorDiagnostics(error));
    }
  }
  return cleanupDiagnostics.length
    ? failedBuild([
        ...(result.ok ? [] : result.diagnostics),
        ...cleanupDiagnostics,
      ])
    : result;
}

function errorDiagnostics(error: unknown): BuildDiagnostic[] {
  if (error instanceof AggregateError) {
    return [
      createBuildDiagnostic(error),
      ...error.errors.flatMap((cause: unknown) => errorDiagnostics(cause)),
    ];
  }
  return [createBuildDiagnostic(error)];
}

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = options.cacheDir
    ? path.resolve(projectRoot, options.cacheDir)
    : getDefaultPersistentCacheRoot();
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  const releaseCacheLock = await acquireProjectCacheLock(projectCacheDir);
  const failures: unknown[] = [];
  try {
    await removeProjectCacheDir(projectCacheDir);
  } catch (error) {
    failures.push(error);
  }
  try {
    await releaseCacheLock();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Failed to clean cache and release its lock at ${projectCacheDir}.`,
    );
}
