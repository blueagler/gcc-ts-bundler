import { normalizeRetainedCapturedModules } from "../capture";
import type { CapturedModuleResolutionCache } from "../capture";
import { resolveNormalizedBridgeModuleIds } from "../graph";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";
import { measureAsync } from "../plugin-compile";
import type { ViteTimingTotals } from "./index";

export async function normalizeCapturedGraph(
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
