import type { ResolvedConfig } from "vite";
import type { TransformOptions } from "rolldown/utils";

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
import {
  measureViteBaselineJs,
  resolveViteBuildReportFile,
  writeViteBuildReport,
} from "../report";
import { prepareViteWorkspace } from "../workspace";
import { resetBuildMetrics } from "./metrics";

export async function compileAndEmitViteBundle(
  this: PluginContext,
  input: {
    buildMetrics: ViteBuildMetrics;
    bundle: OutputBundle;
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    languageOut: LanguageOut | null;
    nativeDefines: TransformOptions["define"];
    options: GccTsBundlerVitePluginOptions;
    outputOptions: NormalizedOutputOptions;
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
  },
) {
  for (const id of input.capturedModules.keys()) {
    if (id.includes("?worker") || id.includes("&worker")) {
      this.error(
        "gccTsBundler() does not support worker entry graphs in Vite build mode.",
      );
    }
  }

  input.resolutionCache.clear();
  resetBuildMetrics(input.buildMetrics);
  const workspace = await prepareViteWorkspace({
    config: input.config,
    debugDir: input.options.debug?.dumpCapturedGraphDir,
    options: input.options,
    projectRoot: input.config.root,
  });
  try {
    const prepared = await prepareViteGraph.call(this, {
      buildMetrics: input.buildMetrics,
      bundle: input.bundle,
      capturedModules: input.capturedModules,
      config: input.config,
      nativeDefines: input.nativeDefines,
      options: input.options,
      resolutionCache: input.resolutionCache,
      timingTotals: input.timingTotals,
      workspace,
    });
    const reportFile = resolveViteBuildReportFile(
      input.options,
      input.config.root,
    );
    // Snapshot before compile: emit writes compiled code back into these
    // same bundle chunks, so a later measurement compares output with itself.
    const reportBaseline =
      reportFile === null ? null : measureViteBaselineJs(prepared.jsChunks);
    const compiled = await compileViteGraph.call(this, {
      config: input.config,
      languageOut: input.languageOut ?? resolveViteLanguageOut(input.config),
      options: input.options,
      prepared,
    });
    const emitted = await emitViteGraph.call(this, {
      bundle: input.bundle,
      config: input.config,
      compiled,
      options: input.options,
      outputOptions: input.outputOptions,
      timingTotals: input.timingTotals,
    });
    if (reportFile !== null && reportBaseline !== null) {
      await writeViteBuildReport({
        baseline: reportBaseline,
        capturedModules: input.capturedModules,
        externs: compiled.externs,
        finalOutputFiles: emitted.finalOutputFiles,
        materialized: compiled.materialized,
        projectRoot: input.config.root,
        reportFile,
      });
    }
  } finally {
    await workspace.dispose();
  }
}
