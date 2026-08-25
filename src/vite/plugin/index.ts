import type { Plugin, ResolvedConfig, UserConfig } from "vite";

import type { LanguageOut } from "../../api/types";
import type { CapturedModuleResolutionCache } from "../capture";
import {
  applyViteBuildGuards,
  assertNoViteLanguageOut,
  resolveViteLanguageOutTarget,
} from "../config";
import type { CapturedModule } from "../internal-types";
import type { GccTsBundlerVitePluginOptions } from "../types";
import { captureViteModule } from "./capture";
import { compileAndEmitViteBundle } from "./compile";
import {
  createBuildMetrics,
  createTimingTotals,
  logViteTimings,
} from "./metrics";

interface GccTsBundlerPlugin {
  name: string;
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
      const result = await captureViteModule({
        capturedModules,
        code,
        id,
        timingTotals,
      });
      workerImportDetected ||= result.workerImport;
      return null;
    },
    async generateBundle(outputOptions, bundle) {
      if (!resolvedConfig) {
        throw new Error("gccTsBundler() did not receive resolved Vite config.");
      }
      await compileAndEmitViteBundle.call(this, {
        buildMetrics,
        bundle,
        capturedModules,
        config: resolvedConfig,
        languageOut: requestedLanguageOut,
        options,
        outputOptions,
        resolutionCache,
        timingTotals,
        workerImportDetected,
      });
      logViteTimings(timingTotals);
    },
  };
  return plugin;
}
