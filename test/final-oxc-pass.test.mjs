import fs from "node:fs/promises";
import path from "node:path";

import { expect, test } from "bun:test";

import { finalizeJavaScriptOutputs } from "../src/build/closure/final-minify.ts";
import { createFixture } from "./helpers.mjs";

test("final OXC pass keeps no-DCE/no-mangle contracts and skips preserved modules", async () => {
  const fixture = await createFixture();
  const compiledPath = path.join(fixture.outDir, "entry.js");
  const preservedPath = path.join(
    fixture.outDir,
    "__gcc_preserved",
    "boundary.js",
  );
  const preservedSource = [
    'export const preservedValue = "preserved bytes";',
    "// This whitespace is part of the preserved-module boundary contract.",
    "",
  ].join("\n");
  await fs.mkdir(path.dirname(preservedPath), { recursive: true });
  await Promise.all([
    fs.writeFile(
      compiledPath,
      [
        'import { value as reinjectedValue } from "./__gcc_preserved/boundary.js";',
        "const unusedBinding = 1;",
        "const namedBinding = () => 2;",
        "const pureBinding = /* @__PURE__ */ factory();",
        "const object = { preservedProperty: reinjectedValue };",
        "console.log(object.preservedProperty, namedBinding(), pureBinding);",
        "debugger;",
        "export { object };",
        "",
      ].join("\n"),
      "utf8",
    ),
    fs.writeFile(preservedPath, preservedSource, "utf8"),
  ]);

  await finalizeJavaScriptOutputs({
    excludedOutputFiles: [preservedPath],
    outputFiles: [compiledPath, preservedPath],
  });

  const [compiled, preserved] = await Promise.all([
    fs.readFile(compiledPath, "utf8"),
    fs.readFile(preservedPath, "utf8"),
  ]);
  expect(compiled).toContain(
    'import{value as reinjectedValue}from"./__gcc_preserved/boundary.js";',
  );
  expect(compiled).toContain("unusedBinding");
  expect(compiled).toContain("namedBinding");
  expect(compiled).toContain("pureBinding=factory()");
  expect(compiled).toContain("preservedProperty");
  expect(compiled).toContain("console.log");
  expect(compiled).toContain("debugger");
  expect(preserved).toBe(preservedSource);
});
