import type { BuildFailure, BuildResult } from "../../api/types";
import {
  createBuildTypeWorld,
  loadBuildTypeWorldOptions,
} from "../../externs/build-plan/create-type-world";
import {
  deriveExternalExternPlan,
  probeExternalExternSpecifiers,
} from "../../externs/build-plan/external-plan";
import type { ExternalExternPlan } from "../../externs/build-plan/external-plan";
import { collectReachableTypeFiles } from "../../externs/compiler";
import type { TypeWorld } from "../../externs/context";
import { acquireProjectCacheLock } from "../../shared/cache-store";
import type { NativeEmitStageResult } from "../transpile/emit";
import { uniqueSortedStrings } from "../../shared/files";
import type { ClosureStageResult } from "../closure/run-closure";
import {
  persistFinalCache,
  publishStagedClosureResult,
  restoreCachedBuild,
  successfulBuild,
} from "../cache/final";
import type { InvocationStaging } from "../cache/final";
import type { BuildContext, ResolvedBuild } from "../types";
import { validateBuildShape, writeBuildEntryShims } from "./shape";
import { validateOutputPathBoundaries } from "../resolve/options";
import {
  countInternalWork,
  PROFILE_INTERNAL_TIMINGS,
  withInternalTiming,
  withInternalTimingSync,
} from "../../shared/timing";

export type PipelineEmitPrep =
  | { kind: "cached"; result: BuildResult }
  | { kind: "failed"; result: BuildFailure }
  | {
      emitFileNames: string[];
      externalExternPlan: ExternalExternPlan;
      kind: "ready";
      typeWorld?: TypeWorld | undefined;
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
  const cachedResult = await withInternalTiming("cache:restore-final", () =>
    restoreCachedBuild(context, resolved),
  );
  if (cachedResult) {
    return { kind: "cached", result: cachedResult };
  }

  const validationFailure = validateBuildShape(context, resolved);
  if (validationFailure) {
    return { kind: "failed", result: validationFailure };
  }

  withInternalTimingSync("build:entry-shims", () =>
    writeBuildEntryShims(context, resolved),
  );
  const emitFileNames = listNativeEmitFileNames(context, resolved);
  countInternalWork("emitFiles", emitFileNames.length);
  const specifiers = resolved.externalBoundaries.map(
    (boundary) => boundary.specifier,
  );
  const { compilerOptions, declarationRoots } = await withInternalTiming(
    "type-world:options",
    () =>
      loadBuildTypeWorldOptions({
        emitFileNames,
        tsConfig: resolved.tsConfig,
        tsConfigPath: resolved.tsConfigPath,
        workspaceDir: resolved.workspaceDir,
      }),
  );
  countInternalWork("declarationRoots", declarationRoots.length);
  countInternalWork("externalSpecifiers", specifiers.length);
  const probed = await withInternalTiming("externs:probe", () =>
    probeExternalExternSpecifiers({
      compilerOptions,
      options: context.options,
      specifiers,
    }),
  );
  const typeWorld =
    probed.typedSpecifiers.length > 0 ||
    context.options.typeMetadata === undefined ||
    context.options.target === "node"
      ? await withInternalTiming("type-world:create", () =>
          createBuildTypeWorld({
            compilerOptions,
            declarationRoots,
            emitFileNames,
            options: context.options,
            specifiers,
            tsxRuntimeSourceFiles: resolved.tsxRuntimeSourceFiles,
          }),
        )
      : undefined;
  if (PROFILE_INTERNAL_TIMINGS && typeWorld) {
    countInternalWork(
      "typeWorldFiles",
      typeWorld.program.getSourceFiles().length,
    );
    countInternalWork(
      "typeWorldRoots",
      typeWorld.program.getRootFileNames().length,
    );
  }
  await withInternalTiming("build:validate-boundaries", async () =>
    validateOutputPathBoundaries(
      context.options,
      resolved.workspaceDir,
      uniqueSortedStrings([
        ...emitFileNames,
        ...resolved.sourceFiles,
        ...resolved.tsxRuntimeSourceFiles,
        ...declarationRoots,
        ...(context.options.authoredFiles ?? []),
        ...(context.options.typeMetadata?.dependencies ?? []),
        ...(typeWorld
          ? typeWorld.program
              .getSourceFiles()
              .map((sourceFile) => sourceFile.fileName)
          : await collectReachableTypeFiles({
              compilerOptions,
              entryFiles: declarationRoots,
              includeDependencies: true,
            })),
      ]),
    ),
  );
  const externalExternPlan = await withInternalTiming("externs:plan", () =>
    deriveExternalExternPlan({
      appEntryFiles: emitFileNames,
      options: context.options,
      opaqueSpecifiers: probed.opaqueSpecifiers,
      typedSpecifiers: probed.typedSpecifiers,
      typeWorld,
    }),
  );
  return {
    emitFileNames,
    externalExternPlan,
    kind: "ready",
    typeWorld,
  };
}

export async function finalizePipelineBuild(input: {
  closureResult: ClosureStageResult;
  context: BuildContext;
  resolved: ResolvedBuild;
  staging: InvocationStaging;
  typeMetadataDependencies: NativeEmitStageResult["typeMetadataDependencies"];
}): Promise<BuildResult> {
  const dependencies = input.typeMetadataDependencies;
  await withInternalTiming("build:validate-final-boundaries", () =>
    validateOutputPathBoundaries(
      input.context.options,
      input.resolved.workspaceDir,
      Array.isArray(dependencies) ? dependencies : Object.keys(dependencies),
    ),
  );
  if (!Array.isArray(dependencies)) {
    await withInternalTiming("cache:persist-final", () =>
      persistFinalCache(
        input.context,
        input.resolved,
        input.staging.finalCacheDir,
        input.closureResult,
        dependencies,
      ),
    );
  }
  return successfulBuild(
    await withInternalTiming("build:publish", () =>
      publishStagedClosureResult(
        input.context,
        input.resolved,
        input.closureResult,
        input.staging,
      ),
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
