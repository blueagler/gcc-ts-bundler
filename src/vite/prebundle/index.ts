import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import { shouldBypassTypeMetadataFusion } from "../type-metadata";
import { rewriteDirectEsmImports } from "./direct-esm";
import { rewriteAuthoredModules } from "./entry-outputs";
import { buildDependencyBundles, resolveAtomOutputs } from "./orchestrate";
import { createModuleParser } from "./parse";
import {
  classifyDependencyRouting,
  collectBundleRequests,
  hasBarePackageEdges,
} from "./requests";
import { normalizePath } from "./shared";
import type { PrebundleContext } from "./types";
import { assembleGraph, stageGraphWithoutBundles } from "./write-out";

export async function prebundleMaterializedDependencies(input: {
  dynamicRootModuleIds: string[];
  materialized: MaterializedGraph;
  outputSrcDir?: string;
}): Promise<MaterializedGraph> {
  const authoredFiles = new Set(
    input.materialized.authoredFiles.map((filePath) => normalizePath(filePath)),
  );
  if (
    input.materialized.modules.every((module) =>
      authoredFiles.has(normalizePath(module.filePath)),
    )
  ) {
    return await stageGraphWithoutBundles({
      materialized: input.materialized,
      runtimeSrcDir: input.outputSrcDir ?? input.materialized.srcDir,
    });
  }

  const context = createPrebundleContext(input, authoredFiles);
  const hasFusionSensitiveTypes = context.materialized.modules.some(
    (module) =>
      !context.authoredFiles.has(normalizePath(module.filePath)) &&
      shouldBypassTypeMetadataFusion(module),
  );
  if (
    hasFusionSensitiveTypes &&
    context.materialized.modules.length <= 256 &&
    !(await hasBarePackageEdges(context))
  ) {
    return await stageGraphWithoutBundles(context);
  }
  const dependencyRouting = await classifyDependencyRouting(context);
  await rewriteDirectEsmImports({
    directDependencyFilePaths: dependencyRouting.directFilePaths,
    materialized: context.materialized,
    prebundleFilePaths: dependencyRouting.prebundleFilePaths,
  });
  context.invalidateParsed([
    ...context.authoredFiles,
    ...dependencyRouting.directFilePaths,
  ]);
  const {
    atomRequestKeyByTargetFilePath,
    bundleRequests,
    dynamicRootRequestKeyByTargetFilePath,
    entryRequestKeyByTargetFilePath,
    regionLabelsByAuthoredFile,
  } = await collectBundleRequests(
    context,
    input.dynamicRootModuleIds,
    dependencyRouting.directFilePaths,
    dependencyRouting.prebundleFilePaths,
  );
  if (bundleRequests.size === 0) {
    return await stageGraphWithoutBundles(context);
  }

  const bundles = await buildDependencyBundles(
    context,
    bundleRequests,
    new Set(dynamicRootRequestKeyByTargetFilePath.values()),
    new Set([...context.authoredFiles, ...dependencyRouting.directFilePaths]),
  );
  if (!bundles) {
    return context.materialized;
  }

  const authoredEntries = await rewriteAuthoredModules({
    collapsedEntryOutputByPath: bundles.collapsedEntryOutputByPath,
    dynamicRootRequestKeyByTargetFilePath,
    materialized: context.materialized,
    outputByRequestKey: bundles.canonicalizedEntryOutputs.outputByRequestKey,
    regionLabelsByAuthoredFile,
    requestGroupKeyByTarget: bundles.requestGroupKeyByTarget,
    runtimeSrcDir: context.runtimeSrcDir,
  });
  return await assembleGraph(
    context,
    bundles,
    authoredEntries,
    dependencyRouting.directFilePaths,
    entryRequestKeyByTargetFilePath,
    resolveAtomOutputs(bundles, atomRequestKeyByTargetFilePath),
  );
}

function createPrebundleContext(
  input: {
    materialized: MaterializedGraph;
    outputSrcDir?: string | undefined;
  },
  authoredFiles: Set<string>,
): PrebundleContext {
  const moduleByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      module,
    ]),
  );
  const moduleBySourceId = new Map<string, CapturedRuntimeModule>();
  for (const module of input.materialized.modules) {
    for (const sourceModuleId of module.sourceModuleIds) {
      moduleBySourceId.set(sourceModuleId, module);
    }
  }

  const { invalidate, parseModule } = createModuleParser({
    authoredFiles,
    moduleFilePaths: new Set(moduleByFilePath.keys()),
  });

  return {
    authoredFiles,
    invalidateParsed: invalidate,
    materialized: input.materialized,
    moduleByFilePath,
    moduleBySourceId,
    parseModule,
    runtimeSrcDir: input.outputSrcDir ?? input.materialized.srcDir,
  };
}
