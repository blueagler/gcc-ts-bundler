import os from "os";

export function determineClosureConcurrency(
  jobCount: number,
  defaultConcurrency?: number,
) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }

  return Math.min(
    jobCount,
    defaultConcurrency ?? Math.max(1, os.availableParallelism() - 1),
  );
}
