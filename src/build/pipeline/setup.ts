import type { BuildFailure, BuildResult } from "../../api/types";
import { createBuildTypeWorld } from "../../externs/build-plan/create-type-world";
import { deriveExternalExternPlan } from "../../externs/build-plan/external-plan";
import type { ExternalExternPlan } from "../../externs/build-plan/external-plan";
import type { TypeWorld } from "../../externs/context";
import { acquireProjectCacheLock } from "../../shared/cache-store";
import type { FileContentSnapshot } from "../../shared/file-state";
import type { ClosureStageResult } from "../closure/run-closure";
import {
  getFinalCachePaths,
  persistFinalCache,
  publishOffModeEntryOutFiles,
  publishStagedClosureResult,
  restoreCachedBuild,
  successfulBuild,
} from "../cache/final";
import type { FinalCachePaths, InvocationStaging } from "../cache/final";
import type { BuildContext, ResolvedBuild } from "../types";
import { validateBuildShape, writeBuildEntryShims } from "./shape";

export type PipelineEmitPrep =
  | { kind: "cached"; result: BuildResult }
  | { kind: "failed"; result: BuildFailure }
  | {
      cachePaths: FinalCachePaths;
      emitFileNames: string[];
      externalExternPlan: ExternalExternPlan;
      kind: "ready";
      typeWorld: TypeWorld;
    };

export async function lockPersistentProjectCache(
  context: BuildContext,
): Promise<(() => Promise<void>) | null> {
  if (context.options.cache.mode !== "persistent") {
    return null;
  }
  return acquireProjectCacheLock(context.projectCacheDir);
}

export async function preparePipelineEmit(
  context: BuildContext,
  resolved: ResolvedBuild,
): Promise<PipelineEmitPrep> {
  const cachePaths = getFinalCachePaths(context, resolved);
  const cachedResult = await restoreCachedBuild(context, resolved, cachePaths);
  if (cachedResult) {
    return { kind: "cached", result: cachedResult };
  }

  const validationFailure = validateBuildShape(context, resolved);
  if (validationFailure) {
    return { kind: "failed", result: validationFailure };
  }

  writeBuildEntryShims(context, resolved);
  const emitFileNames = listNativeEmitFileNames(context, resolved);
  const specifiers = resolved.externalBoundaries.map(
    (boundary) => boundary.specifier,
  );
  const typeWorld = await createBuildTypeWorld({
    emitFileNames,
    options: context.options,
    specifiers,
    tsConfigPath: resolved.tsConfigPath,
    tsxRuntimeSourceFiles: resolved.tsxRuntimeSourceFiles,
    workspaceDir: resolved.workspaceDir,
  });
  const externalExternPlan = await deriveExternalExternPlan({
    appEntryFiles: emitFileNames,
    options: context.options,
    specifiers,
    typeWorld,
  });
  return {
    cachePaths,
    emitFileNames,
    externalExternPlan,
    kind: "ready",
    typeWorld,
  };
}

export async function finalizePipelineBuild(input: {
  cachePaths: FinalCachePaths;
  closureResult: ClosureStageResult;
  context: BuildContext;
  resolved: ResolvedBuild;
  staging: InvocationStaging;
  typeMetadataDependencies: FileContentSnapshot;
}): Promise<BuildResult> {
  const publishedResult = await publishStagedClosureResult(
    input.closureResult,
    input.staging,
    input.resolved.finalCacheDir,
    input.context.options.outDir,
  );
  await persistFinalCache(
    input.context,
    input.resolved,
    input.cachePaths,
    publishedResult,
    input.typeMetadataDependencies,
  );
  return successfulBuild(
    await publishOffModeEntryOutFiles(
      input.context,
      input.resolved,
      publishedResult.outputFiles,
    ),
    false,
  );
}

function listNativeEmitFileNames(
  context: BuildContext,
  resolved: ResolvedBuild,
): string[] {
  const preservedFilePaths = new Set(
    resolved.preservedModules.map((module) => module.filePath),
  );
  return context.options.chunks.mode === "off"
    ? [
        ...resolved.sourceFiles.filter(
          (filePath) => !preservedFilePaths.has(filePath),
        ),
        ...resolved.shimFiles,
      ]
    : resolved.sourceFiles.filter(
        (filePath) => !preservedFilePaths.has(filePath),
      );
}
