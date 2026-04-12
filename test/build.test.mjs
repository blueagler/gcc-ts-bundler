import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture } from "./helpers.mjs";

function flattenDiagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(
    diagnostic?.messageText ?? diagnostic,
    "\n",
  );
}

test.serial("builds an ESM package from node_modules in ADVANCED mode", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport default value + 1;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}\n',
  );
  await fixture.write("node_modules/demo-pkg/browser.js", "export const value = 41;\n");
  await fixture.write("node_modules/demo-pkg/import.js", "export const value = 99;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  expect(result.outputFiles).toHaveLength(1);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/demo-pkg/);
});

test.serial("prefers production package exports over development exports by default", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport default value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    JSON.stringify({
      name: "demo-pkg",
      exports: {
        browser: {
          development: "./dev.js",
          production: "./prod.js",
          default: "./default.js",
        },
      },
    }),
  );
  await fixture.write("node_modules/demo-pkg/dev.js", 'export const value = "DEV_EXPORT";\n');
  await fixture.write("node_modules/demo-pkg/prod.js", 'export const value = "PROD_EXPORT";\n');
  await fixture.write(
    "node_modules/demo-pkg/default.js",
    'export const value = "DEFAULT_EXPORT";\n',
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).toMatch(/PROD_EXPORT/);
  expect(output).not.toMatch(/DEV_EXPORT/);
});

test.serial("builds a CommonJS package entrypoint from node_modules", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { answer } from "demo-pkg";\nexport default answer;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    [
      "exports.answer = 42;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).toMatch(/42/);
});

test.serial("rewrites namespace imports from CommonJS packages to runtime-safe interop", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import * as demo from "demo-pkg";\nexport default demo.answer;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    "exports.answer = 42;\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).toMatch(/42/);
});

test.serial("emits a shared chunk when multiple entries use the same package", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/a.ts",
    'import { shared } from "demo-pkg";\nexport const a = shared + 1;\n',
  );
  await fixture.write(
    "src/b.ts",
    'import { shared } from "demo-pkg";\nexport const b = shared + 2;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","module":"./index.js"}\n',
  );
  await fixture.write("node_modules/demo-pkg/index.js", "export const shared = 40;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./a.ts", "./b.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["a.js", "b.js", "shared.js"]);
});

test.serial("folds process.env.NODE_ENV to the production CommonJS branch", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport const result = value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.js"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.js",
    [
      'if (process.env.NODE_ENV === "production") {',
      '  module.exports = require("./prod.cjs");',
      "} else {",
      '  module.exports = require("./dev.cjs");',
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/demo-pkg/prod.cjs",
    'exports.value = "PROD_BRANCH";\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/dev.cjs",
    'exports.value = "DEV_BRANCH";\n',
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).toMatch(/PROD_BRANCH/);
  expect(output).not.toMatch(/DEV_BRANCH/);
  expect(output).not.toMatch(/\.cjs/);
});

test.serial("full preflight accepts JS dependencies from node_modules", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport const answer = value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","module":"./index.js"}\n',
  );
  await fixture.write("node_modules/demo-pkg/index.js", "export const value = 7;\n");

  const result = await build({
    cache: { mode: "off" },
    diagnostics: { preflight: "full" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
});

test.serial("full preflight surfaces authored TypeScript semantic diagnostics", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      'const label: number = "bad";',
      "export default label;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    diagnostics: { preflight: "full" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.emitSkipped).toBe(true);
  expect(
    result.diagnostics.some((diagnostic) =>
      flattenDiagnosticText(diagnostic).includes(
        "Type 'string' is not assignable to type 'number'",
      ),
    ),
  ).toBe(true);
});

test.serial("errors-only preflight surfaces authored TypeScript errors", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      'const label: number = "bad";',
      "export default label;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    diagnostics: { preflight: "errors-only" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.emitSkipped).toBe(true);
  expect(
    result.diagnostics.some((diagnostic) =>
      flattenDiagnosticText(diagnostic).includes(
        "Type 'string' is not assignable to type 'number'",
      ),
    ),
  ).toBe(true);
});

test.serial("persistent cache restores published outputs after the outDir is removed", async () => {
  const fixture = await createFixture();
  const cacheDir = path.join(fixture.projectRoot, ".cache");
  await fixture.write(
    "src/index.ts",
    'export const value = "CACHE_HIT";\n',
  );

  const firstResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(firstResult.exitCode).toBe(0);
  expect(firstResult.cacheHit).toBe(false);

  await fs.rm(fixture.outDir, { force: true, recursive: true });

  const secondResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(secondResult.exitCode).toBe(0);
  expect(secondResult.cacheHit).toBe(true);
  expect(await fixture.read("dist/index.js")).toMatch(/CACHE_HIT/);
});

test.serial("builds mixed ESM and CommonJS package graphs", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { result } from "demo-pkg";\nexport default result;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    [
      'const dep = require("./dep.js");',
      "exports.result = dep.value + 1;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/demo-pkg/dep.js",
    "export const value = 4;\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/require\(/);
  expect(output).not.toMatch(/module\.exports/);
});

test.serial("builds decorated TypeScript sources", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/decorators.ts",
    [
      "export function increment(_value: unknown, _context: ClassAccessorDecoratorContext) {",
      "  return {",
      "    init(value: number) {",
      "      return value + 1;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/index.ts",
    [
      'import { increment } from "./decorators.js";',
      "",
      "class Counter {",
      "  @increment accessor value = 1;",
      "}",
      "",
      "export const total = new Counter().value;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/@increment/);

  const builtModule = await import(
    `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?decorated=${Date.now()}`
  );
  expect(builtModule.total).toBe(2);
});

test.serial("exported entry bundles do not retain GCC wrapper exports", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      "export class MotionHero {",
      "  static tag = 'motion-hero';",
      "}",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).toMatch(/export/);
  expect(output).not.toMatch(/globalThis\.GCC/);
  expect(output).not.toMatch(/__gcc_export_/);
});

test.serial("unsupported CommonJS packages surface actionable diagnostics", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import value from "demo-pkg";\nexport default value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    "module.exports = require(name);\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(result.emitSkipped).toBe(true);
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(String(result.diagnostics[0].messageText)).toMatch(
    /Unsupported CommonJS/,
  );
});
