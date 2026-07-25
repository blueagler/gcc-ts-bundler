import fs from "node:fs/promises";
import path from "node:path";

import { syncDirectoryEntries } from "../../shared/files";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import {
  canonicalizeDuplicateLazyEntryOutputs,
  collectCollapsibleBundleEntryOutputs,
  rewriteAuthoredModules,
} from "./entry-outputs";
import { loadEsbuildBuild } from "./esbuild";
import type { EsbuildBuild } from "./esbuild";
import { createModuleParser } from "./parse";
import {
  assignRegionLabels,
  groupBundleRequests,
  renderBundleEntrySource,
  resolveEntryOutputsByRequest,
  sanitizeEntryName,
  sanitizeRegionKey,
} from "./regions";
import type {
  RegionBundleRequest,
  WrittenRegionBundleRequest,
} from "./regions";
import {
  DEP_BUNDLE_INPUT_DIR,
  DEP_BUNDLE_OUTPUT_DIR,
  EAGER_REGION_LABEL,
  hashText,
  normalizePath,
} from "./shared";
import type { ParsedMaterializedModule } from "./shared";

interface PrebundleContext {
  authoredFiles: Set<string>;
  materialized: MaterializedGraph;
  moduleByFilePath: Map<string, CapturedRuntimeModule>;
  moduleBySourceId: Map<string, CapturedRuntimeModule>;
  parseModule: (filePath: string) => Promise<ParsedMaterializedModule>;
  runtimeSrcDir: string;
}

interface DependencyBundleSet {
  canonicalizedEntryOutputs: Awaited<
    ReturnType<typeof canonicalizeDuplicateLazyEntryOutputs>
  >;
  collapsedEntryOutputByPath: Awaited<
    ReturnType<typeof collectCollapsibleBundleEntryOutputs>
  >;
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  requestGroupKeyByTarget: Map<string, string>;
  writtenRequests: WrittenRegionBundleRequest[];
}

export async function prebundleMaterializedDependencies(input: {
  dynamicRootModuleIds: string[];
  materialized: MaterializedGraph;
  outputSrcDir?: string;
}): Promise<MaterializedGraph> {
  const context = createPrebundleContext(input);
  const { bundleRequests, regionLabelsByAuthoredFile } =
    await collectBundleRequests(context, input.dynamicRootModuleIds);
  if (bundleRequests.size === 0) {
    return mirrorGraphWithoutBundles(context);
  }

  const bundles = await buildDependencyBundles(context, bundleRequests);
  if (!bundles) {
    return context.materialized;
  }

  const authoredEntries = await rewriteAuthoredModules({
    collapsedEntryOutputByPath: bundles.collapsedEntryOutputByPath,
    materialized: context.materialized,
    outputByRequestKey: bundles.canonicalizedEntryOutputs.outputByRequestKey,
    regionLabelsByAuthoredFile,
    requestGroupKeyByTarget: bundles.requestGroupKeyByTarget,
    runtimeSrcDir: context.runtimeSrcDir,
  });
  return assembleGraph(context, bundles, authoredEntries);
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

async function collectBundleRequests(
  context: PrebundleContext,
  dynamicRootModuleIds: string[],
) {
  const entryFilePaths = context.materialized.entries.map((entry) =>
    normalizePath(path.resolve(context.materialized.srcDir, entry)),
  );
  const dynamicRootFilePaths = dynamicRootModuleIds
    .map((moduleId) => context.moduleBySourceId.get(moduleId)?.filePath)
    .filter(
      (filePath): filePath is string =>
        typeof filePath === "string" &&
        context.authoredFiles.has(normalizePath(filePath)),
    )
    .map((filePath) => normalizePath(filePath))
    .sort((left, right) => left.localeCompare(right));

  const regionLabelsByAuthoredFile = await assignRegionLabels({
    authoredFiles: context.authoredFiles,
    dynamicRootFilePaths,
    entryFilePaths,
    parseModule: context.parseModule,
  });

  const bundleRequests = new Map<string, RegionBundleRequest>();
  for (const filePath of context.materialized.authoredFiles) {
    const normalizedFilePath = normalizePath(filePath);
    const regionKey = regionLabelsByAuthoredFile.get(normalizedFilePath);
    if (!regionKey) {
      continue;
    }

    const parsed = await context.parseModule(normalizedFilePath);
    for (const dependencyImport of parsed.dependencyImports) {
      const targetModule = context.moduleByFilePath.get(
        normalizePath(dependencyImport.targetFilePath),
      );
      if (!targetModule) {
        continue;
      }

      const requestKey = `${regionKey}\u0000${normalizePath(targetModule.filePath)}`;
      const existing = bundleRequests.get(requestKey);
      if (existing) {
        existing.needsDefault ||= dependencyImport.hasDefault;
        existing.needsExportAll ||= dependencyImport.hasNamespace;
        existing.needsSideEffectOnly ||= dependencyImport.isSideEffectOnly;
        for (const namedExport of dependencyImport.namedExports) {
          existing.usedNamedExports.add(namedExport);
        }
        continue;
      }

      const parsedTarget = await context.parseModule(targetModule.filePath);
      bundleRequests.set(requestKey, {
        exportedNames: parsedTarget.exportedNames,
        hasDefaultExport: parsedTarget.hasDefaultExport,
        needsDefault: dependencyImport.hasDefault,
        needsExportAll: dependencyImport.hasNamespace,
        needsSideEffectOnly: dependencyImport.isSideEffectOnly,
        regionKey,
        sourceModuleIds: [...targetModule.sourceModuleIds],
        targetFilePath: normalizePath(targetModule.filePath),
        targetModule,
        usedNamedExports: new Set(dependencyImport.namedExports),
      });
    }
  }

  return { bundleRequests, regionLabelsByAuthoredFile };
}

/** No dependency bundles: mirror the graph into the runtime dir unchanged. */
async function mirrorGraphWithoutBundles(
  context: PrebundleContext,
): Promise<MaterializedGraph> {
  const { materialized, runtimeSrcDir } = context;
  if (runtimeSrcDir === materialized.srcDir) {
    return materialized;
  }
  const runtimeEntries = await Promise.all(
    [
      ...new Set(
        materialized.modules.map((module) => normalizePath(module.filePath)),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        content: await fs.readFile(filePath, "utf8"),
        relativePath: path
          .relative(materialized.srcDir, filePath)
          .replace(/\\/g, "/"),
      })),
  );
  await syncDirectoryEntries(runtimeSrcDir, runtimeEntries);
  return {
    ...materialized,
    authoredFiles: materialized.authoredFiles
      .map((filePath) =>
        normalizePath(
          path.join(
            runtimeSrcDir,
            path.relative(materialized.srcDir, filePath),
          ),
        ),
      )
      .sort((left, right) => left.localeCompare(right)),
    modules: materialized.modules.map((module) =>
      remapRuntimeModuleToSrcDir(module, materialized.srcDir, runtimeSrcDir),
    ),
    srcDir: runtimeSrcDir,
  };
}

