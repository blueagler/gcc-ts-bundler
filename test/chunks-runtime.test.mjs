import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import {
  createFixture,
  getProjectCacheDir,
  listDirectoryNames,
} from "./helpers.mjs";

test.serial(
  "emits smaller script chunks for explicit lazy modules",
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
      chunks: { mode: "bundler-runtime" },
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
    expect(baseOutput).toMatch(
      /(?:globalThis\.__g|[A-Za-z_$][\w$]*)\.n\(\[0\]\)/,
    );
    expect(baseOutput).not.toMatch(/LAZY_FEATURE/);
    expect(lazyOutput).toMatch(/LAZY_FEATURE/);
  },
);

test.serial(
  "emits bundler-runtime chunks for explicit lazy modules",
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
      chunks: { mode: "bundler-runtime" },
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
    expect(baseOutput).toMatch(
      /(?:globalThis\.__g|[A-Za-z_$][\w$]*)\.n\(\[0\]\)/,
    );
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
  },
);

test.serial(
  "bundler-runtime ES5 reuses the helper alias for lazy registration and base finalization",
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
    expect(baseOutput).toMatch(
      /\bvar _=[A-Za-z_$][\w$]*\._\|\|\([A-Za-z_$][\w$]*\._=\[\]\);/,
    );

    expect(lazyOutput).toContain("var G=globalThis.__g,_=G._;");
    expect(lazyOutput).toMatch(/G\.[A-Za-z_$][\w$]*\(function\(/);
    expect(lazyOutput).not.toContain("globalThis.__g.i(");
    expect(lazyOutput).not.toContain('globalThis["__g"].i(');
    expect(lazyOutput).not.toMatch(
      /(?:^|[;\n])\s*[A-Za-z_$][\w$]*=globalThis(?:\.__g|\["__g"\]);/m,
    );
  },
);

test.serial(
  "bundler-runtime rewrites property-protocol strings from the renaming report",
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

function createScriptRuntimeStub() {
  const pendingScripts = [];
  const documentStub = {
    body: { textContent: "" },
    createElement: () => ({}),
    head: {
      appendChild(element) {
        pendingScripts.push(element);
      },
    },
  };
  return { documentStub, pendingScripts };
}

test.serial(
  "split mode emits flat-quality chunks with a working lazy runtime",
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
    const { documentStub, pendingScripts } = createScriptRuntimeStub();
    const previousDocument = globalThis.document;
    try {
      globalThis.document = documentStub;
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
