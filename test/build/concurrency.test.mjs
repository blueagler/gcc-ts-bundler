import { setImmediate } from "node:timers/promises";
import { expect, test } from "bun:test";

import { runWithConcurrency } from "../../src/shared/concurrency.ts";

for (const failure of [new Error("first failure"), undefined]) {
  test(`stops admission and drains siblings before rejecting ${failure === undefined ? "undefined" : "an error"}`, async () => {
    const release = Promise.withResolvers();
    const started = [];
    let siblingFinished = false;
    let settled = false;
    const result = runWithConcurrency([0, 1, 2], 2, async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await release.promise;
      siblingFinished = true;
      if (failure === undefined) throw new Error("later sibling failure");
      return item;
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    ).finally(() => { settled = true; });
    try {
      await setImmediate();
      expect(started).toEqual([0, 1]);
      expect(settled).toBe(false);
      expect(siblingFinished).toBe(false);
    } finally {
      release.resolve();
    }
    const outcome = await result;
    expect(siblingFinished).toBe(true);
    expect(started).toEqual([0, 1]);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(failure);
  });
}

test("returns input order even when active jobs finish in reverse order", async () => {
  const first = Promise.withResolvers();
  const secondFinished = Promise.withResolvers();
  const result = runWithConcurrency([0, 1, 2], 2, async (item) => {
    if (item === 0) await first.promise;
    if (item === 1) secondFinished.resolve();
    return item === 1 ? undefined : `result-${item}`;
  });
  await secondFinished.promise;
  first.resolve();
  expect(await result).toEqual(["result-0", undefined, "result-2"]);
});
