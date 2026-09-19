/** Stop admitting work after the first failure, then drain every active worker. */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = items.entries();
  const results = new Array<R>(items.length);
  let failed = false;
  let failure: unknown;
  const lanes = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency) || 1),
  );
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (!failed) {
        const next = queue.next();
        if (next.done) return;
        const [index, item] = next.value;
        try {
          results[index] = await worker(item);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