/** Write region entries, bundle them with esbuild, and stage the outputs. */
async function buildDependencyBundles(
  context: PrebundleContext,
  bundleRequests: Map<string, RegionBundleRequest>,
): Promise<DependencyBundleSet | null> {
  const { materialized, runtimeSrcDir } = context;
  const { groupedRequests, requestGroupKeyByTarget } = groupBundleRequests([
    ...bundleRequests.values(),
  ]);

  const inputDir = path.join(materialized.srcDir, DEP_BUNDLE_INPUT_DIR);
  const outputDir = path.join(runtimeSrcDir, DEP_BUNDLE_OUTPUT_DIR);

  const writtenRequests: WrittenRegionBundleRequest[] = [];
  const inputEntries: Array<{ content: string; relativePath: string }> = [];
  for (const groupedRequest of groupedRequests) {
    const regionDir = path.join(
      inputDir,
      sanitizeRegionKey(
        groupedRequest.requests[0]?.regionKey ?? EAGER_REGION_LABEL,
      ),
    );
    const fileName = `${sanitizeEntryName(groupedRequest)}-${hashText(
      groupedRequest.requestKey,
    ).slice(0, 8)}.js`;
    const entryPoint = path.join(regionDir, fileName);
    const renderedEntry = renderBundleEntrySource({
      entryPoint,
      requests: groupedRequest.requests,
    });
    inputEntries.push({
      content: renderedEntry,
      relativePath: path.relative(inputDir, entryPoint).replace(/\\/g, "/"),
    });
    writtenRequests.push({
      entryPoint,
      ...groupedRequest,
    });
  }
  await syncDirectoryEntries(inputDir, inputEntries);

  const esbuildBuild = await loadEsbuildBuild();
  const entryPoints = writtenRequests.map((request) =>
    path.relative(materialized.srcDir, request.entryPoint).replace(/\\/g, "/"),
  );
  const bundleResult = await esbuildBuild({
    absWorkingDir: materialized.srcDir,
    bundle: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[dir]/[name]",
    entryPoints,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: DEP_BUNDLE_OUTPUT_DIR,
    outbase: DEP_BUNDLE_INPUT_DIR,
    platform: "browser",
    splitting: true,
    target: "esnext",
    treeShaking: true,
    write: false,
  });
  const bundleOutputRoot = path.join(
    materialized.srcDir,
    DEP_BUNDLE_OUTPUT_DIR,
  );
  await syncDirectoryEntries(
    outputDir,
    (bundleResult.outputFiles ?? [])
      .filter((outputFile) => outputFile.path.endsWith(".js"))
      .map((outputFile) => ({
        content: outputFile.contents,
        relativePath: path
          .relative(bundleOutputRoot, outputFile.path)
          .replace(/\\/g, "/"),
      })),
    {
      preserve(relativePath) {
        return relativePath.startsWith("shared/");
      },
    },
  );

  const entryOutputByRequestKey = resolveEntryOutputsByRequest({
    bundleSrcDir: materialized.srcDir,
    metafile: bundleResult.metafile,
    outputSrcDir: runtimeSrcDir,
    writtenRequests,
  });
  if (entryOutputByRequestKey.size === 0) {
    return null;
  }

  const canonicalizedEntryOutputs = await canonicalizeDuplicateLazyEntryOutputs(
    {
      entryOutputByRequestKey,
      outputDir,
      outputSrcDir: runtimeSrcDir,
      writtenRequests,
    },
  );

  const collapsedEntryOutputByPath = await collectCollapsibleBundleEntryOutputs(
    [...new Set(canonicalizedEntryOutputs.outputByRequestKey.values())],
  );

  return {
    canonicalizedEntryOutputs,
    collapsedEntryOutputByPath,
    metafile: bundleResult.metafile,
    requestGroupKeyByTarget,
    writtenRequests,
  };
}

