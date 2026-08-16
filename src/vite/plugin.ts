import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { Plugin, ResolvedConfig, UserConfig } from "vite";

import { build } from "../api/build";
import { finalizeJavaScriptOutputs } from "../build/closure/final-minify";
import {
  normalizeBuildOptions,
  resolveChunkOutputType,
} from "../build/resolve/options";
import type { BuildOptions, LanguageOut } from "../api/types";
import type { InternalBuildOptions } from "../build/types";
import {
  type EnvironmentOverrides,
  withEnvironment,
} from "../shared/environment";
import { collectOutputChunkStats } from "../shared/lifecycle-size";
import { logInternalDetail, logInternalTiming } from "../shared/timing";
import {
  getCapturedModuleAnalysis,
  normalizeRetainedCapturedModules,
  resolveCapturedModuleFormat,
  restoreEmptyDependencyModuleSource,
  shouldCaptureModule,
} from "./capture";
import type { CapturedModuleResolutionCache } from "./capture";
import {
  applyViteBuildGuards,
  assertNoViteLanguageOut,
  createCompilerOptions,
  INTERNAL_VITE_AUTHORED_FILES_FILE,
  INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
  resolveBaseChunkName,
  resolveManifestFileSettings,
  resolvePublicPath,
  resolveViteLanguageOut,
  resolveViteLanguageOutTarget,
} from "./config";
import {
  analyzeViteCssOwnership,
  augmentCompiledViteCss,
  ownershipNeedsCssRuntime,
} from "./css";
import { resolveCompilerExterns } from "./externs";
import type { CompilerExternArtifacts } from "./externs";
import {
  resolveDynamicRootModuleIds,
  resolveEntryModuleIds,
  resolveHtmlEntryModuleIds,
  resolveNormalizedBridgeModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
  summarizeModuleIdsByPackage,
} from "./graph";
import type {
  CapturedModule,
  CompiledCoreOutputSet,
  ManifestFileSettings,
  MaterializedGraph,
  NormalizedOutputOptions,
  OutputBundle,
  OutputChunk,
  PluginContext,
  ViteBuildMetrics,
  ViteChunkOutputType,
  ViteCssOwnership,
} from "./internal-types";
import { materializeCapturedGraph } from "./materialize";
import {
  finalizeBaseJsOutputName,
  renameCompiledNonBaseJsOutputs,
} from "./naming";
import {
  collectOutputByteBreakdown,
  listJavaScriptChunks,
  preserveCompiledChunkIdentities,
  resolveViteAssetUrls,
  rewritePreservedImportSpecifiers,
} from "./output";
import { prebundleMaterializedDependencies } from "./prebundle";
import { serializeRollupChunkGraph } from "./rollup-chunks";
import { parseGccRuntimeManifest } from "./runtime-manifest";
import { collectMaterializedGraphStats } from "./size";
import { collectViteTypeMetadata } from "./type-metadata";
import type { ViteTypeMetadataSidecar } from "./type-metadata";
import type { GccTsBundlerVitePluginOptions } from "./types";
import { prepareViteWorkspace, stageCompiledCoreOutputs } from "./workspace";

interface GccTsBundlerPlugin {
  name: string;
}
interface ViteTimingTotals {
  cssAnalysisMs: number;
  cssAugmentMs: number;
  dependencyPrebundleMs: number;
  emitOutputsMs: number;
  externsMs: number;
  htmlRewriteMs: number;
  materializeMs: number;
  normalizeRetainedMs: number;
  retainedResolutionMs: number;
  transformCaptureMs: number;
  typeMetadataMs: number;
}

interface PreparedViteGraph {
  captureRoot: string;
  coreOutDir: string;
  cssOwnership: ViteCssOwnership;
  dynamicRootModuleIds: string[];
  externs: CompilerExternArtifacts;
  finalOutDir: string;
  jsChunks: OutputChunk[];
  manifestSettings: ManifestFileSettings;
  materialized: MaterializedGraph;
  publicPath: string;
  typeMetadata: ViteTypeMetadataSidecar;
}

interface CompiledViteGraph extends PreparedViteGraph {
  chunkOutputType: ViteChunkOutputType;
  compiledCoreOutputs: CompiledCoreOutputSet;
  manifestFilePath: string;
  runtimeModuleSourceMapFilePath: string;
}

/**
 * Runs the compiler options through the shared resolver, so the gating rules
 * for `chunks.outputType` (language level, chunk mode) live in exactly one
 * place and the Vite side just consumes the answer.
 */
