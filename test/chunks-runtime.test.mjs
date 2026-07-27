import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import {
  normalizeBuildOptions,
  resolveChunkOutputType,
  resolveVendorChunk,
} from "../src/build/resolve/options.ts";
import { getOptionsSignature } from "../src/build/resolve/signatures.ts";
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
  "bundler-runtime ES5 reuses the helper alias for lazy registration and base finalization",
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
        "function __runInitializers(a, b, c) {",
        "  for (var d = arguments.length > 2, e = 0; e < b.length; e += 1) {",
        "    c = d ? b[e].call(a, c) : b[e].call(a);",
        "  }",
        "  return d ? c : void 0;",
        "}",
        "",
        "export default function renderMessage() {",
        "  return String(__runInitializers({}, [function(value) { return value + 1; }], 0));",
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

    expect(baseOutput).not.toContain("globalThis.__g.u(");
    expect(baseOutput).not.toContain('globalThis["__g"].u(');
    expect(baseOutput).not.toContain("globalThis.__g.n(");

    // Hoisted chunks emit module code at top level, so Closure keeps the
    // downleveled helper as an ordinary local function instead of routing it
    // through the shared ES5 helper bag; no bag reference may survive
    // without its installation.
    expect(lazyOutput).toContain("arguments.length>2");
    expect(lazyOutput).not.toContain("__runInitializers");
    const usesHelperBag = /_\[\d+\]\(/.test(lazyOutput);
    if (usesHelperBag) {
      expect(baseOutput).toContain("var G=globalThis.__g,_=G._||(G._=[]);");
      expect(lazyOutput).toContain("var G=globalThis.__g,_=G._;");
    }
    // No `h(function(...))` deferral wrapper, just a trailing
    // `l(<chunkIndex>)`-style call that resolves the loader.
    expect(lazyOutput).not.toMatch(
      /(?:G|\$gcc\.[A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*\(function\(\s*\)\s*\{/,
    );
    expect(lazyOutput.trimEnd()).toMatch(
      /\.[A-Za-z_$][\w$]*\(1\);?\s*\}\(\);?$/,
    );
  },
);

test.serial(
  "bundler-runtime rewrites property-protocol strings from the renaming report",
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
        '    if (exclude.includes(key) || "label" in props) {',
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
    expect(output).not.toContain('==="class"');
    expect(output).not.toContain('"$$slots"');
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
    /chunks\.mode = "split" or "bundler-runtime"/,
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
  "split mode emits flat-quality chunks with a working lazy runtime",
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
        "    return m;",
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
    expect(names.some((name) => /-lazy\.[0-9a-f]{8}\.js$/.test(name))).toBe(
      true,
    );

    const baseSource = await fs.readFile(
      result.outputFiles.find((file) => file.endsWith("main.js")),
      "utf8",
    );
    // No per-module registration wrappers: modules are scope-hoisted.
    expect(baseSource).not.toMatch(/__register\(/);
    expect(baseSource).toMatch(/gccImportLazy\(/);

    // Execute base + lazy chunk with a script-loader stub and verify the
    // compiled consumer resolves renamed exports across the chunk boundary.
    const { documentStub, locationStub, pendingScripts } =
      createScriptRuntimeStub();
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    try {
      globalThis.document = documentStub;
      globalThis.location = locationStub;
      const runFile = async (filePath) =>
        (0, eval)(await fs.readFile(filePath, "utf8"));
      await runFile(result.outputFiles.find((f) => f.endsWith("main.js")));
      const lazyPromise = globalThis["__loadFeature"]();
      for (const element of pendingScripts) {
        await runFile(
          path.join(fixture.outDir, path.basename(String(element.src))),
        );
        element.onload?.();
      }
      await lazyPromise;
      expect(documentStub.body.textContent).toBe("LAZY_FEATURE!");
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      delete globalThis["__loadFeature"];
    }
  },
);

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
  // emit ES5 bodies *with* import statements, and script/worker consumers
  // cannot load module output at all.
  for (const languageOut of ["ECMASCRIPT3", "ECMASCRIPT5"]) {
    expect(resolve({ languageOut, outputType: "esm" })).toBe("script");
  }
  for (const chunkMode of ["off", "split"]) {
    expect(resolve({ chunkMode, outputType: "esm" })).toBe("script");
  }
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

    // Loader properties that must survive: CSS coupling and the registry.
    expect(baseOutput).toContain('createElement("link")');
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
  "typed annotations reach the hoisted bundler-runtime input as JSDoc",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/widget.ts",
      [
        "export class Widget {",
        "  constructor() {",
        "    this.size = 1;",
        "  }",
        "}",
        "export function measure(widget) {",
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
      typedAnnotations: [
        {
          bindings: [
            { jsdoc: "/** @constructor */\n", name: "Widget" },
            {
              jsdoc:
                "/**\n * @param {!Widget} widget\n * @return {number}\n */\n",
              name: "measure",
            },
          ],
          filePath: path.join(fixture.srcDir, "widget.ts"),
        },
      ],
    });
    expect(result.ok).toBe(true);

    // Assert on the linked input Closure is handed, not on dist: ADVANCED
    // strips every comment, so the annotations are invisible downstream even
    // when they did their job.
    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const linkedFiles = await findFilesNamed(projectCacheDir, "main.linked.js");
    expect(linkedFiles.length).toBeGreaterThan(0);
    const linked = await fs.readFile(linkedFiles[0], "utf8");

    // Hoisting suffixes the bindings, so a naive name match would miss them.
    expect(linked).toMatch(/\/\*\* @constructor \*\/\s*\nclass Widget\$\$\d+/);
    expect(linked).toMatch(
      /@return \{number\}\n \*\/\nfunction measure\$\$\d+/,
    );
  },
);

