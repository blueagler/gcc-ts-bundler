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
import { assembleGraph, mirrorGraphWithoutBundles } from "./write-out";

export async function prebundleMaterializedDependencies(input: {
  dynamicRootModuleIds: string[];
  materialized: MaterializedGraph;
  outputSrcDir?: string;
}): Promise<MaterializedGraph> {
  let context = createPrebundleContext(input);
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
    return mirrorGraphWithoutBundles(context);
  }
  const dependencyRouting = await classifyDependencyRouting(context);
  await rewriteDirectEsmImports({
    directDependencyFilePaths: dependencyRouting.directFilePaths,
    materialized: context.materialized,
    prebundleFilePaths: dependencyRouting.prebundleFilePaths,
  });
  context = createPrebundleContext(input);
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
    return mirrorGraphWithoutBundles(context);
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

function createPrebundleContext(input: {
  materialized: MaterializedGraph;
  outputSrcDir?: string | undefined;
}): PrebundleContext {
  const authoredFiles = new Set(
    input.materialized.authoredFiles.map((filePath) => normalizePath(filePath)),
  );
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

  return {
    authoredFiles,
    materialized: input.materialized,
    moduleByFilePath,
    moduleBySourceId,
    parseModule: createModuleParser({
      authoredFiles,
      moduleFilePaths: new Set(moduleByFilePath.keys()),
    }),
    runtimeSrcDir: input.outputSrcDir ?? input.materialized.srcDir,
  };
}
