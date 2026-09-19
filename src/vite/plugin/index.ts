import type { Plugin, ResolvedConfig, UserConfig } from "vite";
import type { TransformOptions } from "rolldown/utils";

import type { LanguageOut } from "../../api/types";
import type { CapturedModuleResolutionCache } from "../capture";
import { resolveCapturedModuleFormat } from "../capture";
import {
  applyViteBuildGuards,
  assertNoViteLanguageOut,
  resolveViteLanguageOutTarget,
} from "../config";
import type { CapturedModule, CapturedModuleFormat } from "../internal-types";
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
  let timingTotals = createTimingTotals();
  let requestedLanguageOut: LanguageOut | null = null;
  let resolvedConfig: ResolvedConfig | null = null;
  let nativeDefines: TransformOptions["define"];

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
    options: {
      order: "post",
      handler(hostOptions) {
        // Vite installs environment-specific defines in its options hook,
        // after configResolved and before our captured code is materialized.
        nativeDefines = hostOptions["transform"]?.["define"];
      },
    },
    buildStart() {
      timingTotals = createTimingTotals();
    },
    async transform(code, id) {
      await captureViteModule({
        capturedModules,
        code,
        id,
        timingTotals,
      });
      return null;
    },
    async generateBundle(outputOptions, bundle) {
      if (!resolvedConfig) {
        throw new Error("gccTsBundler() did not receive resolved Vite config.");
      }
      // Rollup may reuse a transform without calling us again in watch mode.
      // Keep that capture, but never carry rendered-output evidence or shaking
      // mutations from one output into another.
      const currentModuleIds = new Set(this.getModuleIds());
      const outputModules = new Map<string, CapturedModule>();
      const packageFormats = new Map<string, Promise<CapturedModuleFormat>>();
      for (const [id, record] of capturedModules) {
        if (!currentModuleIds.has(id)) {
          // Parsed source lives on the capture record. Dropping the module
          // bounds that memo to this plugin instance's current graph.
          capturedModules.delete(id);
          continue;
        }
        outputModules.set(id, {
          ...record,
          // Package metadata belongs to this output invocation, even when
          // Rollup reuses transformed source from an earlier watch build.
          format: await resolveCapturedModuleFormat(record, packageFormats),
        });
      }
      const outputTimings = createTimingTotals();
      outputTimings.transformCaptureMs = timingTotals.transformCaptureMs;
      await compileAndEmitViteBundle.call(this, {
        buildMetrics,
        bundle,
        capturedModules: outputModules,
        config: resolvedConfig,
        languageOut: requestedLanguageOut,
        nativeDefines,
        options,
        outputOptions,
        resolutionCache,
        timingTotals: outputTimings,
      });
      logViteTimings(outputTimings);
    },
  };
  return plugin;
}
