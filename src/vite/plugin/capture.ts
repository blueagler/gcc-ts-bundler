import { performance } from "node:perf_hooks";

import {
  getCapturedModuleAnalysis,
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
}): Promise<void> {
  const startedAt = performance.now();
  if (!shouldCaptureModule(input.id, input.code)) {
    return;
  }
  const capturedCode = await restoreEmptyDependencyModuleSource(
    input.id,
    input.code,
  );
  const record = input.capturedModules.get(input.id) ?? {
    code: capturedCode,
    id: input.id,
  };
  if (record.code !== capturedCode) {
    record.code = capturedCode;
    delete record.capturedCode;
    delete record.normalizedAnalysis;
    delete record.normalizedCode;
    delete record.parsedSource;
    delete record.rawAnalysis;
  }
  record.rawAnalysis = getCapturedModuleAnalysis(record);
  input.capturedModules.set(input.id, record);
  input.timingTotals.transformCaptureMs += performance.now() - startedAt;
}
