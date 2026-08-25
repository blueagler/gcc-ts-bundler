import type {
  CapturedModule,
  CapturedModuleAnalysis,
  ViteBuildMetrics,
} from "../internal-types";
import { analyzeModuleCode } from "./code";

export { analyzeModuleCode, resolveScriptKind } from "./code";
export { resolveCapturedModuleFormat } from "./format";

export function getCapturedModuleAnalysis(
  record: CapturedModule,
  metrics?: ViteBuildMetrics,
  mode: "raw" | "normalized" = "raw",
): CapturedModuleAnalysis {
  const existingAnalysis =
    mode === "normalized" ? record.normalizedAnalysis : record.rawAnalysis;
  if (existingAnalysis) {
    if (metrics) {
      metrics.parseCacheHits += 1;
    }
    return existingAnalysis;
  }
  if (mode === "normalized" && record.normalizedCode === undefined) {
    return getCapturedModuleAnalysis(record, metrics, "raw");
  }
  if (
    mode === "normalized" &&
    record.normalizedCode !== undefined &&
    record.normalizedCode === record.code &&
    record.rawAnalysis
  ) {
    if (metrics) {
      metrics.parseCacheHits += 1;
    }
    record.normalizedAnalysis = record.rawAnalysis;
    return record.normalizedAnalysis;
  }

  if (metrics) {
    metrics.parseCacheMisses += 1;
  }

  const analysis = analyzeModuleCode(
    record.id,
    mode === "normalized"
      ? (record.normalizedCode ?? record.code)
      : record.code,
  );
  if (mode === "normalized") {
    record.normalizedAnalysis = analysis;
  } else {
    record.rawAnalysis = analysis;
  }
  return analysis;
}
