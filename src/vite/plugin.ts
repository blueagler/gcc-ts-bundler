import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Plugin, ResolvedConfig, UserConfig } from "vite";
import type { PluginContext } from "rollup";

import { build } from "../api/build";
import { logInternalDetail, logInternalTiming } from "../internal/timing";
import {
  materializeCapturedGraph,
  normalizeRetainedCapturedModules,
  prepareCaptureRoot,
  resolveDynamicRootModuleIds,
  resolveNormalizedBridgeModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
  resolveEntryModuleIds,
  summarizeModuleIdsByPackage,
  shouldCaptureModule,
} from "./capture";
import {
  applyViteBuildGuards,
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
import type { CapturedModule, ViteCssOwnership } from "./internal-types";
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
  let resolvedConfig: ResolvedConfig | null = null;
  let workerImportDetected = false;
  const timingTotals = {
    cssAnalysisMs: 0,
    cssAugmentMs: 0,
    emitOutputsMs: 0,
    externsMs: 0,
    htmlRewriteMs: 0,
    materializeMs: 0,
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
      const captureRoot = await prepareCaptureRoot({
        debugDir: options.debug?.dumpCapturedGraphDir,
        projectRoot: resolvedConfig.root,
      });
      const srcDir = path.join(captureRoot, "src");
      const outDir = path.join(captureRoot, "gcc-out");
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
        moduleIds: materializedModuleIds,
      });
      while (true) {
        const additionalBridgeModuleIds =
          await resolveNormalizedBridgeModuleIds.call(this, {
            capturedModules,
            normalizedCapturedModules,
            retainedModuleIds: materializedModuleIds,
          });
        if (additionalBridgeModuleIds.length === 0) {
          break;
        }
        const normalizedBridgeModules = await normalizeRetainedCapturedModules({
          capturedModules,
          moduleIds: additionalBridgeModuleIds,
        });
        for (const [moduleId, record] of normalizedBridgeModules) {
          normalizedCapturedModules.set(moduleId, record);
        }
        materializedModuleIds = [
          ...new Set([...materializedModuleIds, ...additionalBridgeModuleIds]),
        ].sort((left, right) => left.localeCompare(right));
      }
      timingTotals.normalizeRetainedMs +=
        performance.now() - normalizeStartedAt;

      const materializeStartedAt = performance.now();
      const materialized = await materializeCapturedGraph.call(this, {
        capturedModules: normalizedCapturedModules,
        cssModuleIdsWithOwnership: cssOwnership.moduleCssById.keys(),
        config: resolvedConfig,
        dynamicRootModuleIds,
        entryModuleIds,
        moduleIds: materializedModuleIds,
        srcDir,
      });
      timingTotals.materializeMs += performance.now() - materializeStartedAt;
      logInternalDetail("vite:captured-modules", `${capturedModules.size}`);
      logInternalDetail("vite:retained-modules", `${retainedModuleIds.length}`);
      logInternalDetail(
        "vite:retained-captured-modules",
        `${materialized.modules.length}`,
      );
      logInternalDetail(
        "vite:retained-packages",
        summarizeModuleIdsByPackage(
          materialized.modules.map((module) => module.id),
        ) || "none",
      );
      logInternalDetail(
        "vite:retained-empty-modules",
        `${materialized.retainedEmptyModuleIds.length}`,
      );
      logInternalDetail(
        "vite:pruned-empty-modules",
        `${materialized.prunedEmptyModuleIds.length}`,
      );
      logInternalDetail(
        "vite:retained-dynamic-roots",
        `${dynamicRootModuleIds.length}`,
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
        outDir,
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

      const manifestFilePath = path.join(outDir, manifestSettings.fileName);
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
        outDir,
        outputFiles: result.outputFiles,
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
        outDir,
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
      const emitOutputsStartedAt = performance.now();
      await emitCompiledOutputs(this, emittedOutputFiles, outDir);
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