function resolveViteChunkOutputType(
  compilerOptions: BuildOptions,
): ViteChunkOutputType {
  const resolved = normalizeBuildOptions(compilerOptions);
  return resolveChunkOutputType({
    chunkMode: resolved.chunks.mode,
    languageOut: resolved.languageOut,
    outputType: resolved.chunks.outputType,
  });
}

export function gccTsBundler(
  options: GccTsBundlerVitePluginOptions = {},
): GccTsBundlerPlugin {
  const capturedModules = new Map<string, CapturedModule>();
  const resolutionCache: CapturedModuleResolutionCache = new Map();
  const buildMetrics = createBuildMetrics();
  const timingTotals = createTimingTotals();
  let requestedLanguageOut: LanguageOut | null = null;
  let resolvedConfig: ResolvedConfig | null = null;
  let workerImportDetected = false;

  const plugin: Plugin = {
    name: "gcc-ts-bundler:vite",
    apply: "build",
    applyToEnvironment(environment) {
      return environment.name === "client";
    },
    enforce: "post",
    config(userConfig: UserConfig) {
      assertNoViteLanguageOut(options);
      requestedLanguageOut = resolveViteLanguageOutTarget(
        userConfig.build?.target,
      );
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
      workerImportDetected ||= id.includes("?worker") || id.includes("&worker");
      const capturedCode = await restoreEmptyDependencyModuleSource(id, code);
      const record: CapturedModule = { code: capturedCode, id };
      record.rawAnalysis = getCapturedModuleAnalysis(record);
      record.format = await resolveCapturedModuleFormat(record);
      capturedModules.set(id, record);
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

      resolutionCache.clear();
      resetBuildMetrics(buildMetrics);
      const prepared = await prepareViteGraph.call(this, {
        buildMetrics,
        bundle,
        capturedModules,
        config: resolvedConfig,
        options,
        resolutionCache,
        timingTotals,
      });
      const compiled = await compileViteGraph.call(this, {
        config: resolvedConfig,
        languageOut:
          requestedLanguageOut ?? resolveViteLanguageOut(resolvedConfig),
        options,
        prepared,
      });
      await emitViteGraph.call(this, {
        bundle,
        config: resolvedConfig,
        compiled,
        options,
        outputOptions,
        timingTotals,
      });
      logViteTimings(timingTotals);
    },
  };
  return plugin;
}

