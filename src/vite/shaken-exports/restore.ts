import type { CapturedModule } from "../internal-types";

/**
 * Restores the transform output every module was captured with.
 *
 * Shaking rewrites the record in place, and a watch rebuild re-runs `transform`
 * only for the modules that changed. Without this, the second build would shake
 * an already-shaken barrel and could never bring a name back.
 */
export function restoreCapturedModuleCode(
  capturedModules: Map<string, CapturedModule>,
) {
  for (const record of capturedModules.values()) {
    if (record.capturedCode === undefined) {
      continue;
    }
    record.code = record.capturedCode;
    delete record.capturedCode;
    delete record.rawAnalysis;
    delete record.normalizedAnalysis;
    delete record.normalizedCode;
  }
}
