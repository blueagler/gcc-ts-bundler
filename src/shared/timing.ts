import { performance } from "node:perf_hooks";

const SHOW_INTERNAL_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";

export function logInternalTiming(label: string, durationMs: number) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}

export function logInternalDetail(label: string, detail: string) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }

  console.error(`[gcc-ts-bundler timing] ${label}: ${detail}`);
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