/** Merge rewritten authored modules and bundle outputs into the final graph. */
function assembleGraph(
  context: PrebundleContext,
  bundles: DependencyBundleSet,
  authoredEntries: Array<{ content: string; relativePath: string }>,
): MaterializedGraph {
  const { authoredFiles, materialized, runtimeSrcDir } = context;
  const originalSourceIdsByFilePath = new Map(
    materialized.modules.map((module) => [
      normalizePath(module.filePath),
      [...module.sourceModuleIds],
    ]),
  );
  const bundleInputSourceIdsByEntry = new Map(
    bundles.writtenRequests.map((request) => [
      request.entryPoint,
      request.sourceModuleIds,
    ]),
  );
  const bundledModules = collectBundledModules({
    extraModules: bundles.canonicalizedEntryOutputs.canonicalModules,
    bundleSrcDir: materialized.srcDir,
    metafile: bundles.metafile,
    omittedFilePaths: new Set([
      ...bundles.collapsedEntryOutputByPath.keys(),
      ...bundles.canonicalizedEntryOutputs.omittedOutputFilePaths,
    ]),
    outputSrcDir: runtimeSrcDir,
    originalSourceIdsByFilePath,
    syntheticSourceIdsByFilePath: bundleInputSourceIdsByEntry,
  });

  return {
    ...materialized,
    authoredFiles: authoredEntries
      .map((entry) => path.join(runtimeSrcDir, entry.relativePath))
      .sort((left, right) => left.localeCompare(right)),
    modules: [
      ...materialized.modules
        .filter((module) => authoredFiles.has(normalizePath(module.filePath)))
        .map((module) =>
          remapRuntimeModuleToSrcDir(
            module,
            materialized.srcDir,
            runtimeSrcDir,
          ),
        ),
      ...bundledModules,
    ].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    runtimeEntries: [
      ...new Set(
        [
          ...materialized.entries,
          ...authoredEntries.map((entry) => `./${entry.relativePath}`),
          ...bundledModules.map((module) => `./${module.relativePath}`),
        ].sort((left, right) => left.localeCompare(right)),
      ),
    ],
    srcDir: runtimeSrcDir,
  } satisfies MaterializedGraph;
}

function collectBundledModules(input: {
  extraModules: CapturedRuntimeModule[];
  bundleSrcDir: string;
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  omittedFilePaths: Set<string>;
  originalSourceIdsByFilePath: Map<string, string[]>;
  outputSrcDir: string;
  syntheticSourceIdsByFilePath: Map<string, string[]>;
}) {
  const modules: CapturedRuntimeModule[] = [];

  for (const [outputPath, metadata] of Object.entries(input.metafile.outputs)) {
    if (!outputPath.endsWith(".js")) {
      continue;
    }

    const sourceModuleIds = new Set<string>();
    for (const inputPath of Object.keys(metadata.inputs)) {
      const absoluteInputPath = normalizePath(
        path.resolve(input.bundleSrcDir, inputPath),
      );
      const sourceIds =
        input.syntheticSourceIdsByFilePath.get(absoluteInputPath) ??
        input.originalSourceIdsByFilePath.get(absoluteInputPath);
      if (!sourceIds) {
        continue;
      }
      for (const sourceId of sourceIds) {
        sourceModuleIds.add(sourceId);
      }
    }

    const filePath = normalizePath(
      path.resolve(input.outputSrcDir, outputPath),
    );
    if (input.omittedFilePaths.has(filePath)) {
      continue;
    }
    modules.push({
      filePath,
      id: filePath,
      relativePath: path
        .relative(input.outputSrcDir, filePath)
        .replace(/\\/g, "/"),
      sourceModuleIds: [...sourceModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
  }

  modules.push(...input.extraModules);

  return modules.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function remapRuntimeModuleToSrcDir(
  module: CapturedRuntimeModule,
  fromSrcDir: string,
  toSrcDir: string,
): CapturedRuntimeModule {
  return {
    ...module,
    filePath: normalizePath(
      path.join(toSrcDir, path.relative(fromSrcDir, module.filePath)),
    ),
    relativePath: path
      .relative(fromSrcDir, module.filePath)
      .replace(/\\/g, "/"),
  };
}
