import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Plugin, ResolvedConfig, UserConfig } from "vite";
import type { PluginContext } from "rollup";

import { build } from "../api/build";
import { collectOutputChunkStats } from "../internal/lifecycle-size";
import { logInternalDetail, logInternalTiming } from "../internal/timing";
import {
  normalizeRetainedCapturedModules,
  shouldCaptureModule,
  type CapturedModuleResolutionCache,
} from "./capture";
import {
  resolveDynamicRootModuleIds,
  resolveNormalizedBridgeModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
  resolveEntryModuleIds,
  summarizeModuleIdsByPackage,
} from "./graph";
import {
  applyViteBuildGuards,
  assertNoViteFetchLoader,
  assertNoViteLanguageOut,
  INTERNAL_VITE_AUTHORED_FILES_FILE,
  INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
  createCompilerOptions,
  resolveBaseChunkName,
  resolveManifestFileSettings,
  resolvePublicPath,
} from "./config";
import { analyzeViteCssOwnership, augmentCompiledViteCss } from "./css";
import { resolveCompilerExterns } from "./externs";
import type {
  CapturedModule,
  ViteBuildMetrics,
  ViteCssOwnership,
} from "./internal-types";
import { materializeCapturedGraph } from "./materialize";
import { prebundleMaterializedDependencies } from "./prebundle";
import { collectMaterializedGraphStats } from "./size";
import {
  collectOutputByteBreakdown,
  emitCompiledOutputs,
  listJavaScriptChunks,
  removeRollupJavaScript,
  rewriteHtmlAssets,
} from "./output";
import {
  finalizeBaseJsOutputName,
  renameCompiledNonBaseJsOutputs,
} from "./naming";
import type { GccTsBundlerVitePluginOptions } from "./types";
import { prepareViteWorkspace, stageCompiledCoreOutputs } from "./workspace";

export interface GccTsBundlerVitePlugin {
  apply?: "build" | "serve";
  enforce?: "post" | "pre";
  name: string;
}

const REWRITE_ENTRY_SCRIPTS_DEFAULT = true;

