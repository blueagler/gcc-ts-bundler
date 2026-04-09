import os from "os";

export function determineClosureConcurrency(jobCount: number) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }

  const available = os.availableParallelism?.() ?? os.cpus().length ?? 1;
  return Math.min(jobCount, Math.max(1, available - 1));
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
) {
  if (items.length === 0) {
    return [] as R[];
  }

  const results = new Array<R>(items.length);
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= items.length) {
          return;
        }
        results[current] = await worker(items[current]);
      }
    }),
  );

  return results;
}
