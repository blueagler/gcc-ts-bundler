import { performance } from "node:perf_hooks";

import type { ViteTimingTotals } from "../plugin-graph";

export function measure<Result>(
  timings: ViteTimingTotals,
  key: keyof ViteTimingTotals,
  work: () => Result,
): Result {
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    timings[key] += performance.now() - startedAt;
  }
}

export async function measureAsync<Result>(
  timings: ViteTimingTotals,
  key: keyof ViteTimingTotals,
  work: () => Promise<Result>,
): Promise<Result> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    timings[key] += performance.now() - startedAt;
  }
}
