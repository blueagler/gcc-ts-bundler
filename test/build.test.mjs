import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "bun:test";

import { build } from "../dist/index.mjs";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-ts-bundler-test-"));
  onTestFinished(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    outDir: path.join(root, "dist"),
    projectRoot: root,
    srcDir: path.join(root, "src"),
    async read(relativePath) {
      return fs.readFile(path.join(root, relativePath), "utf8");
    },
    async write(relativePath, contents) {
      const filePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    },
  };
}

test("builds an ESM package from node_modules in ADVANCED mode", async () => {
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

test("builds a CommonJS package entrypoint from node_modules", async () => {
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

test("rewrites namespace imports from CommonJS packages to runtime-safe interop", async () => {
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

test("emits a shared chunk when multiple entries use the same package", async () => {
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

test("folds process.env.NODE_ENV to the production CommonJS branch", async () => {
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

test("full preflight accepts JS dependencies from node_modules", async () => {
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

test("persistent cache restores published outputs after the outDir is removed", async () => {
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

test("builds mixed ESM and CommonJS package graphs", async () => {
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

test("builds decorated TypeScript sources", async () => {
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
});

test("exported entry bundles do not retain GCC wrapper exports", async () => {
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

test("unsupported CommonJS packages surface actionable diagnostics", async () => {
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

test("emits smaller Closure script chunks for explicit lazy modules", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'const loadFeature = () => import("./feature");',
      "globalThis.__lazyLoader = loadFeature;",
      'document.body.textContent = "base";',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.ts",
    [
      'export const marker = "LAZY_FEATURE";',
      "export function render() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "closure-library" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["main.js", "src-feature-lazy.js"]);

  const baseOutput = await fixture.read("dist/main.js");
  const lazyOutput = await fixture.read("dist/src-feature-lazy.js");

  expect(baseOutput).not.toMatch(/\bexport\s*\{/);
  expect(baseOutput).not.toMatch(/globalThis\.__gccChunkRuntime/);
  expect(baseOutput).not.toMatch(/gcc\.src\.feature/);
  expect(baseOutput).not.toMatch(/LAZY_FEATURE/);
  expect(lazyOutput).toMatch(/LAZY_FEATURE/);
});

test("emits an optional chunk manifest when requested", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'const loadFeature = () => import("./feature");',
      "globalThis.__lazyLoader = loadFeature;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.ts",
    'export const marker = "LAZY_FEATURE";\n',
  );

  const result = await build({
    cache: { mode: "off" },
    chunks: { manifestFile: "chunk-map.json", mode: "closure-library" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["chunk-map.json", "main.js", "src-feature-lazy.js"]);

  const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
  expect(manifest.baseChunkName).toBe("main");
  expect(manifest.lazyModules["gcc.src.feature"]).toBe("src-feature-lazy");
});

test("rejects non-literal dynamic import specifiers", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'const target = "./feature";',
      "void import(target);",
      "",
    ].join("\n"),
  );
  await fixture.write("src/feature.ts", "export const value = 1;\n");

  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "closure-library" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(String(result.diagnostics[0]?.messageText ?? "")).toMatch(
    /import\(\) requires a string literal module specifier/,
  );
});