test.serial(
  "typed annotations v2: member JSDoc lands inside the class and imported class types resolve",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/money.ts",
      [
        "export class Money {",
        '  unit = "eur";',
        "  constructor(minor) {",
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
        "function total(cash) {",
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
      typedAnnotations: [
        {
          bindings: [
            {
              jsdoc: "",
              members: [
                { jsdoc: "/** @type {number} */\n", name: "minor" },
                { jsdoc: "/** @type {string} */\n", name: "unit" },
              ],
              name: "Money",
            },
          ],
          filePath: path.join(fixture.srcDir, "money.ts"),
        },
        {
          bindings: [
            {
              // The checker names the imported class by the LOCAL alias; the
              // emitter routes it through the same map it rewrites code with.
              jsdoc: "/** @param {!Cash} cash @return {number} */\n",
              name: "total",
            },
            // Nothing named `Ghost` exists in either map, so this whole block
            // must be dropped rather than emitted against a stale name.
            {
              jsdoc: "/** @param {!Ghost} cash @return {number} */\n",
              name: "unused",
            },
          ],
          filePath: path.join(fixture.srcDir, "main.ts"),
        },
      ],
    });
    expect(result.ok).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const linkedFiles = await findFilesNamed(projectCacheDir, "main.linked.js");
    expect(linkedFiles.length).toBeGreaterThan(0);
    const linked = await fs.readFile(linkedFiles[0], "utf8");

    // Member blocks sit inside the class body, on the right member.
    expect(linked).toMatch(/\/\*\* @type \{string\} \*\/\n\s+unit = "eur";/);
    expect(linked).toMatch(/\/\*\* @type \{number\} \*\/\n\s+this\.minor = /);
    // The imported class resolves to the origin module's suffixed binding.
    expect(linked).toMatch(/@param \{!Money\$\$\d+\} cash/);
    expect(linked).not.toContain("Cash");
    // Unresolvable names drop the block, never the code.
    expect(linked).not.toContain("Ghost");
    expect(linked).toMatch(/function total\$\$\d+/);
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
  for (const chunkMode of ["off", "split"]) {
    expect(resolve({ chunkMode, vendorChunk: true })).toBe(false);
  }
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
    normalize({ mode: "bundler-runtime", outputType: "esm", vendorChunk: true }),
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
    normalize({ mode: "bundler-runtime", outputType: "esm", vendorChunk: false }),
  ).toBe(false);
  expect(normalize({ mode: "off" })).toBe(false);
  expect(normalize(undefined)).toBe(false);
});

/**
 * App entry + an eagerly imported node_modules dependency + a lazy chunk.
 * The dependency is what the vendor chunk is meant to carry out of the entry.
 */
async function writeVendorChunkFixture(fixture, appMarker, { lazy = true } = {}) {
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
      { chunks: { mode: "bundler-runtime", outputType: "script", vendorChunk: true }, label: "script output" },
      { chunks: { mode: "bundler-runtime", outputType: "esm", vendorChunk: false }, label: "vendorChunk: false" },
      // The default is now opt-in, so an untouched esm build has no vendor chunk.
      { chunks: { mode: "bundler-runtime", outputType: "esm" }, label: "vendorChunk default" },
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
