import { expect, test } from "bun:test";

import { parseExternsCliArgs } from "../src/cli/parse-externs-options.ts";
import { parseCliArgs } from "../src/cli/parse-options.ts";

test("does not accept deprecated build flag aliases", () => {
  const parsed = parseCliArgs([
    "--project-root",
    "/tmp/demo",
    "--src_dir",
    "./src",
    "--entry_point",
    "./main.ts",
    "--output_dir",
    "./dist",
  ]);

  expect(parsed.options.projectRoot).toBe("/tmp/demo");
  expect(parsed.options.srcDir).toBeUndefined();
  expect(parsed.options.entries).toEqual([]);
  expect(parsed.options.outDir).toBeUndefined();
});

test("does not accept deprecated extern flag aliases", () => {
  const parsed = parseExternsCliArgs([
    "--project-root",
    "/tmp/demo",
    "--project_root",
    "/tmp/legacy",
    "--src_dir",
    "./src",
    "--runtime_entry",
    "./runtime.js",
    "--output_file",
    "./externs.js",
    "--package",
    "lit",
  ]);

  expect(parsed.options.projectRoot).toBe("/tmp/demo");
  expect(parsed.options.srcDir).toBeUndefined();
  expect(parsed.options.runtimeEntryFiles).toEqual([]);
  expect(parsed.options.outputFile).toBeUndefined();
  expect(parsed.options.modules).toEqual([]);
});
