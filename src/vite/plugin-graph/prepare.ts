import type { ResolvedConfig } from "vite";
import type { TransformOptions } from "rolldown/utils";

import { logInternalDetail, SHOW_INTERNAL_TIMINGS } from "../../shared/timing";
import type { CapturedModuleResolutionCache } from "../capture";
import { resolveManifestFileSettings, resolvePublicPath } from "../config";
import { analyzeViteCssOwnership } from "../css";
import { resolveCompilerExterns } from "../compiler-externs";
import {
  resolveDynamicRootModuleIds,
  resolveEntryModuleIds,
  resolveHtmlEntryModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
  summarizeModuleIdsByPackage,
} from "../graph";
import type {
  CapturedModule,
  MaterializedGraph,
  OutputBundle,
  OutputChunk,
  PluginContext,
  ViteBuildMetrics,
  ViteCssOwnership,
  ViteWorkspaceLayout,
} from "../internal-types";
import { materializeCapturedGraph } from "../materialize";
import { listJavaScriptChunks } from "../output";
import { measure, measureAsync } from "../plugin-compile";
import type { PreparedViteGraph, ViteTimingTotals } from "./index";
import { normalizeCapturedGraph } from "./normalize";
import { prebundleMaterializedDependencies } from "../prebundle";
import { collectMaterializedGraphStats } from "../size";
import { collectViteTypeMetadata } from "../type-metadata";
import type { GccTsBundlerVitePluginOptions } from "../types";

export async function prepareViteGraph(
  this: PluginContext,
  input: {
    buildMetrics: ViteBuildMetrics;
    bundle: OutputBundle;
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    nativeDefines: TransformOptions["define"];
    options: GccTsBundlerVitePluginOptions;
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
    workspace: ViteWorkspaceLayout;
  },
): Promise<PreparedViteGraph> {
  const jsChunks = listJavaScriptChunks(input.bundle);
  if (jsChunks.length === 0) {
    this.error("gccTsBundler() could not find Vite JS chunks to replace.");
  }

  const htmlEntryModuleIds = resolveHtmlEntryModuleIds(input.bundle, jsChunks);
  if (htmlEntryModuleIds.length > 1) {
    this.error(
      "gccTsBundler() does not yet support multiple distinct HTML entry facades. " +
        `Found:\n${htmlEntryModuleIds.join("\n")}`,
    );
  }
  const entryModuleIds =
    htmlEntryModuleIds.length > 0
      ? htmlEntryModuleIds
      : resolveEntryModuleIds(input.bundle, jsChunks);
  const dynamicRootModuleIds = resolveDynamicRootModuleIds(jsChunks);
  const retainedModuleIds = resolveRetainedModuleIds(jsChunks, entryModuleIds);
  applyRenderedModuleEvidence(input.capturedModules, jsChunks);
  const retainedCaptured = await measureAsync(
    input.timingTotals,
    "retainedResolutionMs",
    () =>
      resolveRetainedCapturedModuleIds.call(this, {
        capturedModules: input.capturedModules,
        metrics: input.buildMetrics,
        projectRoot: input.config.root,
        resolutionCache: input.resolutionCache,
        retainedModuleIds,
        unshakenModuleIds: [...entryModuleIds, ...dynamicRootModuleIds],
      }),
  );
  if (retainedCaptured.missingModuleIds.length > 0) {
    this.error(
      "gccTsBundler() could not capture transformed code for retained Rollup modules:\n" +
        retainedCaptured.missingModuleIds.join("\n"),
    );
  }

  const { workspace } = input;
  const publicPath = resolvePublicPath(input.config, input.options);
  const manifestSettings = resolveManifestFileSettings(input.options);
  const cssOwnership = measure(
    input.timingTotals,
    "cssAnalysisMs",
    (): ViteCssOwnership =>
      input.config.build.cssCodeSplit === false
        ? {
            enabled: false,
            htmlLinkedCss: new Set<string>(),
            moduleCssById: new Map<string, string[]>(),
          }
        : analyzeViteCssOwnership(input.bundle),
  );

  const normalized = await normalizeCapturedGraph.call(this, {
    bundle: input.bundle,
    buildMetrics: input.buildMetrics,
    capturedModules: input.capturedModules,
    initialModuleIds: retainedCaptured.materializedModuleIds,
    resolutionCache: input.resolutionCache,
    timingTotals: input.timingTotals,
  });
  const materializedBeforePrebundle = await measureAsync(
    input.timingTotals,
    "materializeMs",
    () =>
      materializeCapturedGraph.call(this, {
        capturedModules: normalized.capturedModules,
        cssModuleIdsWithOwnership: cssOwnership.moduleCssById.keys(),
        config: input.config,
        dynamicRootModuleIds,
        entryModuleIds,
        metrics: input.buildMetrics,
        moduleIds: normalized.moduleIds,
        nativeDefines: input.nativeDefines,
        resolutionCache: input.resolutionCache,
        srcDir: workspace.materializedSrcDir,
      }),
  );
  await logCapturedGraph({
    buildMetrics: input.buildMetrics,
    capturedModuleCount: input.capturedModules.size,
    capturedModules: input.capturedModules,
    dynamicRootModuleIds,
    entryModuleIds,
    materialized: materializedBeforePrebundle,
    retainedModuleCount: retainedModuleIds.length,
    stage: "before-prebundle",
  });

  // Prebundling rewrites files in place. All extern modes must observe the
  // settled graph that Closure compiles, not the original provenance graph.
  const materialized = await measureAsync(
    input.timingTotals,
    "dependencyPrebundleMs",
    () =>
      prebundleMaterializedDependencies({
        dynamicRootModuleIds,
        materialized: materializedBeforePrebundle,
        outputSrcDir: workspace.srcDir,
      }),
  );
  const externs = await measureAsync(input.timingTotals, "externsMs", () =>
    resolveCompilerExterns({
      captureRoot: workspace.captureRoot,
      materialized,
      options: input.options,
      projectRoot: input.config.root,
    }),
  );
  logInternalDetail(
    "vite:prebundled-runtime-modules",
    `${materialized.modules.length}`,
  );
  const typeMetadata = await measureAsync(
    input.timingTotals,
    "typeMetadataMs",
    () =>
      collectViteTypeMetadata({
        cache: {
          captureRoot: workspace.captureRoot,
          options: input.options,
        },
        materialized,
        projectRoot: input.config.root,
        sourceGraph: materializedBeforePrebundle,
      }),
  );
  logInternalDetail(
    "vite:type-metadata",
    `files=${typeMetadata.files.length} annotations=${typeMetadata.extractedCounts.annotationCount} members=${typeMetadata.extractedCounts.memberAnnotationCount} declarations=${typeMetadata.extractedCounts.typeDeclarationCount} enums=${typeMetadata.extractedCounts.enumDeclarationCount} diagnostics=${typeMetadata.diagnostics.length}`,
  );
  await logCapturedGraph({
    buildMetrics: input.buildMetrics,
    capturedModuleCount: input.capturedModules.size,
    capturedModules: input.capturedModules,
    dynamicRootModuleIds,
    entryModuleIds,
    materialized,
    retainedModuleCount: retainedModuleIds.length,
    stage: "after-prebundle",
  });

  return {
    assetPlaceholders: normalized.assetPlaceholders,
    captureRoot: workspace.captureRoot,
    coreOutDir: workspace.coreOutDir,
    cssOwnership,
    dynamicRootModuleIds,
    externs,
    finalOutDir: workspace.finalOutDir,
    jsChunks,
    manifestSettings,
    materialized,
    publicPath,
    typeMetadata,
  };
}

