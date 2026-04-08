import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, onTestFinished, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
import { parseExternsCliArgs } from "../src/cli/parse-externs-options.ts";
import { parseCliArgs } from "../src/cli/parse-options.ts";

const execFileAsync = promisify(execFile);

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

async function createExternFixture() {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      'import { Controller, RouterLike } from "contract-pkg";',
      "",
      "class Host {",
      "  updateComplete = Promise.resolve(true);",
      "  readonly controller = new Controller(this);",
      '  readonly router = new RouterLike(this, { attribute: "demo", reflect: true });',
      "  addController(_controller: unknown) {}",
      "  removeController(_controller: unknown) {}",
      "  requestUpdate() {}",
      "  click() {",
      "    if (this.controller.isAnimating) {",
      "      this.controller.togglePlay();",
      "    }",
      '    return this.router.link("/home");',
      "  }",
      "}",
      "",
      "new Host().click();",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/base-host/package.json",
    JSON.stringify(
      {
        name: "base-host",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/base-host/index.d.ts",
    [
      "export interface BaseHost {",
      "  addController(controller: unknown): void;",
      "  removeController(controller: unknown): void;",
      "  requestUpdate(): void;",
      "  readonly updateComplete: Promise<boolean>;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/contract-pkg/package.json",
    JSON.stringify(
      {
        exports: {
          ".": "./index.js",
          "./decorators.js": "./decorators.js",
        },
        name: "contract-pkg",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/contract-pkg/index.js",
    [
      "export class RouterLike {",
      "  constructor(host, options) {",
      "    this.host = host;",
      "    this.options = options;",
      "  }",
      "  link(pathname) {",
      "    return pathname ?? \"/\";",
      "  }",
      "  hostConnected() {}",
      "  hostDisconnected() {}",
      "}",
      "",
      "export class Controller {",
      "  constructor(host) {",
      "    this.host = host;",
      "    this.isAnimating = false;",
      "  }",
      "  togglePlay() {",
      "    this.isAnimating = !this.isAnimating;",
      "  }",
      "  hostConnected() {}",
      "  hostDisconnected() {}",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/contract-pkg/index.d.ts",
    [
      'import type { BaseHost } from "base-host";',
      "export interface ReactiveControllerLike {",
      "  hostConnected(): void;",
      "  hostDisconnected(): void;",
      "}",
      "export interface PropertyOptions {",
      "  attribute?: boolean | string;",
      "  reflect?: boolean;",
      "}",
      "export declare class RouterLike implements ReactiveControllerLike {",
      "  constructor(host: BaseHost, options?: PropertyOptions);",
      "  link(pathname?: string): string;",
      "}",
      "export declare class Controller {",
      "  constructor(host: BaseHost);",
      "  pause(): void;",
      "  play(): void;",
      "  togglePlay(): void;",
      "  get isAnimating(): boolean;",
      "  hostConnected(): void;",
      "  hostDisconnected(): void;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write("node_modules/contract-pkg/decorators.js", "export {};\n");
  await fixture.write(
    "node_modules/contract-pkg/decorators.d.ts",
    [
      "export declare function customElement(tagName: string): ClassDecorator;",
      "export interface PropertyOptions {",
      "  attribute?: boolean | string;",
      "  reflect?: boolean;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

async function createRuntimeExternFixture() {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      'import { Counter } from "runtime-pkg";',
      "const counter = new Counter();",
      'export const first = counter.bump("demo");',
      'export const second = counter.bump("demo");',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/runtime-pkg/package.json",
    JSON.stringify(
      {
        name: "runtime-pkg",
        module: "./index.js",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/runtime-pkg/index.js",
    [
      "const __defProp = Object.defineProperty;",
      "const __defNormalProp = (obj, key, value) =>",
      "  key in obj",
      "    ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value })",
      "    : (obj[key] = value);",
      "const __publicField = (obj, key, value) =>",
      '  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);',
      "",
      "const node = { addEventListener() {} };",
      'node.addEventListener("click", () => {});',
      "(function invoke(fn) {",
      "  return fn.apply(null, []);",
      "})(() => 1);",
      "const list = [1, 2, 3];",
      "void list.length;",
      "",
      "export class Counter {",
      "  constructor() {",
      '    __publicField(this, "counts", new Map());',
      '    Object.defineProperty(this, "label", {',
      '      value: "demo",',
      "      enumerable: true,",
      "      configurable: true,",
      "      writable: true,",
      "    });",
      "  }",
      "  bump(key) {",
      "    const next = (this.counts.get(key) ?? 0) + 1;",
      "    this.counts.set(key, next);",
      '    return `${this.label}:${next}`;',
      "  }",
      "}",
      'Object.defineProperty(Counter.prototype, "reset", {',
      "  value: function () {",
      "    this.counts.clear();",
      "  },",
      "});",
      'Object.defineProperty(Counter, "from", {',
      "  value: function () {",
      "    return new Counter();",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/runtime-pkg/index.d.ts",
    [
      "export declare class Counter {",
      "  constructor();",
      "  bump(key: string): string;",
      "  reset(): void;",
      "  static from(): Counter;",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
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
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["main.js", "src-feature-lazy.js"]);

  const baseOutput = await fixture.read("dist/main.js");
  const lazyOutput = await fixture.read("dist/src-feature-lazy.js");

  expect(baseOutput).not.toMatch(/\bexport\s*\{/);
  expect(baseOutput).not.toMatch(/globalThis\.__gccChunkRuntime/);
  expect(baseOutput).toContain("__gcc_runtime__");
  expect(baseOutput).toContain("gcc.src.feature");
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
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["main.js", "src-feature-lazy.js"]);

  const baseOutput = await fixture.read("dist/main.js");
  const lazyOutput = await fixture.read("dist/src-feature-lazy.js");

  expect(baseOutput).toContain("__gcc_runtime__");
  expect(baseOutput).toContain("__lazyLoader");
  expect(baseOutput).not.toMatch(/goog\.module/);
  expect(baseOutput).not.toMatch(/ModuleManager/);
  expect(lazyOutput).toContain("__gcc_runtime__");
  expect(lazyOutput).toContain("renderMessage");
  expect(lazyOutput).not.toMatch(/goog\.module/);
});

test.serial("generateExterns follows declaration dependencies and emits stable property externs", async () => {
  const fixture = await createExternFixture();

  const result = await generateExterns({
    appEntryFiles: ["./main.ts"],
    modules: ["contract-pkg"],
    mode: "boundary-aware",
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.scannedFiles.some((filePath) => filePath.endsWith("/base-host/index.d.ts"))).toBe(true);
  expect(result.mode).toBe("boundary-aware");
  expect(result.text).toContain("Object.prototype.addController;");
  expect(result.text).toContain("Object.prototype.removeController;");
  expect(result.text).toContain("Object.prototype.requestUpdate;");
  expect(result.text).toContain("Object.prototype.updateComplete;");
  expect(result.text).toContain("Object.prototype.hostConnected;");
  expect(result.text).toContain("Object.prototype.hostDisconnected;");
  expect(result.text).toContain("Object.prototype.togglePlay;");
  expect(result.text).toContain("Object.prototype.isAnimating;");
  expect(result.text).toContain("Object.prototype.link;");
  expect(result.text).not.toContain("Object.prototype.attribute;");
  expect(result.text).not.toContain("Object.prototype.reflect;");
  expect(result.text).not.toContain("Object.prototype.map;");
  expect(result.text).not.toContain("__gcc_extern_");
});

test.serial("generateExterns candidates mode resolves package subpaths that ship sibling declaration files", async () => {
  const fixture = await createExternFixture();

  const result = await generateExterns({
    includeDependencies: false,
    mode: "candidates",
    modules: ["contract-pkg/decorators.js"],
    projectRoot: fixture.projectRoot,
  });

  expect(result.scannedFiles).toHaveLength(1);
  expect(result.mode).toBe("candidates");
  expect(result.text).toContain("Object.prototype.attribute;");
  expect(result.text).toContain("Object.prototype.reflect;");
});

test.serial("generateExterns runtime-aware mode captures helper-lowered dependency fields without noise", async () => {
  const fixture = await createRuntimeExternFixture();

  const result = await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    projectRoot: fixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: fixture.srcDir,
  });

  expect(result.mode).toBe("runtime-aware");
  expect(result.text).toContain("Object.prototype.bump;");
  expect(result.text).toContain("Object.prototype.counts;");
  expect(result.text).toContain("Object.prototype.label;");
  expect(result.text).toContain("Object.prototype.reset;");
  expect(result.text).toContain("Object.prototype.from;");
  expect(result.text).not.toContain("Object.prototype.addEventListener;");
  expect(result.text).not.toContain("Object.prototype.apply;");
  expect(result.text).not.toContain("Object.prototype.length;");
});

test.serial("externs CLI writes generated output with bun-compatible tests", async () => {
  const fixture = await createExternFixture();
  const outputFile = path.join(
    fixture.projectRoot,
    "closure-externs",
    "contract.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./main.ts",
    "--project-root",
    fixture.projectRoot,
    "--src-dir",
    fixture.srcDir,
    "--module",
    "contract-pkg",
    "--output-file",
    outputFile,
  ]);

  const externsOutput = await fs.readFile(outputFile, "utf8");
  expect(externsOutput).toContain("/** @externs */");
  expect(externsOutput).toContain("Object.prototype.addController;");
  expect(externsOutput).toContain("Object.prototype.togglePlay;");
  expect(externsOutput).not.toContain("Object.prototype.attribute;");
});

test.serial("externs CLI runtime-aware mode accepts runtime-entry files", async () => {
  const fixture = await createRuntimeExternFixture();
  const outputFile = path.join(
    fixture.projectRoot,
    "closure-externs",
    "runtime.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./index.ts",
    "--project-root",
    fixture.projectRoot,
    "--src-dir",
    fixture.srcDir,
    "--runtime-entry",
    "./node_modules/runtime-pkg/index.js",
    "--mode",
    "runtime-aware",
    "--module",
    "runtime-pkg",
    "--output-file",
    outputFile,
  ]);

  const externsOutput = await fs.readFile(outputFile, "utf8");
  expect(externsOutput).toContain("Object.prototype.counts;");
  expect(externsOutput).toContain("Object.prototype.label;");
  expect(externsOutput).not.toContain("Object.prototype.addEventListener;");
});

test.serial("build auto-generates runtime-aware dependency externs for helper-lowered fields", async () => {
  const fixture = await createRuntimeExternFixture();

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/runtime-pkg/);

  const builtModule = await import(
    `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?runtime=${Date.now()}`
  );
  expect(builtModule.first).toBe("demo:1");
  expect(builtModule.second).toBe("demo:2");
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
  expect(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
  ).toEqual(["chunk-map.json", "main.js", "src-feature-lazy.js"]);

  const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
  expect(manifest.baseChunk).toBe("main");
  expect(manifest.modules["gcc.src.feature"]).toBe("src-feature-lazy");
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
  expect(manifest.baseChunk).toBe("main");
  expect(manifest.chunks["src-feature-lazy"].deps).toEqual(["main"]);
  expect(manifest.modules["gcc.src.feature"]).toBe("src-feature-lazy");
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