async function prepareViteGraph(
  this: PluginContext,
  input: {
    buildMetrics: ViteBuildMetrics;
    bundle: OutputBundle;
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    options: GccTsBundlerVitePluginOptions;
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
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

  const workspace = await prepareViteWorkspace({
    config: input.config,
    debugDir: input.options.debug?.dumpCapturedGraphDir,
    options: input.options,
    projectRoot: input.config.root,
  });
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

  // Externs analysis keeps its app-side scans on the pre-prebundle graph and
  // starts them immediately, so it still overlaps with prebundling; the
  // dependency-hazard scan awaits the prebundle promise inside, because the
  // string-keyed field definitions it looks for are created by esbuild's
  // lowering and only exist in the graph Closure actually compiles.
  const prebundlePromise = measureAsync(
    input.timingTotals,
    "dependencyPrebundleMs",
    () =>
      prebundleMaterializedDependencies({
        dynamicRootModuleIds,
        materialized: materializedBeforePrebundle,
        outputSrcDir: workspace.srcDir,
      }),
  );
  const [materialized, externs] = await Promise.all([
    prebundlePromise,
    measureAsync(input.timingTotals, "externsMs", () =>
      resolveCompilerExterns({
        captureRoot: workspace.captureRoot,
        materialized: materializedBeforePrebundle,
        options: input.options,
        postPrebundleMaterialized: prebundlePromise,
        projectRoot: input.config.root,
      }),
    ),
  ]);
  logInternalDetail(
    "vite:prebundled-runtime-modules",
    `${materialized.modules.length}`,
  );
  const typeMetadata = await measureAsync(
    input.timingTotals,
    "typeMetadataMs",
    () =>
      collectViteTypeMetadata({
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

async function normalizeCapturedGraph(
  this: PluginContext,
  input: {
    buildMetrics: ViteBuildMetrics;
    capturedModules: Map<string, CapturedModule>;
    initialModuleIds: string[];
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
  },
) {
  return measureAsync(input.timingTotals, "normalizeRetainedMs", async () => {
    let moduleIds = [...input.initialModuleIds];
    const normalizedCapturedModules = await normalizeRetainedCapturedModules({
      capturedModules: input.capturedModules,
      metrics: input.buildMetrics,
      moduleIds,
    });

    for (;;) {
      const bridgeModuleIds = await resolveNormalizedBridgeModuleIds.call(
        this,
        {
          capturedModules: input.capturedModules,
          metrics: input.buildMetrics,
          normalizedCapturedModules,
          resolutionCache: input.resolutionCache,
          retainedModuleIds: moduleIds,
        },
      );
      if (bridgeModuleIds.length === 0) {
        break;
      }
      const bridgeModules = await normalizeRetainedCapturedModules({
        capturedModules: input.capturedModules,
        metrics: input.buildMetrics,
        moduleIds: bridgeModuleIds,
      });
      for (const [moduleId, record] of bridgeModules) {
        normalizedCapturedModules.set(moduleId, record);
      }
      moduleIds = [...new Set([...moduleIds, ...bridgeModuleIds])].sort(
        (left, right) => left.localeCompare(right),
      );
    }

    input.buildMetrics.normalizedRetainedModuleCount =
      normalizedCapturedModules.size;
    return { capturedModules: normalizedCapturedModules, moduleIds };
  });
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

async function compileViteGraph(
  this: PluginContext,
  input: {
    config: ResolvedConfig;
    languageOut: LanguageOut;
    options: GccTsBundlerVitePluginOptions;
    prepared: PreparedViteGraph;
  },
): Promise<CompiledViteGraph> {
  const { prepared } = input;
  const compilerOptions = createCompilerOptions({
    config: input.config,
    entries: prepared.materialized.entries,
    externs: prepared.externs.renameBarriers,
    manifestFile: prepared.manifestSettings.fileName,
    languageOut: input.languageOut,
    options: input.options,
    outDir: prepared.coreOutDir,
    projectRoot: input.config.root,
    publicPath: prepared.publicPath,
    srcDir: prepared.materialized.srcDir,
    typeMetadata: prepared.typeMetadata,
    typedExterns: prepared.externs.typedDeclarations,
  });
  const runtimeModuleSourceMapFilePath = path.join(
    prepared.captureRoot,
    INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
  );
  const authoredFilesFilePath = path.join(
    prepared.captureRoot,
    INTERNAL_VITE_AUTHORED_FILES_FILE,
  );
  await fs.writeFile(
    authoredFilesFilePath,
    JSON.stringify(prepared.materialized.authoredFiles, null, 2),
    "utf8",
  );
  // The runtime preamble is Closure input, but CSS rows are attached after the
  // compile, so the compiler cannot see for itself whether it will ever need
  // the `<link>` loader. This is the only place the answer exists in time.
  const buildOptions: InternalBuildOptions = {
    ...compilerOptions,
    cssRuntime: ownershipNeedsCssRuntime(prepared.cssOwnership),
    // Vite has a second output-finalization phase for hashed names, resolved
    // asset URLs, and preserved-import specifiers. Minify only after that.
    finalMinify: false,
    rollupChunks: serializeRollupChunkGraph({
      jsChunks: prepared.jsChunks,
      materialized: prepared.materialized,
    }),
  };
  const buildEnvironment: EnvironmentOverrides = {
    GCC_VITE_AUTHORED_FILES_FILE: authoredFilesFilePath,
    GCC_VITE_RUNTIME_SOURCE_MAP_FILE: runtimeModuleSourceMapFilePath,
  };
  const result = await withEnvironment(buildEnvironment, () =>
    build(buildOptions),
  );
  if (!result.ok) {
    this.error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
        "gccTsBundler() failed while compiling the captured Vite graph.",
    );
  }

  const compiledCoreOutputs = await stageCompiledCoreOutputs({
    coreOutDir: prepared.coreOutDir,
    finalOutDir: prepared.finalOutDir,
    outputFiles: result.outputFiles,
  });
  return {
    ...prepared,
    chunkOutputType: resolveViteChunkOutputType(compilerOptions),
    compiledCoreOutputs,
    manifestFilePath: path.join(
      compiledCoreOutputs.finalOutDir,
      prepared.manifestSettings.fileName,
    ),
    runtimeModuleSourceMapFilePath,
  };
}

async function emitViteGraph(
  this: PluginContext,
  input: {
    bundle: OutputBundle;
    compiled: CompiledViteGraph;
    config: ResolvedConfig;
    options: GccTsBundlerVitePluginOptions;
    outputOptions: NormalizedOutputOptions;
    timingTotals: ViteTimingTotals;
  },
) {
  const { compiled } = input;
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(compiled.manifestFilePath, "utf8"),
    compiled.manifestFilePath,
  );
  logInternalDetail(
    "vite:gcc-runtime-modules",
    `${Object.keys(manifest.modules).length}`,
  );
  const renamedNonBaseOutputs = await renameCompiledNonBaseJsOutputs({
    baseChunkName: resolveBaseChunkName(input.options),
    chunkOutputType: compiled.chunkOutputType,
    dynamicRootModuleIds: compiled.dynamicRootModuleIds,
    jsChunks: compiled.jsChunks,
    manifestFilePath: compiled.manifestFilePath,
    materialized: compiled.materialized,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles: compiled.compiledCoreOutputs.outputFiles,
    outputOptions: input.outputOptions,
    publicPath: compiled.publicPath,
    runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
  });
  if (compiled.cssOwnership.enabled) {
    await measureAsync(input.timingTotals, "cssAugmentMs", () =>
      augmentCompiledViteCss({
        baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
        manifestFilePath: compiled.manifestFilePath,
        materialized: compiled.materialized,
        ownership: compiled.cssOwnership,
        runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
      }),
    );
  }
  // Vite resolves relative asset URLs against the host chunk's shipped path.
  // Name once to establish that path, render the URLs, then hash/name again
  // over the resolved bytes so asset changes invalidate the JavaScript name.

  const preliminaryBaseOutput = await finalizeBaseJsOutputName({
    baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
    baseSeed: renamedNonBaseOutputs.baseSeed,
    chunkOutputType: compiled.chunkOutputType,
    deferredChunkSeeds: renamedNonBaseOutputs.deferredChunkSeeds,
    emittedOutputFiles: renamedNonBaseOutputs.emittedOutputFiles,
    manifestFilePath: compiled.manifestFilePath,
    outputOptions: input.outputOptions,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    publicPath: compiled.publicPath,
  });
  const resolvedAssetUrls = await resolveViteAssetUrls({
    chunkOutputType: compiled.chunkOutputType,
    config: input.config,
    jsChunks: compiled.jsChunks,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles: preliminaryBaseOutput.emittedOutputFiles,
    outputOptions: input.outputOptions,
    pluginContext: this,
  });
  let finalizedBaseOutput = preliminaryBaseOutput;
  if (resolvedAssetUrls) {
    const finalRenamedOutputs = await renameCompiledNonBaseJsOutputs({
      baseChunkName: resolveBaseChunkName(input.options),
      chunkOutputType: compiled.chunkOutputType,
      dynamicRootModuleIds: compiled.dynamicRootModuleIds,
      jsChunks: compiled.jsChunks,
      manifestFilePath: compiled.manifestFilePath,
      materialized: compiled.materialized,
      outDir: compiled.compiledCoreOutputs.finalOutDir,
      outputFiles: preliminaryBaseOutput.emittedOutputFiles,
      outputOptions: input.outputOptions,
      publicPath: compiled.publicPath,
      runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
    });
    finalizedBaseOutput = await finalizeBaseJsOutputName({
      baseChunkFilePath: finalRenamedOutputs.baseChunkFilePath,
      baseSeed: finalRenamedOutputs.baseSeed,
      chunkOutputType: compiled.chunkOutputType,
      deferredChunkSeeds: finalRenamedOutputs.deferredChunkSeeds,
      emittedOutputFiles: finalRenamedOutputs.emittedOutputFiles,
      manifestFilePath: compiled.manifestFilePath,
      outputOptions: input.outputOptions,
      outDir: compiled.compiledCoreOutputs.finalOutDir,
      publicPath: compiled.publicPath,
    });
  }

  await rewritePreservedImportSpecifiers({
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles: finalizedBaseOutput.emittedOutputFiles,
  });
  await finalizeJavaScriptOutputs({
    outputFiles: finalizedBaseOutput.emittedOutputFiles,
  });
  const emittedOutputFiles = filterInternalOutputs(
    finalizedBaseOutput.emittedOutputFiles,
    compiled,
  );
  const identityOutputs = await measureAsync(
    input.timingTotals,
    "emitOutputsMs",
    async () =>
      preserveCompiledChunkIdentities({
        bundle: input.bundle,
        jsChunks: compiled.jsChunks,
        manifest: parseGccRuntimeManifest(
          await fs.readFile(compiled.manifestFilePath, "utf8"),
          compiled.manifestFilePath,
        ),
        manifestFilePath: compiled.manifestFilePath,
        materialized: compiled.materialized,
        outDir: compiled.compiledCoreOutputs.finalOutDir,
        outputFiles: emittedOutputFiles,
        pluginContext: this,
        publicPath: compiled.publicPath,
        runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
      }),
  );
  await logOutputStats({
    bundle: input.bundle,
    emittedOutputFiles: identityOutputs.finalOutputFiles,
    finalOutDir: compiled.compiledCoreOutputs.finalOutDir,
    finalScriptFileName: identityOutputs.baseScriptFileName,
  });
}

function filterInternalOutputs(
  outputFiles: string[],
  compiled: CompiledViteGraph,
) {
  return outputFiles.filter(
    (filePath) =>
      filePath !== compiled.runtimeModuleSourceMapFilePath &&
      (!compiled.manifestSettings.isInternal ||
        filePath !== compiled.manifestFilePath),
  );
}

async function logOutputStats(input: {
  bundle: OutputBundle;
  emittedOutputFiles: string[];
  finalOutDir: string;
  finalScriptFileName: string;
}) {
  const outputBytes = await collectOutputByteBreakdown({
    bundle: input.bundle,
    emittedOutputFiles: input.emittedOutputFiles,
  });
  logInternalDetail(
    "vite:output-bytes",
    `js=${outputBytes.js} css=${outputBytes.css} fonts=${outputBytes.fonts} assets=${outputBytes.assets}`,
  );
  const finalBaseChunkFilePath = path.join(
    input.finalOutDir,
    input.finalScriptFileName,
  );
  const outputChunkStats = await collectOutputChunkStats({
    entryFilePath: finalBaseChunkFilePath,
    lazyFilePaths: input.emittedOutputFiles.filter(
      (filePath) =>
        filePath.endsWith(".js") && filePath !== finalBaseChunkFilePath,
    ),
  });
  logInternalDetail(
    "vite:output-js-chunks",
    `entry=${outputChunkStats.entryRawBytes}/${outputChunkStats.entryGzipBytes} lazy=${outputChunkStats.lazyRawBytes}/${outputChunkStats.lazyGzipBytes} factories=${outputChunkStats.entryFactoryCount}+${outputChunkStats.lazyFactoryCount}`,
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

function createBuildMetrics(): ViteBuildMetrics {
  return {
    normalizedRetainedModuleCount: 0,
    reassignedConstantDemotionCount: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    retainedEdgeResolutionCount: 0,
  };
}

function resetBuildMetrics(metrics: ViteBuildMetrics) {
  metrics.normalizedRetainedModuleCount = 0;
  metrics.reassignedConstantDemotionCount = 0;
  metrics.parseCacheHits = 0;
  metrics.parseCacheMisses = 0;
  metrics.retainedEdgeResolutionCount = 0;
}

function createTimingTotals(): ViteTimingTotals {
  return {
    cssAnalysisMs: 0,
    cssAugmentMs: 0,
    dependencyPrebundleMs: 0,
    emitOutputsMs: 0,
    externsMs: 0,
    htmlRewriteMs: 0,
    materializeMs: 0,
    normalizeRetainedMs: 0,
    retainedResolutionMs: 0,
    transformCaptureMs: 0,
    typeMetadataMs: 0,
  };
}

function measure<Result>(
  timings: ViteTimingTotals,
  key: keyof ViteTimingTotals,
  work: () => Result,
): Result {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    timings[key] += performance.now() - startedAt;
  }
}

async function measureAsync<Result>(
  timings: ViteTimingTotals,
  key: keyof ViteTimingTotals,
  work: () => Promise<Result>,
): Promise<Result> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    timings[key] += performance.now() - startedAt;
  }
}

function logViteTimings(timings: ViteTimingTotals) {
  const labels: Array<readonly [keyof ViteTimingTotals, string]> = [
    ["cssAnalysisMs", "vite:css-analysis"],
    ["cssAugmentMs", "vite:css-augment"],
    ["dependencyPrebundleMs", "vite:dependency-prebundle"],
    ["emitOutputsMs", "vite:emit-outputs"],
    ["externsMs", "vite:externs"],
    ["htmlRewriteMs", "vite:html-rewrite"],
    ["materializeMs", "vite:materialize"],
    ["normalizeRetainedMs", "vite:normalize-retained"],
    ["retainedResolutionMs", "vite:retained-resolution"],
    ["transformCaptureMs", "vite:transform-capture"],
    ["typeMetadataMs", "vite:type-metadata"],
  ];
  for (const [key, label] of labels) {
    const durationMs = timings[key];
    if (durationMs > 0) {
      logInternalTiming(label, durationMs);
    }
  }
}
