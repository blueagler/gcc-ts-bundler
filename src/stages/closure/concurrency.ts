import os from "os";

export function determineClosureConcurrency(jobCount: number) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }

  return Math.min(jobCount, Math.max(1, os.availableParallelism() - 1));
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = items.entries();
  const results = new Map<number, { value: R }>();

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (;;) {
        const next = queue.next();
        if (next.done) {
          return;
        }
        const [index, item] = next.value;
        results.set(index, { value: await worker(item) });
      }
    }),
  );

  return items.map((_, index) => {
    const result = results.get(index);
    if (result === undefined) {
      throw new Error(`Missing concurrent result at index ${index}.`);
    }
    return result.value;
  });
}
