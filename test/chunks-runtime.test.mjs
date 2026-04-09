import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import {
  createFixture,
  getProjectCacheDir,
  listDirectoryNames,
} from "./helpers.mjs";

test.serial("emits smaller script chunks for explicit lazy modules", async () => {
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
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const outputBasenames = result.outputFiles
    .map((filePath) => path.basename(filePath))
    .sort((left, right) => left.localeCompare(right));
  expect(outputBasenames).toHaveLength(2);
  expect(outputBasenames).toContain("main.js");
  const lazyOutputName = outputBasenames.find((name) => name !== "main.js");
  expect(lazyOutputName).toMatch(/^c[0-9a-f]{8}\.js$/);

  const baseOutput = await fixture.read("dist/main.js");
  const lazyOutput = await fixture.read(`dist/${lazyOutputName}`);

  expect(baseOutput).not.toMatch(/\bexport\s*\{/);
  expect(baseOutput).not.toMatch(/globalThis\.__gccChunkRuntime/);
  expect(baseOutput).not.toContain("__gcc_runtime__");
  expect(baseOutput).not.toContain("initialized");
  expect(baseOutput).not.toContain("gcc.src.feature");
  expect(baseOutput).toMatch(/m[0-9a-f]{8}/);
  expect(baseOutput).not.toMatch(/LAZY_FEATURE/);
  expect(lazyOutput).toMatch(/LAZY_FEATURE/);
});

test.serial("emits bundler-runtime chunks for explicit lazy modules", async () => {
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
      "export function renderMessage() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const outputBasenames = result.outputFiles
    .map((filePath) => path.basename(filePath))
    .sort((left, right) => left.localeCompare(right));
  expect(outputBasenames).toHaveLength(2);
  expect(outputBasenames).toContain("main.js");
  const lazyOutputName = outputBasenames.find((name) => name !== "main.js");
  expect(lazyOutputName).toMatch(/^c[0-9a-f]{8}\.js$/);

  const baseOutput = await fixture.read("dist/main.js");
  const lazyOutput = await fixture.read(`dist/${lazyOutputName}`);

  expect(baseOutput).not.toContain("__gcc_runtime__");
  expect(baseOutput).not.toContain("initialized");
  expect(baseOutput).not.toContain("gcc.src.feature");
  expect(baseOutput).not.toContain("sourceURL");
  expect(baseOutput).not.toContain("unknown module");
  expect(baseOutput).not.toContain("unknown chunk");
  expect(baseOutput).toMatch(/m[0-9a-f]{8}/);
  expect(baseOutput).not.toMatch(/goog\.module/);
  expect(baseOutput).not.toMatch(/ModuleManager/);
  expect(baseOutput).not.toContain('Object.defineProperty(d,"default"');
  expect(lazyOutput).not.toContain("__gcc_runtime__");
  expect(lazyOutput).not.toContain("gcc.src.feature");
  expect(lazyOutput).not.toContain("base chunk missing");
  expect(lazyOutput).toMatch(/m[0-9a-f]{8}/);
  expect(lazyOutput).not.toContain("renderMessage");
  expect(lazyOutput).toMatch(/\[[0-9]+\]=function/);
  expect(lazyOutput).not.toContain('["default"]');
  expect(lazyOutput).not.toMatch(/goog\.module/);
});

test.serial("bundler-runtime rejects reflective namespace operations", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'import * as feature from "./feature";',
      "void Object.keys(feature);",
      "",
    ].join("\n"),
  );
  await fixture.write("src/feature.ts", 'export const marker = "x";\n');

  const result = await build({
    cache: { mode: "off" },
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(String(result.diagnostics[0]?.messageText ?? "")).toMatch(
    /reflective Object\.\* operations on module namespace values/,
  );
});