async function logCapturedGraph(input: {
  buildMetrics: ViteBuildMetrics;
  capturedModuleCount: number;
  capturedModules: Map<string, CapturedModule>;
  dynamicRootModuleIds: string[];
  entryModuleIds: string[];
  materialized: MaterializedGraph;
  retainedModuleCount: number;
  stage: "after-prebundle" | "before-prebundle";
}) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  if (input.stage === "before-prebundle") {
    logInternalDetail("vite:captured-modules", `${input.capturedModuleCount}`);
    logInternalDetail("vite:retained-modules", `${input.retainedModuleCount}`);
    logInternalDetail(
      "vite:retained-captured-modules",
      `${input.materialized.modules.length}`,
    );
    logInternalDetail(
      "vite:retained-packages",
      summarizeModuleIdsByPackage(
        input.materialized.modules.flatMap((module) => module.sourceModuleIds),
      ) || "none",
    );
    logInternalDetail(
      "vite:retained-empty-modules",
      `${input.materialized.retainedEmptyModuleIds.length}`,
    );
    logInternalDetail(
      "vite:pruned-empty-modules",
      `${input.materialized.prunedEmptyModuleIds.length}`,
    );
    logInternalDetail(
      "vite:retained-dynamic-roots",
      `${input.dynamicRootModuleIds.length}`,
    );
    logInternalDetail(
      "vite:normalized-retained-modules",
      `${input.buildMetrics.normalizedRetainedModuleCount}`,
    );
    logInternalDetail(
      "vite:reassigned-constants",
      `${input.buildMetrics.reassignedConstantDemotionCount}`,
    );
    logInternalDetail(
      "vite:parse-cache",
      `hits=${input.buildMetrics.parseCacheHits} misses=${input.buildMetrics.parseCacheMisses}`,
    );
    // Counted per visit, not per distinct edge: routing walks each module once
    // per analysis pass, so one dead edge reports several events.
    logInternalDetail(
      "vite:dead-dynamic-edge-drops",
      `events=${input.buildMetrics.deadDynamicEdgeDropCount}`,
    );
    logInternalDetail(
      "vite:retained-edge-resolutions",
      `${input.buildMetrics.retainedEdgeResolutionCount}`,
    );
  }

  const stats = await collectMaterializedGraphStats({
    capturedModules: input.capturedModules,
    dynamicRootCount: input.dynamicRootModuleIds.length,
    entryCount: input.entryModuleIds.length,
    materialized: input.materialized,
  });
  logInternalDetail(
    `vite:graph-${input.stage}`,
    `modules=${stats.moduleCount} js=${stats.totalBytes} forwarding=${stats.forwardingModuleCount} entries=${stats.entryCount} lazy=${stats.lazyRootCount} packages=${stats.packageSummary || "none"}`,
  );
}

function applyRenderedModuleEvidence(
  capturedModules: Map<string, CapturedModule>,
  chunks: OutputChunk[],
) {
  for (const chunk of chunks) {
    for (const [moduleId, rendered] of Object.entries(chunk.modules)) {
      const record = capturedModules.get(moduleId);
      if (record) {
        record.renderedLength = rendered.renderedLength;
      }
    }
  }
}
