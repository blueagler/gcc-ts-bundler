import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { build, DEFAULT_BUILD_OPTIONS } from "../../dist/index.mjs";
import { createFixture, execFileAsync } from "../helpers.mjs";

test.serial("spreading public defaults publishes the same behavior as omitting them", { timeout: 60_000 }, async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", 'console.log(6 * 7);\n');
  const request = {
    cache: { dir: path.join(fixture.projectRoot, "cache") },
    entries: ["./index.ts"],
    projectRoot: fixture.projectRoot,
  };
  const omitted = await build(request);
  expect(omitted.ok).toBe(true);
  expect(omitted.outputFiles).toEqual([path.join(fixture.outDir, "index.js")]);
  const firstExecution = await execFileAsync(process.execPath, omitted.outputFiles);
  expect(firstExecution.stdout.trim()).toBe("42");

  await fs.rm(fixture.outDir, { recursive: true });
  const spread = await build({ ...DEFAULT_BUILD_OPTIONS, ...request });
  expect(spread.ok).toBe(true);
  expect(spread.outputFiles).toEqual(omitted.outputFiles);
  const secondExecution = await execFileAsync(process.execPath, spread.outputFiles);
  expect(secondExecution.stdout).toBe(firstExecution.stdout);
});

test("invalid build options resolve to a diagnostic failure instead of rejecting", async () => {
  const fixture = await createFixture();
  const result = await build({
    cache: { mode: "forever" },
    entries: ["./index.ts"],
    projectRoot: fixture.projectRoot,
  });
  expect(result.ok).toBe(false);
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ message: expect.stringContaining("cache.mode") }),
  ]);
});