export function gccTsBundler(
  options: GccTsBundlerVitePluginOptions = {},
): GccTsBundlerVitePlugin {
  const capturedModules = new Map<string, CapturedModule>();
  const resolutionCache: CapturedModuleResolutionCache = new Map();
  const buildMetrics: ViteBuildMetrics = {
    normalizedRetainedModuleCount: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    retainedEdgeResolutionCount: 0,
  };
  let resolvedConfig: ResolvedConfig | null = null;
  let workerImportDetected = false;
  const timingTotals = {
    cssAnalysisMs: 0,
    cssAugmentMs: 0,
    emitOutputsMs: 0,
    externsMs: 0,
    htmlRewriteMs: 0,
    materializeMs: 0,
    dependencyPrebundleMs: 0,
    normalizeRetainedMs: 0,
    retainedResolutionMs: 0,
    transformCaptureMs: 0,
  };

  const plugin: Plugin = {
    name: "gcc-ts-bundler:vite",
    apply: "build",
    enforce: "post",
    config(userConfig: UserConfig) {
      assertNoViteLanguageOut(options);
      assertNoViteFetchLoader(options);
      return applyViteBuildGuards(userConfig);
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    async transform(code, id) {
      const startedAt = performance.now();
      if (!shouldCaptureModule(id, code)) {
        return null;
      }

      if (id.includes("?worker") || id.includes("&worker")) {
        workerImportDetected = true;
      }

      capturedModules.set(id, {
        code,
        id,
      });
      timingTotals.transformCaptureMs += performance.now() - startedAt;
      return null;
    },
    async generateBundle(this: PluginContext, outputOptions, bundle) {
      if (!resolvedConfig) {
        throw new Error("gccTsBundler() did not receive resolved Vite config.");
      }
      resolutionCache.clear();
      buildMetrics.normalizedRetainedModuleCount = 0;
      buildMetrics.parseCacheHits = 0;
      buildMetrics.parseCacheMisses = 0;
      buildMetrics.retainedEdgeResolutionCount = 0;
      if (workerImportDetected) {
        this.error(
          "gccTsBundler() does not support worker entry graphs in Vite build mode.",
        );
      }

      const jsChunks = listJavaScriptChunks(bundle);
      if (jsChunks.length === 0) {
        this.error("gccTsBundler() could not find Vite JS chunks to replace.");
      }

      const entryModuleIds = resolveEntryModuleIds(bundle, jsChunks);
      const dynamicRootModuleIds = resolveDynamicRootModuleIds(jsChunks);
      const retainedResolutionStartedAt = performance.now();
      const retainedModuleIds = resolveRetainedModuleIds(
        jsChunks,
        entryModuleIds,
      );
      const retainedCaptured = await resolveRetainedCapturedModuleIds.call(
        this,
        {
          capturedModules,
          metrics: buildMetrics,
          resolutionCache,
          retainedModuleIds,
        },
      );
      timingTotals.retainedResolutionMs +=
        performance.now() - retainedResolutionStartedAt;
      if (retainedCaptured.missingModuleIds.length > 0) {
        this.error(
          "gccTsBundler() could not capture transformed code for retained Rollup modules:\n" +
            retainedCaptured.missingModuleIds.join("\n"),
        );
      }
      const workspace = await prepareViteWorkspace({
        config: resolvedConfig,
        debugDir: options.debug?.dumpCapturedGraphDir,
        options,
        projectRoot: resolvedConfig.root,
      });
      const {
        captureRoot,
        coreOutDir,
        finalOutDir,
        materializedSrcDir,
        srcDir,
      } = workspace;
      const publicPath = resolvePublicPath(resolvedConfig, options);
      const manifestSettings = resolveManifestFileSettings(options);
      const cssAnalysisStartedAt = performance.now();
      const cssOwnership: ViteCssOwnership =
        resolvedConfig.build.cssCodeSplit === false
          ? {
              enabled: false,
              htmlLinkedCss: new Set<string>(),
              moduleCssById: new Map<string, string[]>(),
            }
          : analyzeViteCssOwnership(bundle);
      timingTotals.cssAnalysisMs += performance.now() - cssAnalysisStartedAt;

      const normalizeStartedAt = performance.now();
      let materializedModuleIds = [...retainedCaptured.materializedModuleIds];
      const normalizedCapturedModules = await normalizeRetainedCapturedModules({
        capturedModules,
        metrics: buildMetrics,
        moduleIds: materializedModuleIds,
      });
      while (true) {
        const additionalBridgeModuleIds =
          await resolveNormalizedBridgeModuleIds.call(this, {
            capturedModules,
            metrics: buildMetrics,
            normalizedCapturedModules,
            resolutionCache,
            retainedModuleIds: materializedModuleIds,
          });
        if (additionalBridgeModuleIds.length === 0) {
          break;
        }
        const normalizedBridgeModules = await normalizeRetainedCapturedModules({
          capturedModules,
          metrics: buildMetrics,
          moduleIds: additionalBridgeModuleIds,
        });
        for (const [moduleId, record] of normalizedBridgeModules) {
          normalizedCapturedModules.set(moduleId, record);
        }
        materializedModuleIds = [
          ...new Set([...materializedModuleIds, ...additionalBridgeModuleIds]),
        ].sort((left, right) => left.localeCompare(right));
      }
      buildMetrics.normalizedRetainedModuleCount =
        normalizedCapturedModules.size;
      timingTotals.normalizeRetainedMs +=
        performance.now() - normalizeStartedAt;

      const materializeStartedAt = performance.now();
      const materializedBeforePrebundle = await materializeCapturedGraph.call(
        this,
        {
          capturedModules: normalizedCapturedModules,
          cssModuleIdsWithOwnership: cssOwnership.moduleCssById.keys(),
          config: resolvedConfig,
          dynamicRootModuleIds,
          entryModuleIds,
          metrics: buildMetrics,
          moduleIds: materializedModuleIds,
          resolutionCache,
          srcDir: materializedSrcDir,
        },
      );
      timingTotals.materializeMs += performance.now() - materializeStartedAt;
      logInternalDetail("vite:captured-modules", `${capturedModules.size}`);
      logInternalDetail("vite:retained-modules", `${retainedModuleIds.length}`);
      logInternalDetail(
        "vite:retained-captured-modules",
        `${materializedBeforePrebundle.modules.length}`,
      );
      logInternalDetail(
        "vite:retained-packages",
        summarizeModuleIdsByPackage(
          materializedBeforePrebundle.modules.flatMap(
            (module) => module.sourceModuleIds,
          ),
        ) || "none",
      );
      logInternalDetail(
        "vite:retained-empty-modules",
        `${materializedBeforePrebundle.retainedEmptyModuleIds.length}`,
      );
      logInternalDetail(
        "vite:pruned-empty-modules",
        `${materializedBeforePrebundle.prunedEmptyModuleIds.length}`,
      );
      logInternalDetail(
        "vite:retained-dynamic-roots",
        `${dynamicRootModuleIds.length}`,
      );
      logInternalDetail(
        "vite:normalized-retained-modules",
        `${buildMetrics.normalizedRetainedModuleCount}`,
      );
      logInternalDetail(
        "vite:parse-cache",
        `hits=${buildMetrics.parseCacheHits} misses=${buildMetrics.parseCacheMisses}`,
      );
      logInternalDetail(
        "vite:retained-edge-resolutions",
        `${buildMetrics.retainedEdgeResolutionCount}`,
      );
      const prebundleInputStats = await collectMaterializedGraphStats({
        capturedModules,
        dynamicRootCount: dynamicRootModuleIds.length,
        entryCount: entryModuleIds.length,
        materialized: materializedBeforePrebundle,
      });
      logInternalDetail(
        "vite:graph-before-prebundle",
        `modules=${prebundleInputStats.moduleCount} js=${prebundleInputStats.totalBytes} forwarding=${prebundleInputStats.forwardingModuleCount} entries=${prebundleInputStats.entryCount} lazy=${prebundleInputStats.lazyRootCount} packages=${prebundleInputStats.packageSummary || "none"}`,
      );
      const dependencyPrebundleStartedAt = performance.now();
      const materialized = await prebundleMaterializedDependencies({
        dynamicRootModuleIds,
        materialized: materializedBeforePrebundle,
        outputSrcDir: srcDir,
      });
      timingTotals.dependencyPrebundleMs +=
        performance.now() - dependencyPrebundleStartedAt;
      logInternalDetail(
        "vite:prebundled-runtime-modules",
        `${materialized.modules.length}`,
      );
      const prebundleOutputStats = await collectMaterializedGraphStats({
        capturedModules,
        dynamicRootCount: dynamicRootModuleIds.length,
        entryCount: entryModuleIds.length,
        materialized,
      });
      logInternalDetail(
        "vite:graph-after-prebundle",
        `modules=${prebundleOutputStats.moduleCount} js=${prebundleOutputStats.totalBytes} forwarding=${prebundleOutputStats.forwardingModuleCount} entries=${prebundleOutputStats.entryCount} lazy=${prebundleOutputStats.lazyRootCount} packages=${prebundleOutputStats.packageSummary || "none"}`,
      );
      const externsStartedAt = performance.now();
      const externs = await resolveCompilerExterns({
        captureRoot,
        materialized,
        options,
        projectRoot: resolvedConfig.root,
      });
      timingTotals.externsMs += performance.now() - externsStartedAt;

      const compilerOptions = createCompilerOptions({
        config: resolvedConfig,
        options,
        outDir: coreOutDir,
        projectRoot: resolvedConfig.root,
        publicPath,
        srcDir: materialized.srcDir,
        entries: materialized.entries,
        externs,
        manifestFile: manifestSettings.fileName,
      });
      const runtimeModuleSourceMapFilePath = path.join(
        captureRoot,
        INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
      );
      const authoredFilesFilePath = path.join(
        captureRoot,
        INTERNAL_VITE_AUTHORED_FILES_FILE,
      );
      await fs.writeFile(
        authoredFilesFilePath,
        JSON.stringify(materialized.authoredFiles, null, 2),
        "utf8",
      );
      const previousRuntimeModuleSourceMapFile =
        process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE;
      const previousAuthoredFilesFile =
        process.env.GCC_VITE_AUTHORED_FILES_FILE;
      process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE =
        runtimeModuleSourceMapFilePath;
      process.env.GCC_VITE_AUTHORED_FILES_FILE = authoredFilesFilePath;
      let result;
      try {
        result = await build(compilerOptions);
      } finally {
        if (previousRuntimeModuleSourceMapFile === undefined) {
          delete process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE;
        } else {
          process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE =
            previousRuntimeModuleSourceMapFile;
        }
        if (previousAuthoredFilesFile === undefined) {
          delete process.env.GCC_VITE_AUTHORED_FILES_FILE;
        } else {
          process.env.GCC_VITE_AUTHORED_FILES_FILE = previousAuthoredFilesFile;
        }
      }
      if (result.exitCode !== 0 || result.emitSkipped) {
        const message = result.diagnostics
          .map(formatDiagnosticMessage)
          .join("\n");
        this.error(
          message ||
            "gccTsBundler() failed while compiling the captured Vite graph.",
        );
      }

      const compiledCoreOutputs = await stageCompiledCoreOutputs({
        coreOutDir,
        finalOutDir,
        outputFiles: result.outputFiles,
      });
      const manifestFilePath = path.join(
        compiledCoreOutputs.finalOutDir,
        manifestSettings.fileName,
      );
      const manifest = JSON.parse(
        await fs.readFile(manifestFilePath, "utf8"),
      ) as { modules?: Record<string, string> };
      logInternalDetail(
        "vite:gcc-runtime-modules",
        `${Object.keys(manifest.modules ?? {}).length}`,
      );
      const renamedNonBaseOutputs = await renameCompiledNonBaseJsOutputs({
        baseChunkName: resolveBaseChunkName(options),
        dynamicRootModuleIds,
        jsChunks,
        manifestFilePath,
        materialized,
        outDir: compiledCoreOutputs.finalOutDir,
        outputFiles: compiledCoreOutputs.outputFiles,
        outputOptions,
        publicPath,
        runtimeModuleSourceMapFilePath,
      });
      if (cssOwnership.enabled) {
        const cssAugmentStartedAt = performance.now();
        await augmentCompiledViteCss({
          baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
          manifestFilePath,
          materialized,
          ownership: cssOwnership,
          runtimeModuleSourceMapFilePath,
        });
        timingTotals.cssAugmentMs += performance.now() - cssAugmentStartedAt;
      }
      const finalizedBaseOutput = await finalizeBaseJsOutputName({
        baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
        baseSeed: renamedNonBaseOutputs.baseSeed,
        emittedOutputFiles: renamedNonBaseOutputs.emittedOutputFiles,
        manifestFilePath,
        outputOptions,
        outDir: compiledCoreOutputs.finalOutDir,
        publicPath,
      });

      removeRollupJavaScript(bundle);
      const emittedOutputFiles = manifestSettings.isInternal
        ? finalizedBaseOutput.emittedOutputFiles.filter(
            (filePath) =>
              filePath !== manifestFilePath &&
              filePath !== runtimeModuleSourceMapFilePath,
          )
        : finalizedBaseOutput.emittedOutputFiles.filter(
            (filePath) => filePath !== runtimeModuleSourceMapFilePath,
          );
      const outputBytes = await collectOutputByteBreakdown({
        bundle,
        emittedOutputFiles,
      });
      logInternalDetail(
        "vite:output-bytes",
        `js=${outputBytes.js} css=${outputBytes.css} fonts=${outputBytes.fonts} assets=${outputBytes.assets}`,
      );
      const finalBaseChunkFilePath = path.join(
        compiledCoreOutputs.finalOutDir,
        finalizedBaseOutput.baseScriptFileName,
      );
      const outputChunkStats = await collectOutputChunkStats({
        entryFilePath: finalBaseChunkFilePath,
        lazyFilePaths: emittedOutputFiles.filter(
          (filePath) =>
            filePath.endsWith(".js") && filePath !== finalBaseChunkFilePath,
        ),
      });
      logInternalDetail(
        "vite:output-js-chunks",
        `entry=${outputChunkStats.entryRawBytes}/${outputChunkStats.entryGzipBytes} lazy=${outputChunkStats.lazyRawBytes}/${outputChunkStats.lazyGzipBytes} factories=${outputChunkStats.entryFactoryCount}+${outputChunkStats.lazyFactoryCount}`,
      );
      const emitOutputsStartedAt = performance.now();
      await emitCompiledOutputs(
        this,
        emittedOutputFiles,
        compiledCoreOutputs.finalOutDir,
      );
      timingTotals.emitOutputsMs += performance.now() - emitOutputsStartedAt;

      if (options.html?.rewriteEntryScripts ?? REWRITE_ENTRY_SCRIPTS_DEFAULT) {
        const htmlRewriteStartedAt = performance.now();
        rewriteHtmlAssets({
          baseScriptFileName: finalizedBaseOutput.baseScriptFileName,
          bundle,
          publicPath,
          removedChunkFileNames: new Set(
            jsChunks.map((chunk) => chunk.fileName),
          ),
        });
        timingTotals.htmlRewriteMs += performance.now() - htmlRewriteStartedAt;
      }

      for (const [label, durationMs] of Object.entries({
        "vite:transform-capture": timingTotals.transformCaptureMs,
        "vite:retained-resolution": timingTotals.retainedResolutionMs,
        "vite:normalize-retained": timingTotals.normalizeRetainedMs,
        "vite:materialize": timingTotals.materializeMs,
        "vite:dependency-prebundle": timingTotals.dependencyPrebundleMs,
        "vite:externs": timingTotals.externsMs,
        "vite:css-analysis": timingTotals.cssAnalysisMs,
        "vite:css-augment": timingTotals.cssAugmentMs,
        "vite:emit-outputs": timingTotals.emitOutputsMs,
        "vite:html-rewrite": timingTotals.htmlRewriteMs,
      })) {
        if (durationMs > 0) {
          logInternalTiming(label, durationMs);
        }
      }
    },
  };

  return plugin as unknown as GccTsBundlerVitePlugin;
}

function formatDiagnosticMessage(diagnostic: unknown) {
  const candidate =
    diagnostic && typeof diagnostic === "object"
      ? (diagnostic as { messageText?: unknown }).messageText
      : undefined;
  if (typeof candidate === "string") {
    return candidate;
  }
  return JSON.stringify(diagnostic);
}
