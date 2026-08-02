import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import {
  normalizeBuildOptions,
  resolveChunkOutputType,
  resolveVendorChunk,
} from "../src/build/resolve/options.ts";
import { getOptionsSignature } from "../src/build/resolve/signatures.ts";
import { isScaffoldingOnly } from "../src/build/closure/prune-empty-chunks.ts";
import {
  createFixture,
  findFilesNamed,
  getProjectCacheDir,
  listDirectoryNames,
} from "./helpers.mjs";

test.serial(
  "emits smaller script chunks for explicit lazy modules",
  { timeout: 20000 },
  async () => {
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
      chunks: { mode: "bundler-runtime", outputType: "script" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
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
    expect(baseOutput).not.toMatch(/m[0-9a-f]{8}/);
    expect(baseOutput).toContain(".__g");
    // Hoisted entry modules execute inline; no `.n([...])` kick remains.
    expect(baseOutput).not.toMatch(/\.n\(\[/);
    expect(baseOutput).toContain('textContent="base"');
    expect(baseOutput).not.toMatch(/LAZY_FEATURE/);
    expect(lazyOutput).toMatch(/LAZY_FEATURE/);
  },
);

test.serial(
  "emits bundler-runtime chunks for explicit lazy modules",
  { timeout: 20000 },
  async () => {
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
      chunks: { mode: "bundler-runtime", outputType: "script" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
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
    expect(baseOutput).not.toMatch(/m[0-9a-f]{8}/);
    expect(baseOutput.trimStart()).not.toMatch(/^var\s/);
    expect(baseOutput.trimStart()).toMatch(/^!function\(\)\{/);
    expect(baseOutput).toContain(".__g");
    // Hoisted entry modules execute inline; no `.n([...])` kick remains.
    expect(baseOutput).not.toMatch(/\.n\(\[/);
    expect(baseOutput).toContain('textContent="base"');
    expect(baseOutput).not.toMatch(/goog\.module/);
    expect(baseOutput).not.toMatch(/ModuleManager/);
    expect(baseOutput).not.toContain('Object.defineProperty(d,"default"');
    expect(lazyOutput).not.toContain("__gcc_runtime__");
    expect(lazyOutput).not.toContain("gcc.src.feature");
    expect(lazyOutput).not.toContain("base chunk missing");
    expect(lazyOutput).not.toMatch(/m[0-9a-f]{8}/);
    expect(lazyOutput).not.toContain("renderMessage");
    expect(lazyOutput.trimStart()).not.toMatch(/^var\s/);
    expect(lazyOutput.trimStart()).toMatch(/^!function\(\)\{/);
    expect(lazyOutput).not.toMatch(/Object\.defineProperty\([^)]*,\s*[0-9]+,/);
    expect(lazyOutput).not.toMatch(/\bta\(/);
    expect(lazyOutput).not.toMatch(/\bqa\(/);
    expect(lazyOutput).not.toMatch(/\bha\./);
    expect(lazyOutput).toMatch(/\[[0-9]+\]=/);
    expect(lazyOutput).not.toContain('["default"]');
    expect(lazyOutput).not.toMatch(/goog\.module/);
    // Hoisted lazy chunks run on script load rather than through `h()`.
    expect(lazyOutput).not.toMatch(
      /(?:G|\$gcc\.[A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\(function\(/,
    );
  },
);

test.serial(
  "pools an identical lowering helper across chunks before Closure runs",
  { timeout: 20000 },
  async () => {
    // Byte-identical helper bodies in a base module and a lazy module collapse
    // onto one content-addressed declaration at emit time, so exactly one body
    // ships. The old pipeline instead fingerprinted Closure's *output* and
    // swapped matching bodies for a hard-coded tslib copy.
    // The exact shape TypeScript's downlevel lowering emits, once per file.
    const helperSource = [
      "var __runInitializers = (this && (this as any).__runInitializers) || function (a: any, b: any, c: any) {",
      "  var useValue = arguments.length > 2;",
      "  for (var i = 0; i < b.length; i++) {",
      "    c = useValue ? b[i].call(a, c) : b[i].call(a);",
      "  }",
      "  return useValue ? c : void 0;",
      "};",
      "",
    ].join("\n");
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        helperSource,
        'const loadFeature = () => import("./feature");',
        '(globalThis as any)["__lazyLoader"] = () =>',
        "  loadFeature().then((module) => module.default());",
        '(globalThis as any)["__baseValue"] = () =>',
        "  String(__runInitializers({}, [(value: number) => value + 10], 1));",
        'document.body.textContent = "base";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      [
        helperSource,
        "export default function renderMessage() {",
        "  return String(__runInitializers({}, [(value: number) => value + 1], 0));",
        "}",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      languageOut: "ECMASCRIPT5",
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const outputBasenames = result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right));
    const lazyOutputName = outputBasenames.find((name) => name !== "main.js");
    expect(lazyOutputName).toBeTruthy();

    const baseOutput = await fixture.read("dist/main.js");
    const lazyOutput = await fixture.read(`dist/${lazyOutputName}`);
    const combinedOutput = `${baseOutput}\n${lazyOutput}`;

    // One helper body for the whole program, in the chunk everything depends on.
    expect(combinedOutput.match(/arguments\.length>2/gu) ?? []).toHaveLength(1);
    expect(baseOutput).toMatch(/arguments\.length>2/u);
    expect(lazyOutput).not.toContain("arguments.length>2");

    // The post-Closure helper bag and its runtime aliases are gone for good.
    expect(combinedOutput).not.toContain("globalThis.__g._");
    expect(combinedOutput).not.toMatch(/_\[\d\]=function/u);
    expect(combinedOutput).not.toContain("var G=globalThis.__g,_=G._");

    const { documentStub, locationStub, pendingScripts } =
      createScriptRuntimeStub();
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousGcc = globalThis.$gcc;
    try {
      globalThis.document = documentStub;
      globalThis.location = locationStub;
      const runFile = async (filePath) =>
        (0, eval)(await fs.readFile(filePath, "utf8"));
      await runFile(
        result.outputFiles.find((file) => file.endsWith("main.js")),
      );
      expect(globalThis["__baseValue"]()).toBe("11");
      const lazyPromise = globalThis["__lazyLoader"]();
      expect(pendingScripts).toHaveLength(1);
      for (const element of pendingScripts) {
        await runFile(
          path.join(fixture.outDir, path.basename(String(element.src))),
        );
        element.onload?.();
      }
      expect(await lazyPromise).toBe("1");
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      if (previousGcc === undefined) delete globalThis.$gcc;
      else globalThis.$gcc = previousGcc;
      delete globalThis["__lazyLoader"];
      delete globalThis["__baseValue"];
    }
  },
);

test.serial(
  "bundler-runtime keeps a module namespace facade for opaque lazy loaders",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        '(globalThis as any)["__opaqueLoad"] = () =>',
        '  (globalThis as any)["__consumeLoader"](() => import("./feature"));',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      'export default function render() { return "opaque-ok"; }\n',
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime", outputType: "esm" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const outputText = (
      await Promise.all(
        result.outputFiles.map((filePath) => fs.readFile(filePath, "utf8")),
      )
    ).join("\n");
    expect(outputText).toContain("Object.defineProperties");

    const mainOutput = result.outputFiles.find((filePath) =>
      filePath.endsWith("main.js"),
    );
    expect(mainOutput).toBeTruthy();
    const previousConsumer = globalThis["__consumeLoader"];
    const previousOpaqueLoad = globalThis["__opaqueLoad"];
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      globalThis["__consumeLoader"] = (loader) =>
        loader().then((module) =>
          typeof module.default === "function"
            ? module.default()
            : "missing-facade",
        );
      globalThis.document = {
        createElement: () => ({}),
        head: { appendChild() {} },
        querySelectorAll: () => [],
      };
      globalThis.location = { href: pathToFileURL(mainOutput).href };
      await import(`${pathToFileURL(mainOutput).href}?opaque=${Date.now()}`);
      expect(await globalThis["__opaqueLoad"]()).toBe("opaque-ok");
    } finally {
      if (previousConsumer === undefined) delete globalThis["__consumeLoader"];
      else globalThis["__consumeLoader"] = previousConsumer;
      if (previousOpaqueLoad === undefined) delete globalThis["__opaqueLoad"];
      else globalThis["__opaqueLoad"] = previousOpaqueLoad;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
    }
  },
);

test.serial(
  "bundler-runtime preserves property names read reflectively through for-in",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.js",
      [
        "function applyAttributes(attrs, node) {",
        "  for (const key in attrs) {",
        '    if (key === "class") {',
        "      node.className = attrs[key];",
        '    } else if (key === "style") {',
        "      node.style.cssText = attrs[key];",
        "    } else {",
        "      node.setAttribute(key, attrs[key]);",
        "    }",
        "  }",
        "}",
        "",
        "function omitProps(props, exclude) {",
        "  const next = {};",
        "  for (const key in props) {",
        '    if (exclude.includes(key) || key === "label") {',
        "      continue;",
        "    }",
        "    next[key] = props[key];",
        "  }",
        "  return next;",
        "}",
        "",
        'const exclude = "$$slots $$events $$legacy variant children".split(" ");',
        "const attrs = omitProps({",
        "  $$slots: { default: true },",
        '  class: "m3-container",',
        '  style: "color:red",',
        '  variant: "filled",',
        '  label: "ignored",',
        "}, exclude);",
        "applyAttributes(attrs, document.body);",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.js"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/main.js");
    // The keys are read as data by the `for...in` filters, so they are pinned
    // before Closure runs and keep their authored spelling in both the
    // comparison and the object literal. The old pipeline instead respelled
    // them afterwards from the property-renaming report, which could not tell
    // these keys apart from network JSON keys or UI labels.
    expect(output).toContain('"class"');
    expect(output).toContain('"$$slots"');
    expect(output).toContain('"style"');
    expect(output).toContain('"label"');

    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousGcc = globalThis.$gcc;
    const applied = [];
    try {
      globalThis.location = { href: "https://example.test/index.html" };
      globalThis.document = {
        body: {
          className: "",
          setAttribute: (name, value) => applied.push([name, value]),
          style: { cssText: "" },
        },
        currentScript: { src: "https://example.test/main.js" },
        createElement: () => ({}),
        documentElement: { appendChild: () => {} },
        head: { appendChild: () => {} },
        querySelectorAll: () => [],
      };
      await import(
        pathToFileURL(
          result.outputFiles.find((file) => file.endsWith("main.js")),
        ).href
      );
      expect(globalThis.document.body.className).toBe("m3-container");
      expect(globalThis.document.body.style.cssText).toBe("color:red");
      // `$$slots`, `variant` and `label` are excluded by the filter list, so
      // nothing reaches setAttribute.
      expect(applied).toEqual([]);
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      if (previousGcc === undefined) delete globalThis.$gcc;
      else globalThis.$gcc = previousGcc;
    }
  },
);

test.serial(
  "bundler-runtime caches one combined Closure job when one lazy chunk changes",
  { timeout: 20000 },
  async () => {
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
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(firstResult.ok).toBe(true);

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
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(secondResult.ok).toBe(true);

    const secondJobKeys = await listDirectoryNames(closureJobCacheDir);
    expect(secondJobKeys.length).toBe(2);
  },
);

test.serial(
  "parallel bundler-runtime Closure execution is byte-equivalent to serial execution",
  { timeout: 20000 },
  async () => {
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
        chunks: { mode: "bundler-runtime" },
        entries: ["./main.ts"],
        outDir: serialOutDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expect(serialResult.ok).toBe(true);
    } finally {
      if (previousConcurrency === undefined) {
        delete process.env.GCC_CLOSURE_CONCURRENCY;
      } else {
        process.env.GCC_CLOSURE_CONCURRENCY = previousConcurrency;
      }
    }

    const parallelResult = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: parallelOutDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(parallelResult.ok).toBe(true);

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
  },
);

test.serial(
  "emits a bundler-runtime chunk manifest when requested",
  { timeout: 20000 },
  async () => {
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
        manifestFile: "chunk-map.json",
        mode: "bundler-runtime",
      },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const outputBasenames = result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right));
    expect(outputBasenames).toHaveLength(3);
    expect(outputBasenames).toContain("chunk-map.json");
    expect(outputBasenames).toContain("main.js");
    expect(
      outputBasenames.some((name) => /^c[0-9a-f]{8}\.js$/.test(name)),
    ).toBe(true);

    const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
    expect(manifest.baseChunk).toMatch(/^c[0-9a-f]{8}$/);
    const moduleEntries = Object.entries(manifest.modules);
    expect(moduleEntries).toHaveLength(2);
    expect(
      moduleEntries.every(
        ([moduleId, chunkId]) =>
          /^m[0-9a-f]{8}$/.test(moduleId) && /^c[0-9a-f]{8}$/.test(chunkId),
      ),
    ).toBe(true);
    expect(
      Object.values(manifest.chunks).every((chunkValue) =>
        Array.isArray(chunkValue.css),
      ),
    ).toBe(true);
    const chunkEntries = Object.entries(manifest.chunks);
    expect(chunkEntries).toHaveLength(2);
    expect(
      chunkEntries.every(
        ([chunkId, chunkValue]) =>
          /^c[0-9a-f]{8}$/.test(chunkId) &&
          Array.isArray(chunkValue.css) &&
          Array.isArray(chunkValue.deps) &&
          Array.isArray(chunkValue.modules) &&
          chunkValue.modules.every((moduleId) =>
            /^m[0-9a-f]{8}$/.test(moduleId),
          ),
      ),
    ).toBe(true);
  },
);

test.serial("rejects non-literal dynamic import specifiers", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    ['const target = "./feature";', "void import(target);", ""].join("\n"),
  );
  await fixture.write("src/feature.ts", "export const value = 1;\n");

  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "bundler-runtime" },
    entries: ["./main.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.ok).toBe(false);
  expect(String(result.diagnostics[0]?.message ?? "")).toMatch(
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

  expect(result.ok).toBe(false);
  expect(String(result.diagnostics[0]?.message ?? "")).toMatch(
    /chunks\.mode = "bundler-runtime" or "split"/,
  );
});

function createScriptRuntimeStub(baseUrl = "http://localhost/dist/main.js") {
  const pendingScripts = [];
  const documentStub = {
    body: { textContent: "" },
    // The prelude resolves chunk URLs against the base chunk's own URL.
    currentScript: { src: baseUrl },
    createElement: () => ({}),
    head: {
      appendChild(element) {
        pendingScripts.push(element);
      },
    },
  };
  return { documentStub, locationStub: { href: baseUrl }, pendingScripts };
}

test.serial(
  "a hoisted lazy chunk reaches the base runtime members it was compiled against",
  { timeout: 20000 },
  async () => {
    // The runtime member ABI is emitted by two independent families: the core
    // defines `r.<member>` and every chunk reads it back off the runtime global
    // through an alias line plus a trailing completion call. A desynced pair is
    // not a compile error and it is not visible in either family alone -- a base
    // defining `.loaded` while its chunks still called `.l(` built cleanly and
    // passed the whole suite, failing only on the first lazy load
    // (/tmp/gcc-w2-polish.md).
    //
    // Closure renames both sides together because they share one job, so the
    // only way to see a drift is to run the pair. This executes base *and* the
    // injected chunk and asserts the value crosses the boundary.
    const fixture = await createFixture();
    await fixture.write(
      "src/feature.ts",
      [
        'export const marker = "HOISTED_LAZY";',
        "export function shout() {",
        '  return marker + "!";',
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__lazyValue"] = () =>',
        "  load().then((m) => m.shout());",
        '(globalThis as Record<string, unknown>)["__baseValue"] = () => "base-ok";',
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime", outputType: "script", publicPath: "./" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const baseFile = result.outputFiles.find((file) => file.endsWith("main.js"));
    const lazyFile = result.outputFiles.find(
      (file) => file.endsWith(".js") && file !== baseFile,
    );
    expect(baseFile).toBeTruthy();
    expect(lazyFile).toBeTruthy();

    const baseSource = await fs.readFile(baseFile, "utf8");
    const lazySource = await fs.readFile(lazyFile, "utf8");

    // Pin that this really is the two-family shape, so the test cannot quietly
    // stop covering it: the base carries the runtime core and the lazy chunk
    // reaches the runtime global for members it does not define itself.
    expect(baseSource).toContain("globalThis.__g");
    expect(lazySource).toContain("globalThis.__g");
    // Alias line plus completion call, post-rename: `<ns>.<member>(<id>)`.
    expect(lazySource).toMatch(/\.[A-Za-z_$][\w$]*\(\d+\)/u);

    const { documentStub, locationStub, pendingScripts } =
      createScriptRuntimeStub();
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousGcc = globalThis.$gcc;
    try {
      globalThis.document = documentStub;
      globalThis.location = locationStub;
      const runFile = async (filePath) =>
        (0, eval)(await fs.readFile(filePath, "utf8"));

      await runFile(baseFile);
      expect(globalThis["__baseValue"]()).toBe("base-ok");

      // Requesting the lazy module makes the runtime ask for its chunk; running
      // that chunk exercises register -> loaded -> require across the boundary.
      const pending = globalThis["__lazyValue"]();
      expect(pendingScripts).toHaveLength(1);
      for (const element of pendingScripts) {
        await runFile(
          path.join(fixture.outDir, path.basename(String(element.src))),
        );
        element.onload?.();
      }
      expect(await pending).toBe("HOISTED_LAZY!");
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      if (previousGcc === undefined) delete globalThis.$gcc;
      else globalThis.$gcc = previousGcc;
      delete globalThis["__lazyValue"];
      delete globalThis["__baseValue"];
    }
  },
);

test.serial(
  "split mode emits ESM chunks on the shared runtime with graph-derived ids",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__loadFeature"] = () =>',
        "  load().then((m) => {",
        "    document.body.textContent = m.shout();",
        "  });",
        'document.body.textContent = "base";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      [
        'export const marker = "LAZY_FEATURE";',
        "export function shout() {",
        '  return marker + "!";',
        "}",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "split", publicPath: "./" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const names = result.outputFiles.map((file) => path.basename(file));
    expect(names).toContain("main.js");

    const baseSource = await fixture.read("dist/main.js");

    // Modules are scope-hoisted, exactly as the old split path promised.
    expect(baseSource).not.toMatch(/__register\(/);

    // The parallel split runtime is gone: no string module registry, no
    // script-tag injection, no goog-derived module keys anywhere in output.
    expect(baseSource).not.toMatch(/gccImportLazy\(/);
    expect(baseSource).not.toMatch(/gccRegisterLazy\(/);
    expect(baseSource).not.toContain('createElement("script")');
    for (const outputFile of result.outputFiles) {
      if (!outputFile.endsWith(".js")) {
        continue;
      }
      expect(await fs.readFile(outputFile, "utf8")).not.toMatch(/gcc\.src\./);
    }

    // It is on the shared capability-gated runtime with native import().
    expect(baseSource).toMatch(/import\(/);
    expect(baseSource).toMatch(/"\.\/c[0-9a-f]{8}\.js"/);

    // And the lazy module still resolves renamed exports across the boundary.
    const mainOutput = path.join(fixture.outDir, "main.js");
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    try {
      globalThis.document = { body: { textContent: "" } };
      // The runtime resolves chunk URLs against the document base.
      globalThis.location = { href: pathToFileURL(mainOutput).href };
      await import(`${pathToFileURL(mainOutput).href}?split-unified`);
      await globalThis["__loadFeature"]();
      expect(globalThis.document.body.textContent).toBe("LAZY_FEATURE!");
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      delete globalThis["__loadFeature"];
    }
  },
);

test.serial(
  "split inherits the scope-hoisting restriction on escaping namespaces",
  { timeout: 20000 },
  async () => {
    // The old split runtime handed out a real registry object, so a namespace
    // could escape anywhere. The shared runtime lowers a namespace to its
    // module slot -- which is where the byte win comes from -- so property
    // reads through an escaped namespace still work (they rename to slot
    // indices), but handing the namespace itself back to un-analysed code does
    // not. That case must fail closed with a diagnostic rather than miscompile.
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__loadFeature"] = () =>',
        "  load().then(function (m) {",
        "    return m;",
        "  });",
        "",
      ].join("\n"),
    );
    await fixture.write("src/feature.ts", 'export const marker = "x";\n');

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "split", publicPath: "./" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.map((d) => String(d.message)).join("\n"),
    ).toMatch(/does not support returning module namespace values/);
  },
);

test("split and bundler-runtime select the same envelope at every language level", () => {
  // The whole point of the unification: envelope is a function of capability,
  // not of which chunked mode name the caller typed. Parity here is what keeps
  // a future gate change from silently applying to only one of the two.
  for (const languageOut of [
    "ECMASCRIPT3",
    "ECMASCRIPT5",
    "ECMASCRIPT6",
    "ECMASCRIPT_NEXT",
  ]) {
    for (const outputType of ["auto", "esm", "script"]) {
      for (const worker of [false, true]) {
        const split = resolveChunkOutputType({
          chunkMode: "split",
          languageOut,
          outputType,
          worker,
        });
        expect(split).toBe(
          resolveChunkOutputType({
            chunkMode: "bundler-runtime",
            languageOut,
            outputType,
            worker,
          }),
        );
      }
    }
  }

  // Spot-check the two ends so parity cannot be satisfied by both being wrong:
  // ES2015+ browser consumers get modules, ES5 consumers get the script loader.
  expect(
    resolveChunkOutputType({
      chunkMode: "split",
      languageOut: "ECMASCRIPT_NEXT",
      outputType: "auto",
    }),
  ).toBe("esm");
  expect(
    resolveChunkOutputType({
      chunkMode: "split",
      languageOut: "ECMASCRIPT5",
      outputType: "auto",
    }),
  ).toBe("script");
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

  expect(result.ok).toBe(false);
  expect(String(result.diagnostics[0]?.message ?? "")).toMatch(
    /gcc-ts-bundler\/runtime|Cannot find module|Failed to resolve package/,
  );
});

test("resolves chunk output type through the auto gates", () => {
  const resolve = (overrides) =>
    resolveChunkOutputType({
      chunkMode: "bundler-runtime",
      languageOut: "ECMASCRIPT_NEXT",
      outputType: "auto",
      ...overrides,
    });

  // Explicit requests are honoured where the gates allow module output.
  expect(resolve({ outputType: "esm" })).toBe("esm");
  expect(resolve({ outputType: "script" })).toBe("script");
  expect(resolve({ outputType: "esm", languageOut: "ECMASCRIPT6" })).toBe(
    "esm",
  );

  // Forced-script gates outrank an explicit esm request: Closure will happily
  // emit ES5 bodies *with* import statements, and worker consumers cannot load
  // module output at all. Basic builds keep auto as script but may opt into ESM.
  for (const languageOut of ["ECMASCRIPT3", "ECMASCRIPT5"]) {
    expect(resolve({ languageOut, outputType: "esm" })).toBe("script");
  }
  expect(resolve({ chunkMode: "off" })).toBe("script");
  expect(resolve({ chunkMode: "off", outputType: "esm" })).toBe("esm");
  expect(resolve({ outputType: "esm", worker: true })).toBe("script");
});

test.serial(
  "emits native module chunks when chunk output type is esm",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__loadFeature"] = load;',
        'document.body.textContent = "base";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      ['export const marker = "LAZY_FEATURE";', ""].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime", outputType: "esm", publicPath: "./" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const baseOutput = await fixture.read("dist/main.js");

    // The $gcc machinery is gone: no rename prefix namespace, no per-chunk
    // IIFE wrapper, no canonicalized root access.
    expect(baseOutput).not.toContain("globalThis.$gcc");
    expect(baseOutput).not.toContain("var G=globalThis.__g,_=G._");

    // Chunks are loaded with native import() against relative specifiers,
    // so no script element injection and no currentScript base derivation.
    expect(baseOutput).not.toContain('createElement("script")');
    expect(baseOutput).not.toContain("currentScript");
    expect(baseOutput).toMatch(/import\(/);
    expect(baseOutput).toMatch(/"\.\/c[0-9a-f]{8}\.js"/);

    // The registry survives; the CSS coupling does not. Nothing in a
    // standalone build can ever fill a manifest CSS row, so the <link> loader
    // and the per-chunk CSS fan-out are gated out of the preamble.
    expect(baseOutput).toContain("a.r=function(");
    expect(baseOutput).not.toContain('createElement("link")');
    expect(baseOutput).not.toContain('link[rel="stylesheet"]');
  },
);

test("empty-chunk detection recognises scaffolding and nothing else", () => {
  // The shape the Svelte + Vite example shipped: an import edge plus the
  // loader's own completion call, 49 bytes of pure liability.
  expect(
    isScaffoldingOnly('import"./index-ose5NbXd.js";globalThis.__g.A(1);\n'),
  ).toBe(true);
  // Script mode wraps the same body in an IIFE and redeclares the namespace.
  expect(
    isScaffoldingOnly(
      '!function(){\nvar $gcc=globalThis.$gcc=globalThis.$gcc||{};\n$gcc.Y.m(1);\n}();\n',
    ),
  ).toBe(true);
  expect(isScaffoldingOnly("")).toBe(true);

  // Fail-closed: anything the whitelist does not recognise keeps the chunk.
  expect(
    isScaffoldingOnly('import"./index.js";globalThis.__g.r(7,function(){});'),
  ).toBe(false);
  expect(isScaffoldingOnly('import"./index.js";sideEffect();')).toBe(false);
  expect(isScaffoldingOnly("var x=1;globalThis.__g.A(1);")).toBe(false);
  // Named imports mean the chunk actually uses a sibling's bindings.
  expect(
    isScaffoldingOnly('import{a}from"./index.js";a();globalThis.__g.A(1);'),
  ).toBe(false);
});

test("the CSS runtime flag participates in the options signature", () => {
  const base = {
    entries: ["./main.ts"],
    outDir: "/tmp/out",
    projectRoot: "/tmp/project",
    srcDir: "/tmp/project/src",
  };
  const off = getOptionsSignature(normalizeBuildOptions(base));
  const on = getOptionsSignature(
    normalizeBuildOptions({ ...base, cssRuntime: true }),
  );
  expect(off).not.toBe(on);
});

test.serial(
  "runtime preamble ships only the capabilities the plan uses",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__loadFeature"] = load;',
        'document.body.textContent = "base";',
        "",
      ].join("\n"),
    );
    await fixture.write("src/feature.ts", 'export const marker = "LAZY";\n');

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime", publicPath: "./" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);
    const baseOutput = await fixture.read("dist/main.js");

    // Nothing preloads, nothing registers a live export slot, no entry module
    // stays in registry form and no chunk can own CSS: every one of those
    // blocks is gated out. Together they were 1,061 of a 2,623-byte preamble.
    expect(baseOutput).not.toContain('link[rel="stylesheet"]');
    expect(baseOutput).not.toContain("configurable:!0,enumerable:!0");
    // The dynamic-import entry point and the module registry stay.
    expect(baseOutput).toMatch(/import\(/);
    expect(baseOutput).toContain("a.r=function(");

    // Fail-closed the other way: a preamble is never smaller than the loader
    // it still has to run.
    const preambleEnd = baseOutput.indexOf(".call(this,globalThis)");
    expect(preambleEnd).toBeGreaterThan(0);
    expect(preambleEnd).toBeLessThan(1400);
  },
);

test.serial(
  "keeps script chunk output when chunk output type is script",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__loadFeature"] = load;',
        'document.body.textContent = "base";',
        "",
      ].join("\n"),
    );
    await fixture.write("src/feature.ts", 'export const marker = "LAZY";\n');

    const result = await build({
      cache: { mode: "off" },
      chunks: {
        mode: "bundler-runtime",
        outputType: "script",
        publicPath: "./",
      },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.ok).toBe(true);
    const baseOutput = await fixture.read("dist/main.js");
    expect(baseOutput).toContain('createElement("script")');
    expect(baseOutput).toContain("currentScript");
    expect(baseOutput).not.toMatch(/^import\s|\bexport\s*\{/m);
  },
);

test.serial(
  "unified type metadata reaches the hoisted bundler-runtime input as JSDoc",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/widget.ts",
      [
        "export class Widget {",
        "  size: number = 1;",
        "}",
        "export function measure(widget: Widget): number {",
        "  return widget.size;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import { Widget, measure } from "./widget";',
        "document.body.textContent = String(measure(new Widget()));",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    // Assert on the linked input Closure is handed, not on dist: ADVANCED
    // strips every comment, so the annotations are invisible downstream even
    // when they did their job.
    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const linkedFiles = await findFilesNamed(projectCacheDir, "main.linked.js");
    expect(linkedFiles.length).toBeGreaterThan(0);
    const linked = await fs.readFile(linkedFiles[0], "utf8");

    // Hoisting suffixes runtime names; tokenized type references follow them.
    expect(linked).toMatch(/@param \{!Widget\$\$\d+\} widget/);
    expect(linked).toMatch(/@return \{number\}/);
  },
);

test.serial(
  "unified member metadata lands inside the class and imported types resolve",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/money.ts",
      [
        "export class Money {",
        '  unit: string = "eur";',
        "  minor: number;",
        "  constructor(minor: number) {",
        "    this.minor = minor;",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import { Money as Cash } from "./money";',
        "function total(cash: Cash): number {",
        "  return cash.minor;",
        "}",
        "document.body.textContent = String(total(new Cash(2)));",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      chunks: { mode: "bundler-runtime" },
      entries: ["./main.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const linkedFiles = await findFilesNamed(projectCacheDir, "main.linked.js");
    expect(linkedFiles.length).toBeGreaterThan(0);
    const linked = await fs.readFile(linkedFiles[0], "utf8");

    // Field metadata is emitted as safe synthetic prototype declarations.
    expect(linked).toMatch(
      /@type \{string\}[\s\S]*Money\$\$\d+\.prototype\.unit;/,
    );
    expect(linked).toMatch(
      /@type \{number\}[\s\S]*Money\$\$\d+\.prototype\.minor;/,
    );
    // The imported class resolves to the origin module's suffixed binding.
    expect(linked).toMatch(/@param \{!Money\$\$\d+\} cash/);
    expect(linked).not.toContain("Cash");
    expect(linked).toMatch(/function total\$\$\d+/);
  },
);

test.serial(
  "standalone escape hatch preserves semantic enum lowering",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/mode.ts",
      // A *string* enum: number enums are lowered by SWC into a rename-safe
      // reverse-mapped object and carry no `@enum` metadata, and a `const enum`
      // is erased outright, so the string enum is the shape this count
      // measures. `test/const-enum.test.mjs` covers the const case separately.
      'export enum Mode { Active = "active", Idle = "idle" }\n',
    );
    await fixture.write(
      "src/main.ts",
      [
        'import { Mode } from "./mode";',
        "function choose(value: number): Mode {",
        "  return value > 0 ? Mode.Active : Mode.Idle;",
        "}",
        '(globalThis as any)["__enumMode"] = choose(1);',
        "",
      ].join("\n"),
    );
    const previous = process.env.GCC_DISABLE_TYPE_INFERENCE;
    process.env.GCC_DISABLE_TYPE_INFERENCE = "1";
    let result;
    try {
      result = await build({
        cache: { dir: cacheDir, mode: "persistent" },
        chunks: { mode: "bundler-runtime" },
        entries: ["./main.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
    } finally {
      if (previous === undefined) delete process.env.GCC_DISABLE_TYPE_INFERENCE;
      else process.env.GCC_DISABLE_TYPE_INFERENCE = previous;
    }
    expect(
      result.ok,
      result.ok
        ? ""
        : result.diagnostics.map(({ message }) => message).join("\n"),
    ).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const metadataFiles = (
      await findFilesNamed(projectCacheDir, "meta.json")
    ).filter((filePath) =>
      filePath.includes(`${path.sep}native-emit${path.sep}`),
    );
    expect(metadataFiles.length).toBeGreaterThan(0);
    const nativeMetadata = JSON.parse(
      await fs.readFile(metadataFiles[0], "utf8"),
    );
    const counts = nativeMetadata.typeMetadata.reduce(
      (total, file) => ({
        annotationCount: total.annotationCount + file.counts.annotationCount,
        enumDeclarationCount:
          total.enumDeclarationCount + file.counts.enumDeclarationCount,
        memberAnnotationCount:
          total.memberAnnotationCount + file.counts.memberAnnotationCount,
        typeDeclarationCount:
          total.typeDeclarationCount + file.counts.typeDeclarationCount,
      }),
      {
        annotationCount: 0,
        enumDeclarationCount: 0,
        memberAnnotationCount: 0,
        typeDeclarationCount: 0,
      },
    );
    expect(counts.enumDeclarationCount).toBeGreaterThan(0);
    expect(counts.annotationCount).toBe(0);
    expect(counts.memberAnnotationCount).toBe(0);
    expect(counts.typeDeclarationCount).toBe(0);
  },
);

test("resolves the vendor chunk through the same gates as module output", () => {
  const resolve = (overrides) =>
    resolveVendorChunk({
      chunkMode: "bundler-runtime",
      languageOut: "ECMASCRIPT_NEXT",
      outputType: "esm",
      ...overrides,
    });

  // Opt-in only: the split trades ~2.2 KB gzip of first load for a vendor
  // chunk that survives app-only deploys in the browser cache, and which side
  // wins depends on traffic the bundler cannot see. See docs/vite.md.
  expect(resolve({ vendorChunk: true })).toBe(true);
  expect(resolve({})).toBe(false);
  expect(resolve({ vendorChunk: "auto" })).toBe(false);

  // The split only stabilises names under module output, where the entry's
  // file name is embedded in its siblings. Script chunks find each other
  // through the manifest, so an extra chunk would be pure overhead.
  expect(resolve({ outputType: "script", vendorChunk: true })).toBe(false);
  expect(resolve({ chunkMode: "off", vendorChunk: true })).toBe(false);
  // `split` is on the same import-edge chunk graph, so it qualifies exactly as
  // `bundler-runtime` does.
  expect(resolve({ chunkMode: "split", vendorChunk: true })).toBe(true);
  for (const languageOut of ["ECMASCRIPT3", "ECMASCRIPT5"]) {
    expect(resolve({ languageOut, vendorChunk: true })).toBe(false);
  }
  expect(resolve({ worker: true, vendorChunk: true })).toBe(false);

  expect(resolve({ vendorChunk: false })).toBe(false);
  // Explicit true never defeats a gate: a script consumer cannot be handed a
  // chunk graph shape that only works for modules.
  expect(resolve({ outputType: "script", vendorChunk: true })).toBe(false);

  // The gates still track resolveChunkOutputType, so an explicit true follows
  // the module-output default rather than needing a second decision.
  expect(resolve({ outputType: "auto", vendorChunk: true })).toBe(
    resolveChunkOutputType({
      chunkMode: "bundler-runtime",
      languageOut: "ECMASCRIPT_NEXT",
      outputType: "auto",
    }) === "esm",
  );
});

test("chunks.vendorChunk participates in the options signature", () => {
  const signature = (chunks) =>
    getOptionsSignature(
      normalizeBuildOptions({
        chunks: { mode: "bundler-runtime", outputType: "esm", ...chunks },
        entries: ["./main.ts"],
        projectRoot: "/tmp/demo",
        srcDir: "/tmp/demo/src",
      }),
    );

  // Toggling it changes the chunk graph, so a cached build from the other
  // setting must not be served.
  expect(signature({ vendorChunk: false })).not.toBe(
    signature({ vendorChunk: true }),
  );
  expect(signature({ vendorChunk: "auto" })).toBe(
    signature({ vendorChunk: false }),
  );
});

test("normalizeBuildOptions resolves chunks.vendorChunk to a boolean", () => {
  const normalize = (chunks) =>
    normalizeBuildOptions({
      chunks,
      entries: ["./main.ts"],
      projectRoot: "/tmp/demo",
      srcDir: "/tmp/demo/src",
    }).chunks.vendorChunk;

  expect(
    normalize({
      mode: "bundler-runtime",
      outputType: "esm",
      vendorChunk: true,
    }),
  ).toBe(true);
  // Opt-in: the default resolves false however friendly the rest of the shape.
  expect(normalize({ mode: "bundler-runtime", outputType: "esm" })).toBe(false);
  expect(
    normalize({
      mode: "bundler-runtime",
      outputType: "script",
      vendorChunk: true,
    }),
  ).toBe(false);
  expect(
    normalize({
      mode: "bundler-runtime",
      outputType: "esm",
      vendorChunk: false,
    }),
  ).toBe(false);
  expect(normalize({ mode: "off" })).toBe(false);
  expect(normalize(undefined)).toBe(false);
});

/**
 * App entry + an eagerly imported node_modules dependency + a lazy chunk.
 * The dependency is what the vendor chunk is meant to carry out of the entry.
 */
async function writeVendorChunkFixture(
  fixture,
  appMarker,
  { lazy = true } = {},
) {
  await fixture.write(
    "node_modules/vendor-pkg/package.json",
    '{"name":"vendor-pkg","module":"./index.js","exports":"./index.js"}\n',
  );
  await fixture.write(
    "node_modules/vendor-pkg/index.js",
    [
      "export function greet(name) {",
      '  return "vendor:" + name;',
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.ts",
    'export const marker = "LAZY_FEATURE";\n',
  );
  await fixture.write(
    "src/main.ts",
    [
      'import { greet } from "vendor-pkg";',
      // `off` mode rejects dynamic imports outright, so that case gets an
      // otherwise identical entry without one.
      ...(lazy
        ? [
            'const load = () => import("./feature");',
            '(globalThis as Record<string, unknown>)["__loadFeature"] = load;',
          ]
        : []),
      `document.body.textContent = greet(${JSON.stringify(appMarker)});`,
      "",
    ].join("\n"),
  );
}

function readVendorChunkLayout(manifest) {
  const baseChunk = manifest.chunks[manifest.baseChunk];
  const vendorChunkId = baseChunk?.deps?.[0];
  const lazyChunkIds = Object.keys(manifest.chunks).filter(
    (chunkId) => chunkId !== manifest.baseChunk && chunkId !== vendorChunkId,
  );
  return {
    baseUrl: baseChunk?.url,
    lazyUrls: lazyChunkIds
      .map((chunkId) => manifest.chunks[chunkId]?.url)
      .sort((left, right) => String(left).localeCompare(String(right))),
    vendorUrl: vendorChunkId ? manifest.chunks[vendorChunkId]?.url : undefined,
  };
}

// NEEDS THE INTEGRATION BUILD: exercises build() from dist plus the native
// planChunks vendorChunk field, so it only becomes meaningful after
// `bun run build:js` and `bun run build:native`.
test.serial(
  "vendor chunk keeps its output name when app code changes",
  { timeout: 40000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const buildOnce = async () =>
      build({
        cache: { dir: cacheDir, mode: "persistent" },
        chunks: {
          manifestFile: "chunk-map.json",
          mode: "bundler-runtime",
          outputType: "esm",
          publicPath: "./",
          // Opt-in since the default flip: the split costs first-load bytes.
          vendorChunk: true,
        },
        entries: ["./main.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });

    await writeVendorChunkFixture(fixture, "first");
    expect((await buildOnce()).ok).toBe(true);
    const first = readVendorChunkLayout(
      JSON.parse(await fixture.read("dist/chunk-map.json")),
    );
    expect(first.vendorUrl).toBeDefined();
    const firstVendorContent = await fixture.read(
      `dist/${first.vendorUrl.replace(/^\.\//u, "")}`,
    );
    const firstBaseContent = await fixture.read("dist/main.js");

    // Only app code changes; the dependency and the lazy module are untouched.
    await writeVendorChunkFixture(fixture, "second");
    expect((await buildOnce()).ok).toBe(true);
    const second = readVendorChunkLayout(
      JSON.parse(await fixture.read("dist/chunk-map.json")),
    );
    const secondVendorContent = await fixture.read(
      `dist/${second.vendorUrl.replace(/^\.\//u, "")}`,
    );
    const secondBaseContent = await fixture.read("dist/main.js");

    // The deliverable: the dependency half of the graph stops churning, so its
    // cache entry survives an app edit. On a real app that is the biggest
    // chunk by far.
    expect(second.vendorUrl).toBe(first.vendorUrl);

    // Standalone builds publish stable file names (`main.js`, internal chunk
    // ids), so stability is asserted on content: the vendor chunk's bytes
    // are identical across the app edit while the entry's changed. Hash
    // churn semantics live in the vite naming tests. Pinned limit, not an
    // oversight: a lazy chunk's shipped bytes contain `import ... from
    // "./<entry>.js"`, so under vite naming it rehashes with the entry;
    // full lazy stability would need import-map indirection.
    expect(secondVendorContent).toBe(firstVendorContent);
    expect(secondBaseContent).not.toBe(firstBaseContent);
  },
);

// NEEDS THE INTEGRATION BUILD (see above).
test.serial(
  "no vendor chunk outside esm bundler-runtime output",
  { timeout: 40000 },
  async () => {
    const cases = [
      {
        chunks: {
          mode: "bundler-runtime",
          outputType: "script",
          vendorChunk: true,
        },
        label: "script output",
      },
      {
        chunks: {
          mode: "bundler-runtime",
          outputType: "esm",
          vendorChunk: false,
        },
        label: "vendorChunk: false",
      },
      // The default is now opt-in, so an untouched esm build has no vendor chunk.
      {
        chunks: { mode: "bundler-runtime", outputType: "esm" },
        label: "vendorChunk default",
      },
      { chunks: { mode: "off" }, label: "off mode" },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await writeVendorChunkFixture(fixture, "only", {
        lazy: testCase.chunks.mode !== "off",
      });
      const result = await build({
        cache: { mode: "off" },
        chunks: {
          manifestFile: "chunk-map.json",
          publicPath: "./",
          ...testCase.chunks,
        },
        entries: ["./main.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expect(result.ok).toBe(true);

      if (testCase.chunks.mode === "off") {
        // No chunk graph at all, so nothing to partition.
        expect(
          result.outputFiles.filter((filePath) => filePath.endsWith(".js")),
        ).toHaveLength(1);
        continue;
      }

      const manifest = JSON.parse(await fixture.read("dist/chunk-map.json"));
      // The base chunk depends on the vendor chunk and on nothing else, so an
      // empty dependency list is exactly "no vendor chunk was emitted".
      expect(
        manifest.chunks[manifest.baseChunk].deps,
        `${testCase.label}: base chunk must have no vendor dependency`,
      ).toEqual([]);
    }
  },
);
