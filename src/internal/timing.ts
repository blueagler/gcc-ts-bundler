import { performance } from "node:perf_hooks";

const SHOW_INTERNAL_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";

export function isInternalTimingEnabled() {
  return SHOW_INTERNAL_TIMINGS;
}

export function logInternalTiming(label: string, durationMs: number) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}

export async function withInternalTiming<T>(
  label: string,
  work: () => Promise<T> | T,
): Promise<T> {
  if (!SHOW_INTERNAL_TIMINGS) {
    return await work();
  }

  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    logInternalTiming(label, performance.now() - startedAt);
  }
}
