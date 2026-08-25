import { performance } from "node:perf_hooks";

import {
  getCapturedModuleAnalysis,
  resolveCapturedModuleFormat,
  restoreEmptyDependencyModuleSource,
  shouldCaptureModule,
} from "../capture";
import type { CapturedModule } from "../internal-types";
import type { ViteTimingTotals } from "../plugin-graph";

export async function captureViteModule(input: {
  capturedModules: Map<string, CapturedModule>;
  code: string;
  id: string;
  timingTotals: ViteTimingTotals;
}): Promise<{ captured: boolean; workerImport: boolean }> {
  const startedAt = performance.now();
  if (!shouldCaptureModule(input.id, input.code)) {
    return { captured: false, workerImport: false };
  }
  const workerImport =
    input.id.includes("?worker") || input.id.includes("&worker");
  const capturedCode = await restoreEmptyDependencyModuleSource(
    input.id,
    input.code,
  );
  const record: CapturedModule = { code: capturedCode, id: input.id };
  record.rawAnalysis = getCapturedModuleAnalysis(record);
  record.format = await resolveCapturedModuleFormat(record);
  input.capturedModules.set(input.id, record);
  input.timingTotals.transformCaptureMs += performance.now() - startedAt;
  return { captured: true, workerImport };
}