test.serial("bundler-runtime caches one combined Closure job when one lazy chunk changes", async () => {
  const fixture = await createFixture();
  const cacheDir = path.join(fixture.projectRoot, ".cache");
  await fixture.write(
    "src/main.ts",
    [
      'const loadFeature = () => import("./feature");',
      'document.body.textContent = "base";',
      "void loadFeature;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.ts",
    [
      'export const marker = "FIRST";',
      "export function renderMessage() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );

  const firstResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(firstResult.exitCode).toBe(0);

  const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
  const closureJobCacheDir = path.join(projectCacheDir, "closure-jobs");
  const firstJobKeys = await listDirectoryNames(closureJobCacheDir);
  expect(firstJobKeys.length).toBe(1);

  await fixture.write(
    "src/feature.ts",
    [
      'export const marker = "SECOND";',
      "export function renderMessage() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );

  const secondResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(secondResult.exitCode).toBe(0);

  const secondJobKeys = await listDirectoryNames(closureJobCacheDir);
  expect(secondJobKeys.length).toBe(2);
});

test.serial("parallel bundler-runtime Closure execution is byte-equivalent to serial execution", async () => {
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
      "export function renderMessage() {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );

  const serialOutDir = path.join(fixture.projectRoot, "dist-serial");
  const parallelOutDir = path.join(fixture.projectRoot, "dist-parallel");
  const previousConcurrency = process.env.GCC_CLOSURE_CONCURRENCY;

  process.env.GCC_CLOSURE_CONCURRENCY = "1";
  try {
    const serialResult = await build({
      cache: { mode: "off" },
      chunks: { loader: "script", mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: serialOutDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(serialResult.exitCode).toBe(0);
  } finally {
    if (previousConcurrency === undefined) {
      delete process.env.GCC_CLOSURE_CONCURRENCY;
    } else {
      process.env.GCC_CLOSURE_CONCURRENCY = previousConcurrency;
    }
  }

  const parallelResult = await build({
    cache: { mode: "off" },
    chunks: { loader: "script", mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: parallelOutDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(parallelResult.exitCode).toBe(0);

  const serialFiles = (await fs.readdir(serialOutDir)).sort();
  const parallelFiles = (await fs.readdir(parallelOutDir)).sort();
  expect(parallelFiles).toEqual(serialFiles);
  await Promise.all(
    serialFiles.map(async (fileName) => {
      const [serialContents, parallelContents] = await Promise.all([
        fs.readFile(path.join(serialOutDir, fileName), "utf8"),
        fs.readFile(path.join(parallelOutDir, fileName), "utf8"),
      ]);
      expect(parallelContents).toBe(serialContents);
    }),
  );
});

test.serial("emits an optional chunk manifest when requested", async () => {
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
    chunks: {
      loader: "script",
      manifestFile: "chunk-map.json",
      mode: "bundler-runtime",
    },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const outputBasenames = result.outputFiles
    .map((filePath) => path.basename(filePath))
    .sort((left, right) => left.localeCompare(right));
  expect(outputBasenames).toHaveLength(3);
  expect(outputBasenames).toContain("chunk-map.json");
  expect(outputBasenames).toContain("main.js");
  expect(outputBasenames.some((name) => /^c[0-9a-f]{8}\.js$/.test(name))).toBe(true);

  const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
  expect(manifest.baseChunk).toMatch(/^c[0-9a-f]{8}$/);
  const moduleEntries = Object.entries(manifest.modules);
  expect(moduleEntries).toHaveLength(2);
  expect(moduleEntries.every(([moduleId, chunkId]) =>
    /^m[0-9a-f]{8}$/.test(moduleId) && /^c[0-9a-f]{8}$/.test(chunkId),
  )).toBe(true);
});

test.serial("emits a bundler-runtime chunk manifest when requested", async () => {
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
    chunks: {
      loader: "script",
      manifestFile: "chunk-map.json",
      mode: "bundler-runtime",
    },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
  expect(manifest.baseChunk).toMatch(/^c[0-9a-f]{8}$/);
  const chunkEntries = Object.entries(manifest.chunks);
  expect(chunkEntries).toHaveLength(2);
  expect(chunkEntries.every(([chunkId, chunkValue]) =>
    /^c[0-9a-f]{8}$/.test(chunkId) &&
    Array.isArray(chunkValue.deps) &&
    Array.isArray(chunkValue.modules) &&
    chunkValue.modules.every((moduleId) => /^m[0-9a-f]{8}$/.test(moduleId)),
  )).toBe(true);
});

test.serial("rejects non-literal dynamic import specifiers", async () => {
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
    chunks: { loader: "script", mode: "bundler-runtime" },
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

test.serial("rejects dynamic import when chunk mode is off", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'const loadFeature = () => import("./feature");',
      "void loadFeature;",
      "",
    ].join("\n"),
  );
  await fixture.write("src/feature.ts", "export const value = 1;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(String(result.diagnostics[0]?.messageText ?? "")).toMatch(
    /chunks\.mode = "bundler-runtime"/,
  );
});

test.serial("rejects the removed runtime helper API", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'import { lazyModule } from "gcc-ts-bundler/runtime";',
      'const loadFeature = lazyModule("./feature");',
      "void loadFeature;",
      "",
    ].join("\n"),
  );
  await fixture.write("src/feature.ts", "export const value = 1;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(1);
  expect(String(result.diagnostics[0]?.messageText ?? "")).toMatch(
    /gcc-ts-bundler\/runtime|Cannot find module|Failed to resolve package/,
  );
});
