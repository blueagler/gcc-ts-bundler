import fs from "node:fs/promises";
import path from "node:path";

import type { Plugin, ResolvedConfig, UserConfig } from "vite";
import type { PluginContext } from "rollup";

import { build } from "../api/build";
import { logInternalDetail } from "../internal/timing";
import {
  materializeCapturedGraph,
  normalizeCapturedCode,
  prepareCaptureRoot,
  resolveDynamicRootModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
  resolveCompilerExterns,
  resolveEntryModuleIds,
  summarizeModuleIdsByPackage,
  shouldCaptureModule,
} from "./capture";
import {
  applyViteBuildGuards,
  INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
  createCompilerOptions,
  resolveBaseChunkName,
  resolveManifestFileSettings,
  resolvePublicPath,
} from "./config";
import { analyzeViteCssOwnership, augmentCompiledViteCss } from "./css";
import type { CapturedModule, ViteCssOwnership } from "./internal-types";
import {
  collectOutputByteBreakdown,
  emitCompiledOutputs,
  listJavaScriptChunks,
  removeRollupJavaScript,
  rewriteHtmlAssets,
} from "./output";
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

  const plugin: Plugin = {
    name: "gcc-ts-bundler:vite",
    apply: "build",
    enforce: "post",
    config(userConfig: UserConfig) {
      return applyViteBuildGuards(userConfig);
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    async transform(code, id) {
      if (!shouldCaptureModule(id, code)) {
        return null;
      }

      if (id.includes("?worker") || id.includes("&worker")) {
        workerImportDetected = true;
      }

      capturedModules.set(id, {
        code: await normalizeCapturedCode(id, code),
        id,
      });
      return null;
    },
    async generateBundle(this: PluginContext, _outputOptions, bundle) {
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
      const cssOwnership: ViteCssOwnership =
        resolvedConfig.build.cssCodeSplit === false
          ? {
              enabled: false,
              htmlLinkedCss: new Set<string>(),
              moduleCssById: new Map<string, string[]>(),
            }
          : analyzeViteCssOwnership(bundle);

      const materialized = await materializeCapturedGraph.call(this, {
        capturedModules,
        cssModuleIdsWithOwnership: cssOwnership.moduleCssById.keys(),
        config: resolvedConfig,
        dynamicRootModuleIds,
        entryModuleIds,
        moduleIds: retainedCaptured.materializedModuleIds,
        srcDir,
      });
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
      const externs = await resolveCompilerExterns({
        captureRoot,
        materialized,
        options,
        projectRoot: resolvedConfig.root,
      });

      const compilerOptions = createCompilerOptions({
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
      const previousRuntimeModuleSourceMapFile =
        process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE;
      if (cssOwnership.enabled) {
        process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE =
          runtimeModuleSourceMapFilePath;
      } else {
        delete process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE;
      }
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
      if (cssOwnership.enabled) {
        await augmentCompiledViteCss({
          baseChunkFilePath: path.join(
            outDir,
            `${resolveBaseChunkName(options)}.js`,
          ),
          manifestFilePath,
          materialized,
          ownership: cssOwnership,
          runtimeModuleSourceMapFilePath,
        });
      }

      removeRollupJavaScript(bundle);
      const emittedOutputFiles = manifestSettings.isInternal
        ? result.outputFiles.filter(
            (filePath) =>
              filePath !== manifestFilePath &&
              filePath !== runtimeModuleSourceMapFilePath,
          )
        : result.outputFiles.filter(
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
      await emitCompiledOutputs(this, emittedOutputFiles, outDir);

      if (options.html?.rewriteEntryScripts ?? REWRITE_ENTRY_SCRIPTS_DEFAULT) {
        rewriteHtmlAssets({
          baseScriptFileName: `${resolveBaseChunkName(options)}.js`,
          bundle,
          publicPath,
          removedChunkFileNames: new Set(
            jsChunks.map((chunk) => chunk.fileName),
          ),
        });
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
