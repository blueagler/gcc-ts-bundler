import { logInternalTiming } from "../../shared/timing";
import type { ViteBuildMetrics } from "../internal-types";
import type { ViteTimingTotals } from "../plugin-graph";

export function createBuildMetrics(): ViteBuildMetrics {
  return {
    deadDynamicEdgeDropCount: 0,
    normalizedRetainedModuleCount: 0,
    reassignedConstantDemotionCount: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    retainedEdgeResolutionCount: 0,
  };
}

export function resetBuildMetrics(metrics: ViteBuildMetrics) {
  metrics.deadDynamicEdgeDropCount = 0;
  metrics.normalizedRetainedModuleCount = 0;
  metrics.reassignedConstantDemotionCount = 0;
  metrics.parseCacheHits = 0;
  metrics.parseCacheMisses = 0;
  metrics.retainedEdgeResolutionCount = 0;
}

export function createTimingTotals(): ViteTimingTotals {
  return {
    cssAnalysisMs: 0,
    cssAugmentMs: 0,
    dependencyPrebundleMs: 0,
    emitOutputsMs: 0,
    externsMs: 0,
    materializeMs: 0,
    normalizeRetainedMs: 0,
    retainedResolutionMs: 0,
    transformCaptureMs: 0,
    typeMetadataMs: 0,
  };
}

export function logViteTimings(timings: ViteTimingTotals) {
  const labels: Array<readonly [keyof ViteTimingTotals, string]> = [
    ["cssAnalysisMs", "vite:css-analysis"],
    ["cssAugmentMs", "vite:css-augment"],
    ["dependencyPrebundleMs", "vite:dependency-prebundle"],
    ["emitOutputsMs", "vite:emit-outputs"],
    ["externsMs", "vite:externs"],
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
