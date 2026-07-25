import { expect, test } from "bun:test";

import { parseExternsCliArgs } from "../src/cli/parse-externs-options.ts";
import { parseCliArgs } from "../src/cli/parse-options.ts";

test("rejects deprecated build flag aliases", () => {
  expect(() =>
    parseCliArgs(["--project-root", "/tmp/demo", "--src_dir", "./src"]),
  ).toThrow(/Unknown option/);
});

test("rejects deprecated extern flag aliases", () => {
  expect(() =>
    parseExternsCliArgs([
      "--project-root",
      "/tmp/demo",
      "--runtime_entry",
      "./runtime.js",
    ]),
  ).toThrow(/Unknown option/);
});

test("parses repeated typed build options", () => {
  const parsed = parseCliArgs([
    "--entry",
    "./main.ts",
    "--entry",
    "./worker.ts",
    "--extern",
    "./browser.externs.js",
    "--cache-mode",
    "temp",
  ]);

  expect(parsed.options.entries).toEqual(["./main.ts", "./worker.ts"]);
  expect(parsed.options.externs).toEqual(["./browser.externs.js"]);
  expect(parsed.options.cache?.mode).toBe("temp");
  expect(parsed.options.packages).toBeUndefined();
});

test("rejects invalid option values during parsing", () => {
  expect(() =>
    parseCliArgs(["--entry", "./main.ts", "--cache-mode", "forever"]),
  ).toThrow(/--cache-mode must be one of/);
});
