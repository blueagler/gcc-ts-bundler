import type { ResolvedConfig } from "vite";

import type { LanguageOut } from "../../api/types";
import type { CapturedModuleResolutionCache } from "../capture";
import { resolveViteLanguageOut } from "../config";
import type {
  CapturedModule,
  NormalizedOutputOptions,
  OutputBundle,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";
import {
  compileViteGraph,
  emitViteGraph,
  prepareViteGraph,
  type ViteTimingTotals,
} from "../plugin-graph";
import type { GccTsBundlerVitePluginOptions } from "../types";
import { resetBuildMetrics } from "./metrics";

export async function compileAndEmitViteBundle(
  this: PluginContext,
  input: {
    buildMetrics: ViteBuildMetrics;
    bundle: OutputBundle;
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    languageOut: LanguageOut | null;
    options: GccTsBundlerVitePluginOptions;
    outputOptions: NormalizedOutputOptions;
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
    workerImportDetected: boolean;
  },
) {
  if (input.workerImportDetected) {
    this.error(
      "gccTsBundler() does not support worker entry graphs in Vite build mode.",
    );
  }

  input.resolutionCache.clear();
  resetBuildMetrics(input.buildMetrics);
  const prepared = await prepareViteGraph.call(this, {
    buildMetrics: input.buildMetrics,
    bundle: input.bundle,
    capturedModules: input.capturedModules,
    config: input.config,
    options: input.options,
    resolutionCache: input.resolutionCache,
    timingTotals: input.timingTotals,
  });
  const compiled = await compileViteGraph.call(this, {
    config: input.config,
    languageOut: input.languageOut ?? resolveViteLanguageOut(input.config),
    options: input.options,
    prepared,
  });
  await emitViteGraph.call(this, {
    bundle: input.bundle,
    config: input.config,
    compiled,
    options: input.options,
    outputOptions: input.outputOptions,
    timingTotals: input.timingTotals,
  });
}
