import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, onTestFinished, test } from "bun:test";
import { RUNTIME_MODULE_ID } from "rolldown";
import { resolveConfig } from "vite";

import {
  getCapturedModuleAnalysis,
  normalizeRetainedCapturedModules,
  annotateAliasedStaticClassMemberWrites,
  demoteReassignedConstants,
  resolveViteCaptureRootPath,
  resolveCapturedModuleFormat,
} from "../../src/vite/capture/index.ts";
import {
  resolveNormalizedBridgeModuleIds,
  resolveRetainedCapturedModuleIds,
  resolveRetainedModuleIds,
} from "../../src/vite/graph/index.ts";
import { accountBarriers } from "../../src/externs/barriers.ts";
import { getCapturedSourceFile } from "../../src/vite/capture-analysis/index.ts";
import { resolveCompilerExterns } from "../../src/vite/compiler-externs/index.ts";
import {
  generateViteRuntimeAwareExterns,
  splitRuntimeModules,
} from "../../src/vite/compiler-externs/runtime.ts";
import { prepareViteWorkspace } from "../../src/vite/workspace.ts";
import { materializeCapturedGraph } from "../../src/vite/materialize/index.ts";
import { normalizeCapturedGraph } from "../../src/vite/plugin-graph/normalize.ts";
import { resolveViteAssetUrls } from "../../src/vite/output/asset-urls.ts";
import {
  createBuildMetrics,
  createTimingTotals,
} from "../../src/vite/plugin/metrics.ts";
import {
  finalizeBaseJsOutputName,
  renameCompiledNonBaseJsOutputs,
} from "../../src/vite/naming/index.ts";
import { createModuleParser } from "../../src/vite/prebundle/parse.ts";
import { extractRuntimeInitManifest } from "../../src/build/closure/runtime-manifest/init.ts";
import { parseGccRuntimeManifest } from "../../src/build/closure/runtime-manifest/parse.ts";
import { buildChunkModuleIdLookup } from "../../src/vite/chunk-modules.ts";
import { renameCompiledEmitOutputs } from "../../src/vite/plugin-compile/emit/rename.ts";
import {
  applyViteBuildGuards,
  createCompilerOptions,
  resolveViteLanguageOut,
  VITE_LANGUAGE_OUT_ERROR,
} from "../../src/vite/config.ts";
import { normalizeBuildOptions } from "../../src/build/resolve/options.ts";
import {
  createFixture,
  createExternFixture,
  execFileAsync,
  findFilesNamed,
  getProjectCacheDir,
  listDirectoryNames,
} from "../helpers.mjs";

function persistentViteCaptureDir(projectRoot, cacheDir = ".cache") {
  return path.join(
    getProjectCacheDir(path.resolve(projectRoot, cacheDir), projectRoot),
    "vite-capture",
  );
}

async function listFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(rootDir, entryPath);
      files.push(...nested);
      continue;
    }
    files.push(path.relative(rootDir, entryPath).replace(/\\/g, "/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildViteFixture(fixture, overrides = {}) {
  const pluginUrl = pathToFileURL(
    path.join(process.cwd(), "dist/vite/index.mjs"),
  ).href;
  const viteBin = path.join(
    process.cwd(),
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  await fixture.write(
    "vite.config.mjs",
    [
      `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
      ...(overrides.preambleLines ?? []),
      "",
      "export default {",
      ...(overrides.configLines ?? []),
      "  build: {",
      '    outDir: "dist",',
      '    target: "es2018",',
      ...(overrides.build?.cssCodeSplit === false
        ? ["    cssCodeSplit: false,"]
        : []),
      ...(overrides.buildLines ?? []),
      "  },",
      "  plugins: [",
      ...(overrides.pluginEntries ?? []),
      "    gccTsBundler({",
      "      compiler: {",
      `        cache: ${JSON.stringify(overrides.cache ?? { mode: "off" })},`,
      ...(overrides.compilerLines ?? []),
      "      },",
      ...(overrides.debugDir
        ? [
            "      debug: {",
            `        dumpCapturedGraphDir: ${JSON.stringify(overrides.debugDir)},`,
            "      },",
          ]
        : []),
      ...(overrides.pluginOptionLines ?? []),
      "    }),",
      ...(overrides.trailingPluginEntries ?? []),
      "  ],",
      "};",
      "",
    ].join("\n"),
  );

  return await execFileAsync(process.execPath, [viteBin, "build"], {
    cwd: fixture.projectRoot,
    env: {
      ...process.env,
      ...(overrides.env ?? {}),
    },
  });
}

test.serial(
  "gccTsBundler lowers finite computed module namespace calls",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/ops.js",
      [
        "export function initProps(value) { return `init:${value}`; }",
        "export function updateProps(value) { return `update:${value}`; }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import * as graphic from "./ops.js";',
        "const isInit = true;",
        'globalThis["__finiteNamespaceResult"] = graphic[isInit ? "initProps" : "updateProps"]("radar");',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      globalThis.location = { href: "http://vite.test/index.html" };
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?finite-namespace=${Date.now()}`
      );
      expect(globalThis["__finiteNamespaceResult"]).toBe("init:radar");
    } finally {
      delete globalThis["__finiteNamespaceResult"];
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
    }
  },
);

test.serial(
  "gccTsBundler lowers a finite local key in namespace constructor position",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/graphic.js",
      [
        "export class Circle { constructor(value) { this.value = `circle:${value}`; } }",
        "export class Arc { constructor(value) { this.value = `arc:${value}`; } }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import * as graphic from "./graphic.js";',
        'var shapeType = globalThis["__useCircle"] ? "Circle" : "Arc";',
        'globalThis["__finiteBoundNamespaceResult"] = new graphic[shapeType]("radius").value;',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    globalThis["__useCircle"] = true;
    try {
      globalThis.location = { href: "http://vite.test/index.html" };
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?finite-bound-namespace=${Date.now()}`
      );
      expect(globalThis["__finiteBoundNamespaceResult"]).toBe("circle:radius");
    } finally {
      delete globalThis["__useCircle"];
      delete globalThis["__finiteBoundNamespaceResult"];
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
    }
  },
);

test.serial(
  "named exports preserve namespace import values across Vite chunks",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/util.js",
      'export const answer = "namespace-ok";\n',
    );
    await fixture.write(
      "src/api.js",
      'import * as util from "./util.js"; export { util };\n',
    );
    await fixture.write(
      "src/main.js",
      [
        'import * as directUtil from "./util.js";',
        'import * as api from "./api.js";',
        'globalThis["__staticNamespaceReexport"] = api.util.answer;',
        'globalThis["__loadNamespace"] = () => import("./api.js").then(({ util }) => [util === directUtil, util.answer]);',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      globalThis.document = {
        createElement: () => ({}),
        head: { appendChild() {} },
        querySelectorAll: () => [],
      };
      globalThis.location = { href: "http://vite.test/index.html" };
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?namespace-reexport=${Date.now()}`
      );
      expect(globalThis["__staticNamespaceReexport"]).toBe("namespace-ok");
      expect(await globalThis["__loadNamespace"]()).toEqual([
        true,
        "namespace-ok",
      ]);
    } finally {
      delete globalThis["__loadNamespace"];
      delete globalThis["__staticNamespaceReexport"];
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
  "gccTsBundler reifies unprovable computed module namespace access",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/graphic.js",
      [
        "export class Line { constructor(value) { this.value = `line:${value}`; } }",
        "export class Rect { constructor(value) { this.value = `rect:${value}`; } }",
        "export class Unused { constructor() { throw new Error('retained'); } }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import * as graphic from "./graphic.js";',
        'const pointerOption = { type: globalThis["__pointerType"] };',
        'globalThis["__dynamicNamespaceResult"] = new graphic[pointerOption["type"]]("axis").value;',
        "",
      ].join("\n"),
    );

    globalThis["__pointerType"] = "Rect";
    try {
      const build = await buildViteFixture(fixture);
      const html = await fixture.read("dist/index.html");
      const entryScript = readRewrittenEntryScript(html);
      const previousLocation = globalThis.location;
      const previousRuntime = globalThis.__g;
      try {
        globalThis.location = { href: "http://vite.test/index.html" };
        delete globalThis.__g;
        await import(
          `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?dynamic-namespace=${Date.now()}`
        );
        expect(globalThis["__dynamicNamespaceResult"]).toBe("rect:axis");
      } finally {
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
        if (previousRuntime === undefined) delete globalThis.__g;
        else globalThis.__g = previousRuntime;
      }
      expect(build.stderr).toMatch(
        /gcc-ts-bundler: reified namespace .*graphic for dynamic member access at .*main\.js:graphic\[pointerOption(?:\$\$\d+)?\["type"\]\]/u,
      );
    } finally {
      delete globalThis["__pointerType"];
      delete globalThis["__dynamicNamespaceResult"];
    }
  },
);

test.serial(
  "gccTsBundler passes reified module namespaces to calls",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write("src/ops.js", "export const answer = 42;\n");
    await fixture.write(
      "src/main.js",
      [
        'import * as ops from "./ops.js";',
        'const read = (namespace) => namespace[globalThis["__answerKey"]];',
        'globalThis["__namespaceCallResult"] = read(ops);',
        "",
      ].join("\n"),
    );

    globalThis["__answerKey"] = "answer";
    try {
      await buildViteFixture(fixture);
      const html = await fixture.read("dist/index.html");
      const entryScript = readRewrittenEntryScript(html);
      const previousLocation = globalThis.location;
      const previousRuntime = globalThis.__g;
      try {
        globalThis.location = { href: "http://vite.test/index.html" };
        delete globalThis.__g;
        await import(
          `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?namespace-call=${Date.now()}`
        );
        expect(globalThis["__namespaceCallResult"]).toBe(42);
      } finally {
        if (previousLocation === undefined) delete globalThis.location;
        else globalThis.location = previousLocation;
        if (previousRuntime === undefined) delete globalThis.__g;
        else globalThis.__g = previousRuntime;
      }
    } finally {
      delete globalThis["__answerKey"];
      delete globalThis["__namespaceCallResult"];
    }
  },
);

test.serial(
  "gccTsBundler rejects mutation through a module namespace",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write("src/ops.js", "export let answer = 42;\n");
    await fixture.write(
      "src/main.js",
      'import * as ops from "./ops.js";\nops[globalThis["__answerKey"]] = 7;\n',
    );

    await expect(buildViteFixture(fixture)).rejects.toThrow(
      /cannot mutate a read-only module namespace/u,
    );
  },
);

function readRewrittenEntryScript(html) {
  // script mode emits `<script defer src>`; esm mode (the bundler-runtime
  // default) emits `<script type="module" crossorigin src>`.
  const match = html.match(
    /<script (?:defer|type="module" crossorigin) src="([^"]+)"><\/script>/u,
  );
  expect(match).toBeTruthy();
  return match[1];
}

function toDistRelativeFile(publicPath) {
  return publicPath.replace(/^\/+/u, "");
}

async function writeViteCssFixture(fixture) {
  await fixture.write(
    "index.html",
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "  </head>",
      "  <body>",
      '    <div id="app"></div>',
      '    <script type="module" src="/src/main.js"></script>',
      "  </body>",
      "</html>",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/main.js",
    [
      'import "./base.css";',
      'document.getElementById("app").innerHTML = "<button id=\\"load\\">Load</button>";',
      'globalThis["__loadFeature"] = () => import("./feature.js").then((module) => module.mount());',
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/feature.js",
    [
      'import "./feature.css";',
      "export function mount() {",
      '  const node = document.createElement("div");',
      '  node.className = "feature-panel";',
      '  node.textContent = "lazy feature";',
      "  document.body.appendChild(node);",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/base.css",
    ["body {", "  background: rgb(250, 250, 252);", "}", ""].join("\n"),
  );
  await fixture.write(
    "src/feature.css",
    [".feature-panel {", "  color: rgb(120, 40, 180);", "}", ""].join("\n"),
  );
}

async function readRuntimeModuleSourceMap(fixture, debugDir) {
  const source = await fixture.read(
    path.join(
      debugDir,
      "gcc-ts-bundler",
      ".gcc-ts-bundler-vite-runtime-module-sources.json",
    ),
  );
  return JSON.parse(source);
}

function createCapturePluginContext() {
  return {
    error(message) {
      throw new Error(String(message));
    },
    async resolve(specifier, importer) {
      if (specifier.startsWith(".")) {
        return {
          external: false,
          id: path.resolve(path.dirname(importer), specifier),
        };
      }
      return null;
    },
  };
}

test.serial(
  "Vite preserves an inline-script-produced global protocol",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "index.html",
      [
        '<div id="status">bootstrap-ready</div>',
        "<script>self.$_TSR={buffer:[]}</script>",
        '<script type="module" src="/src/main.js"></script>',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        "const tsr = window.$_TSR;",
        "tsr.t = new Map();",
        "tsr.buffer.forEach((script) => script());",
        "document.querySelector('#status').textContent = 'hydrated';",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read(path.join("dist", "index.html"));
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    expect(html).toContain("self.$_TSR={buffer:[]}");
    expect(mainJs).toContain("$_TSR");
    expect(mainJs).toContain("buffer");
  },
);

test.serial(
  "Vite preserves nested members reached through an external global alias",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "index.html",
      [
        '<div id="status">bootstrap-ready</div>',
        "<script>self.EXTERNAL_PROTOCOL={nestedState:{},items:[1,2]}</script>",
        '<script type="module" src="/src/main.js"></script>',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        "const globalAlias = window;",
        "const protocol = globalAlias.EXTERNAL_PROTOCOL;",
        "protocol.nestedState.assignedValue = 3;",
        "let total = 0;",
        "protocol.items.forEach((value) => { total += value; });",
        "document.querySelector('#status').textContent = `${protocol.nestedState.assignedValue}:${total}`;",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read(path.join("dist", "index.html"));
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    for (const property of [
      "EXTERNAL_PROTOCOL",
      "assignedValue",
      "items",
      "nestedState",
    ]) {
      expect(mainJs).toContain(property);
    }
  },
);

test.serial(
  "Vite keeps an in-graph global write and read renameable",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "index.html",
      [
        '<div id="status"></div>',
        '<script type="module" src="/src/main.js"></script>',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        "window.INTERNAL_PROTOCOL = { nestedState: { assignedValue: 4 } };",
        "Object.assign(window, { ASSIGNED_PROTOCOL: { assignedValue: 5 } });",
        "const protocol = window.INTERNAL_PROTOCOL;",
        "const assigned = window.ASSIGNED_PROTOCOL;",
        "document.querySelector('#status').textContent = String(protocol.nestedState.assignedValue + assigned.assignedValue);",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read(path.join("dist", "index.html"));
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    expect(mainJs).not.toContain("ASSIGNED_PROTOCOL");
    expect(mainJs).not.toContain("INTERNAL_PROTOCOL");
    expect(mainJs).not.toContain("assignedValue");
    expect(mainJs).not.toContain("nestedState");
  },
);

test.serial(
  "Vite keeps a five-property returned-object protocol linked after dependency graph partitioning",
  { timeout: 60000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", '{"type":"module"}\n');
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "index.html",
      [
        '<div id="status">pending</div>',
        '<script type="module" src="/src/main.js"></script>',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/returned-object-protocol/package.json",
      JSON.stringify({
        exports: "./consumer.js",
        name: "returned-object-protocol",
        type: "module",
        types: "./consumer.d.ts",
      }),
    );
    await fixture.write(
      "node_modules/returned-object-protocol/producer.js",
      [
        "export function createReactiveSystem() {",
        "  const link = (value) => `link:${value}`;",
        "  const unlink = (value) => `unlink:${value}`;",
        "  const propagate = (value) => `propagate:${value}`;",
        "  const checkDirty = (value) => `checkDirty:${value}`;",
        "  const shallowPropagate = (value) => `shallowPropagate:${value}`;",
        "  return { link, unlink, propagate, checkDirty, shallowPropagate };",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/returned-object-protocol/producer.d.ts",
      [
        "export interface ReactiveSystem {",
        "  link(value: number): string;",
        "  unlink(value: number): string;",
        "  propagate(value: number): string;",
        "  checkDirty(value: number): string;",
        "  shallowPropagate(value: number): string;",
        "}",
        "export declare function createReactiveSystem(): ReactiveSystem;",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/returned-object-protocol/consumer.js",
      [
        'import { createReactiveSystem } from "./producer.js";',
        "let link;",
        "let unlink;",
        "let propagate;",
        "let checkDirty;",
        "let shallowPropagate;",
        "({ link, unlink, propagate, checkDirty, shallowPropagate } = createReactiveSystem());",
        "export function runProtocol() {",
        "  return [link(1), unlink(2), propagate(3), checkDirty(4), shallowPropagate(5)].join('|');",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/returned-object-protocol/consumer.d.ts",
      "export declare function runProtocol(): string;\n",
    );

    await fixture.write(
      "node_modules/partition-filler/package.json",
      JSON.stringify({
        exports: "./index.js",
        name: "partition-filler",
        type: "module",
      }),
    );
    const fillerCount = 255;
    await Promise.all(
      Array.from({ length: fillerCount }, (_, index) =>
        fixture.write(
          `node_modules/partition-filler/filler-${index}.js`,
          `export const filler${index} = ${index};\n`,
        ),
      ),
    );
    await fixture.write(
      "node_modules/partition-filler/index.js",
      [
        ...Array.from(
          { length: fillerCount },
          (_, index) =>
            `import { filler${index} } from "./filler-${index}.js";`,
        ),
        `export const fillerTotal = ${Array.from(
          { length: fillerCount },
          (_, index) => `filler${index}`,
        ).join(" + ")};`,
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import { fillerTotal } from "partition-filler";',
        'import { runProtocol } from "returned-object-protocol";',
        "document.getElementById('status').textContent = `${runProtocol()}|${fillerTotal}`;",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const status = { textContent: "pending" };
    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      globalThis.document = { getElementById: () => status };
      globalThis.location = { href: "http://vite.test/index.html" };
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?returned-object=${Date.now()}`
      );
      expect(status.textContent).toBe(
        "link:1|unlink:2|propagate:3|checkDirty:4|shallowPropagate:5|32385",
      );
    } finally {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
    }
  },
);

test("aliased static write annotation preserves a declared binding TDZ", () => {
  const source = [
    "var _a;",
    "let C = (_a = class {}, _a.value = (() => C)(), _a);",
    "",
  ].join("\n");

  for (const candidate of [
    source,
    annotateAliasedStaticClassMemberWrites({
      id: "/src/main.js",
      code: source,
    }),
  ]) {
    expect(() => new Function(candidate)()).toThrow(ReferenceError);
  }
});

test("aliased static write annotation preserves throwing RHS binding state", () => {
  const source = [
    "var _a;",
    "let captured;",
    "let result;",
    "try {",
    '  let C = (_a = class {}, _a.value = (() => { captured = () => C; throw new Error("boom"); })(), _a);',
    "} catch (error) {",
    "  try {",
    '    captured(); result = { error: error.message, binding: "initialized" };',
    "  } catch (bindingError) {",
    "    result = { error: error.message, binding: bindingError.name };",
    "  }",
    "}",
    'globalThis["__throwingAliasedStaticWrite"] = result;',
    "",
  ].join("\n");
  const execute = (candidate) => {
    const runtimeGlobal = {};
    new Function("globalThis", candidate)(runtimeGlobal);
    return runtimeGlobal.__throwingAliasedStaticWrite;
  };

  const original = execute(source);
  const annotated = execute(
    annotateAliasedStaticClassMemberWrites({
      id: "/src/main.js",
      code: source,
    }),
  );
  expect(original).toEqual({ error: "boom", binding: "ReferenceError" });
  expect(annotated).toEqual(original);
});

test("captured module analysis ignores comment-only hash text for compat downlevel", () => {
  const record = {
    code: '/** @import { ComponentContext } from "#client" */\nexport { value } from "./dep.js";\n',
    id: "/virtual/comment.js",
  };

  const analysis = getCapturedModuleAnalysis(record);
  expect(analysis.needsClosureCompatibilityDownlevel).toBe(false);
  expect(analysis.needsTypeScriptCompatibilityDownlevel).toBe(false);
  expect(analysis.importSpecifiers).toEqual(["./dep.js"]);
});

test("emitted file URLs preserve underscores inside opaque host reference ids", async () => {
  const fixture = await createFixture();
  const id = path.join(fixture.srcDir, "entry.js");
  const referenceId = "a_b_c_d_e_f_g_h_i_j_k_";
  const fileName = "assets/image.svg";
  const context = {
    ...createCapturePluginContext(),
    getFileName(reference) {
      if (reference !== referenceId) throw new Error("Unknown emitted asset");
      return fileName;
    },
  };
  const normalized = await normalizeCapturedGraph.call(context, {
    bundle: {
      [fileName]: { type: "asset", fileName, source: "<svg/>" },
    },
    buildMetrics: createBuildMetrics(),
    capturedModules: new Map([
      [
        id,
        {
          id,
          code: `globalThis["__assetUrls"] = [
        import.meta.ROLLDOWN_FILE_URL_${referenceId},
        import.meta.ROLLDOWN_FILE_URL_${referenceId}_file_url,
        import.meta.ROLLUP_FILE_URL_${referenceId}
      ];`,
        },
      ],
    ]),
    initialModuleIds: [id],
    resolutionCache: new Map(),
    timingTotals: createTimingTotals(),
  });
  await fs.mkdir(fixture.outDir, { recursive: true });
  const outputJavaScript = path.join(fixture.outDir, "entry.js");
  await fs.writeFile(outputJavaScript, normalized.capturedModules.get(id).code);
  await resolveViteAssetUrls({
    assetPlaceholders: normalized.assetPlaceholders,
    chunkOutputType: "esm",
    config: await resolveConfig(
      {
        configFile: false,
        root: fixture.projectRoot,
        plugins: [
          {
            name: "host-asset-owner",
            resolveFileUrl: {
              order: "pre",
              handler({ urlId }) {
                return JSON.stringify(
                  urlId === "file_url"
                    ? "file:///image.svg"
                    : "/assets/image.svg",
                );
              },
            },
          },
        ],
      },
      "build",
    ),
    jsChunks: [],
    outDir: fixture.outDir,
    outputFiles: [outputJavaScript],
    outputOptions: { format: "es" },
    pluginContext: context,
  });
  const result = await execFileAsync(process.execPath, [
    "--eval",
    `await import(${JSON.stringify(pathToFileURL(outputJavaScript).href)}); console.log(JSON.stringify(globalThis.__assetUrls));`,
  ]);
  expect(JSON.parse(result.stdout)).toEqual([
    "/assets/image.svg",
    "file:///image.svg",
    "/assets/image.svg",
  ]);
});

test("only linker-owned runtime membership can omit a transformed capture", async () => {
  const entry = "/src/entry.js";
  const pluginModule = "\0rolldown/plugin.js";
  const missingAuthored = "/src/missing.js";
  const chunks = [
    {
      modules: {
        [entry]: {},
        [RUNTIME_MODULE_ID]: {},
        [pluginModule]: {},
        [missingAuthored]: {},
      },
    },
  ];
  const capturedModules = new Map([
    [entry, { id: entry, code: 'globalThis["__entryRan"] = true;' }],
  ]);
  const input = {
    capturedModules,
    metrics: undefined,
    projectRoot: "/src",
    resolutionCache: new Map(),
    unshakenModuleIds: [entry],
  };
  const retained = await resolveRetainedCapturedModuleIds.call(
    createCapturePluginContext(),
    { ...input, retainedModuleIds: resolveRetainedModuleIds(chunks, [entry]) },
  );
  expect(retained.materializedModuleIds).toEqual([entry]);
  expect(retained.missingModuleIds).toEqual(
    [pluginModule, missingAuthored].sort((left, right) =>
      left.localeCompare(right),
    ),
  );

  const explicitRuntime = await resolveRetainedCapturedModuleIds.call(
    createCapturePluginContext(),
    {
      ...input,
      retainedModuleIds: resolveRetainedModuleIds(chunks, [
        entry,
        RUNTIME_MODULE_ID,
      ]),
    },
  );
  expect(explicitRuntime.missingModuleIds).toContain(RUNTIME_MODULE_ID);
});

test("retained graph follows demanded names through impure, named, and star barrels", async () => {
  const entry = "/src/entry.js";
  const barrel = "/node_modules/pkg/index.js";
  const hook = "/node_modules/pkg/hook.js";
  const star = "/node_modules/pkg/star.js";
  const starLeaf = "/node_modules/pkg/star-leaf.js";
  const heavy = "/node_modules/pkg/heavy.js";
  const capturedModules = new Map(
    [
      [
        entry,
        'import { hiddenHook, starName } from "/node_modules/pkg/index.js";',
      ],
      [
        barrel,
        [
          '"use client";',
          'export { default as hiddenHook } from "./hook.js";',
          'export * from "./star.js";',
          'export { unused } from "./heavy.js";',
          "export const marker = 1;",
        ].join("\n"),
      ],
      [hook, "export default function hiddenHook() {}"],
      [star, 'export * from "./star-leaf.js";'],
      [starLeaf, "export const starName = 1;"],
      [heavy, "export const unused = 1;"],
    ].map(([id, code]) => [id, { code, id }]),
  );
  const context = createCapturePluginContext();
  context.resolve = async (specifier, importer) => ({
    external: false,
    id: specifier.startsWith("/")
      ? specifier
      : path.resolve(path.dirname(importer), specifier),
  });

  const kept = await resolveRetainedCapturedModuleIds.call(context, {
    capturedModules,
    metrics: undefined,
    projectRoot: "/src",
    resolutionCache: new Map(),
    retainedModuleIds: [entry, barrel, hook, star, starLeaf],
    unshakenModuleIds: [entry],
  });
  // Rollup kept the barrel, so it stays and keeps its `export *` reach. The
  // demanded names still travel to their leaves and `heavy` never enters,
  // because nothing demands `unused`.
  expect(kept.materializedModuleIds).toEqual(
    [barrel, hook, star, starLeaf, entry].sort(),
  );
  expect(kept.materializedModuleIds).not.toContain(heavy);

  const shaken = await resolveRetainedCapturedModuleIds.call(context, {
    capturedModules: new Map(
      [...capturedModules].map(([id, record]) => [
        id,
        { code: record.code, id },
      ]),
    ),
    metrics: undefined,
    projectRoot: "/src",
    resolutionCache: new Map(),
    retainedModuleIds: [entry, hook, starLeaf],
    unshakenModuleIds: [entry],
  });
  // Rollup erased the barrel and the star hop, so the entry has to name the
  // modules that declare the values, exactly as Rollup's bindings did.
  expect(shaken.materializedModuleIds).toEqual([entry, hook, starLeaf].sort());
});

test("retained bare package edges route to captured dependencies or fail with their chain", async () => {
  const entry = "/src/entry.js";
  const dependency = "/node_modules/react-is/index.js";
  const context = createCapturePluginContext();
  context.resolve = async (specifier) => ({
    external: false,
    id: specifier === "react-is" ? dependency : specifier,
  });
  const capturedModules = new Map([
    [
      entry,
      {
        code: 'import { isValidElementType } from "react-is"; console.log(isValidElementType);',
        id: entry,
      },
    ],
    [
      dependency,
      { code: "export const isValidElementType = () => true;", id: dependency },
    ],
  ]);
  const routed = await resolveRetainedCapturedModuleIds.call(context, {
    capturedModules,
    metrics: undefined,
    projectRoot: "/src",
    resolutionCache: new Map(),
    retainedModuleIds: [entry, dependency],
    unshakenModuleIds: [entry],
  });
  expect(routed.materializedModuleIds).toContain(dependency);

  await expect(
    resolveRetainedCapturedModuleIds.call(context, {
      capturedModules: new Map([[entry, capturedModules.get(entry)]]),
      metrics: undefined,
      projectRoot: "/src",
      resolutionCache: new Map(),
      retainedModuleIds: [entry],
      unshakenModuleIds: [entry],
    }),
  ).rejects.toThrow(`${entry} -> "react-is" -> ${dependency}`);
});

test("dead dynamic package edges are dropped when Vite did not capture the target", async () => {
  const entry = "/src/entry.js";
  const dependency = "/node_modules/dev-only-tool/index.js";
  const context = createCapturePluginContext();
  context.resolve = async (specifier) => ({
    external: false,
    id: specifier === "dev-only-tool" ? dependency : specifier,
  });
  const capturedModules = new Map([
    [
      entry,
      {
        code: 'if (import.meta.env.DEV) void import("dev-only-tool");',
        id: entry,
      },
    ],
  ]);
  const metrics = {
    deadDynamicEdgeDropCount: 0,
    normalizedRetainedModuleCount: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    reassignedConstantDemotionCount: 0,
    retainedEdgeResolutionCount: 0,
  };
  const routed = await resolveRetainedCapturedModuleIds.call(context, {
    capturedModules,
    metrics,
    projectRoot: "/src",
    resolutionCache: new Map(),
    retainedModuleIds: [entry],
    unshakenModuleIds: [entry],
  });
  expect(routed.materializedModuleIds).toContain(entry);
  expect(routed.materializedModuleIds).not.toContain(dependency);
  expect(metrics.deadDynamicEdgeDropCount).toBe(1);

  context.resolve = async () => null;
  const unresolvedMetrics = {
    deadDynamicEdgeDropCount: 0,
    normalizedRetainedModuleCount: 0,
    parseCacheHits: 0,
    parseCacheMisses: 0,
    reassignedConstantDemotionCount: 0,
    retainedEdgeResolutionCount: 0,
  };
  const unresolved = await resolveRetainedCapturedModuleIds.call(context, {
    capturedModules,
    metrics: unresolvedMetrics,
    projectRoot: "/src",
    resolutionCache: new Map(),
    retainedModuleIds: [entry],
    unshakenModuleIds: [entry],
  });
  expect(unresolved.materializedModuleIds).toContain(entry);
  expect(unresolved.materializedModuleIds).not.toContain(dependency);
  expect(unresolvedMetrics.deadDynamicEdgeDropCount).toBe(1);
});

test.serial(
  "generateBundle preserves Rollup chunk identities and manifest targets",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'document.querySelector("#app").textContent = "ready"; globalThis.loadLazyA = () => import("./lazy-a.js"); globalThis.loadLazyB = () => import("./lazy-b.js");\n',
    );
    await fixture.write("src/shared.js", 'export const value = "lazy";\n');
    await fixture.write(
      "src/lazy-a.js",
      'export { value } from "./shared.js";\n',
    );
    await fixture.write(
      "src/lazy-b.js",
      'export { value } from "./shared.js";\n',
    );
    await buildViteFixture(fixture, {
      buildLines: ["    manifest: true,"],
      preambleLines: ["const originalChunkNames = new Set();"],
      pluginEntries: [
        "    { name: 'capture-rollup-identities', enforce: 'post', generateBundle(_options, bundle) { for (const [key, value] of Object.entries(bundle)) if (value.type === 'chunk') { originalChunkNames.add(key); if (key !== value.fileName) throw new Error('chunk key mismatch before gcc'); } } },",
      ],
      trailingPluginEntries: [
        "    { name: 'verify-rollup-identities', enforce: 'post', generateBundle(_options, bundle) { const facades = []; for (const name of originalChunkNames) { const value = bundle[name]; if (!value || value.type !== 'chunk' || value.fileName !== name) throw new Error(`lost Rollup chunk identity: ${name}`); if (value.code.startsWith('export * from ')) facades.push(name); } this.emitFile({ type: 'asset', fileName: 'identity.json', source: JSON.stringify({ facades, names: [...originalChunkNames].sort() }) }); } },",
      ],
    });
    const identities = JSON.parse(await fixture.read("dist/identity.json"));
    expect(identities.names.length).toBeGreaterThan(2);
    // The plan mirrors Rollup's chunk graph one for one, so a chunk that still
    // carries code always owns its own compiled chunk. Only the shared chunk
    // degrades to a re-export facade here, and only because Closure copied its
    // one constant into both routes and pruning then removed the empty chunk.
    expect(
      identities.facades.filter((name) => !name.includes("shared")),
    ).toEqual([]);
    for (const fileName of identities.names) {
      expect(await fixture.read(path.join("dist", fileName))).toBeTruthy();
    }
    const manifest = JSON.parse(await fixture.read("dist/.vite/manifest.json"));
    const manifestFiles = new Set();
    for (const value of Object.values(manifest)) {
      if (typeof value.file === "string") manifestFiles.add(value.file);
      for (const field of ["css", "assets"]) {
        for (const file of value[field] ?? []) manifestFiles.add(file);
      }
    }
    for (const fileName of manifestFiles) {
      expect(await fixture.read(path.join("dist", fileName))).toBeTruthy();
    }
  },
);

test.serial(
  "the captured graph is a subgraph of Rollup's shaken module graph",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
    );
    // `barrel.js` re-exports both leaves, `main.js` reads only one of them, and
    // `unused-leaf.js` is reachable only through the name nobody reads. Rollup
    // shakes the barrel and that leaf out of existence, so neither may survive
    // in the captured graph either.
    await fixture.write(
      "src/main.js",
      [
        'import { used } from "./barrel.js";',
        'import { initDeadTail, kept } from "./mixed.js";',
        "initDeadTail();",
        'document.querySelector("#app").textContent = used + kept;',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/barrel.js",
      [
        'export { used } from "./used-leaf.js";',
        'export { unused } from "./unused-leaf.js";',
        "",
      ].join("\n"),
    );
    await fixture.write("src/used-leaf.js", 'export const used = "used";\n');
    await fixture.write(
      "src/unused-leaf.js",
      'import { deep } from "./deep-leaf.js";\nexport const unused = deep;\n',
    );
    await fixture.write("src/deep-leaf.js", 'export const deep = "deep";\n');
    await fixture.write(
      "src/mixed.js",
      [
        'import { helper } from "./helper-leaf.js";',
        'const kept = "kept";',
        "function initDeadTail() {",
        "  return;",
        '  const strandedStyle = { style: "red" };',
        "  function deadReader() { return strandedStyle.style; }",
        "}",
        "function shaken() {",
        "  return helper();",
        "}",
        "export { initDeadTail, kept, shaken };",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/helper-leaf.js",
      'export const helper = () => "helper";\n',
    );

    await buildViteFixture(fixture, {
      debugDir: ".gcc-capture",
      trailingPluginEntries: [
        "    { name: 'capture-retained-modules', enforce: 'post', generateBundle(_options, bundle) { const ids = new Set(); for (const value of Object.values(bundle)) if (value.type === 'chunk') for (const id of Object.keys(value.modules)) ids.add(id); this.emitFile({ type: 'asset', fileName: 'retained.json', source: JSON.stringify([...ids].sort()) }); } },",
      ],
    });

    const retained = new Set(
      JSON.parse(await fixture.read("dist/retained.json")).map((id) =>
        id.replace(/\\/g, "/"),
      ),
    );
    const authoredRetained = new Set(
      [...retained]
        .filter((id) => id.includes("/src/"))
        .map((id) => id.slice(id.lastIndexOf("/src/") + "/src/".length)),
    );
    expect(authoredRetained.has("used-leaf.js")).toBe(true);
    expect(authoredRetained.has("barrel.js")).toBe(false);
    expect(authoredRetained.has("unused-leaf.js")).toBe(false);

    const capturedSrcDir = path.join(
      fixture.projectRoot,
      ".gcc-capture",
      "gcc-ts-bundler",
      "src",
      "src",
    );
    const capturedFiles = await fs.readdir(capturedSrcDir);
    for (const fileName of capturedFiles) {
      if (!fileName.endsWith(".js")) continue;
      expect(authoredRetained.has(fileName)).toBe(true);
    }
    // The barrel is gone, so `main.js` has to name the leaf itself, and the
    // shaken export took its only import with it.
    const capturedMain = await fs.readFile(
      path.join(capturedSrcDir, "main.js"),
      "utf8",
    );
    expect(capturedMain).toContain("used-leaf");
    expect(capturedMain).not.toContain("barrel");
    const capturedMixed = await fs.readFile(
      path.join(capturedSrcDir, "mixed.js"),
      "utf8",
    );
    expect(capturedMixed).not.toContain("helper-leaf");
    expect(capturedMixed).not.toContain("strandedStyle");
    expect(capturedFiles).not.toContain("helper-leaf.js");
    expect(capturedFiles).not.toContain("deep-leaf.js");
  },
);

test.serial(
  "lazy ESM chunks keep mutable shared exports linked through the registry",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<div id="app"></div><script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/shared.js",
      [
        'export let characters = import.meta.env.VITE_CHUNK_MARKER || "initial";',
        "export function takeCharacters() {",
        "  const value = characters;",
        '  characters = "";',
        "  return value;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import { characters } from "./shared.js";',
        "globalThis.__initialCharacters = characters;",
        'globalThis.__loadCharacters = () => import("./lazy.js").then((module) => module.read());',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/lazy.js",
      [
        'import { takeCharacters } from "./shared.js";',
        "export function read() { return takeCharacters(); }",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, {
      buildLines: ['    target: "esnext",'],
      env: { VITE_CHUNK_MARKER: "linked" },
    });
    const files = await listFiles(path.join(fixture.projectRoot, "dist"));
    const scripts = files.filter((file) => file.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(1);
    const sources = await Promise.all(
      scripts.map((file) => fixture.read(path.join("dist", file))),
    );
    expect(sources.join("\n")).not.toContain("import.meta.env");
  },
);

test.serial(
  "materialized module parsing fails dependency routing closed on define and fused-distribution evidence",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "runtime.js",
      [
        "//#region package/a",
        "export const dev = process.env.NODE_ENV !== 'production' || __DEV__;",
        "//#endregion",
        "//#region package/b",
        "export const value = 1;",
        "//#endregion",
        "",
      ].join("\n"),
    );
    await fixture.write("clean.js", "export const value = 1;\n");
    const runtimeFile = path.join(fixture.projectRoot, "runtime.js");
    const cleanFile = path.join(fixture.projectRoot, "clean.js");
    const { parseModule } = createModuleParser({
      authoredFiles: new Set(),
      moduleFilePaths: new Set([runtimeFile, cleanFile]),
    });

    const fused = await parseModule(runtimeFile);
    expect(fused.hasDefineReferences).toBe(true);
    expect(fused.isFusedDistribution).toBe(true);

    const clean = await parseModule(cleanFile);
    expect(clean.hasDefineReferences).toBe(false);
    expect(clean.isFusedDistribution).toBe(false);
  },
);

test("capture observes package format changes between output invocations", async () => {
  const fixture = await createFixture();
  const packageFile = "node_modules/format-package/package.json";
  const record = {
    id: path.join(
      fixture.projectRoot,
      "node_modules/format-package/nested/side-effect.js",
    ),
    code: "console.log(42);",
  };
  await fixture.write(packageFile, JSON.stringify({ type: "commonjs" }));
  expect(await resolveCapturedModuleFormat(record, new Map())).toBe("cjs");
  await fixture.write(packageFile, JSON.stringify({ type: "module" }));
  expect(await resolveCapturedModuleFormat(record, new Map())).toBe("esm");
});

test("captured source parses stay on the capture record and do not leak metrics", () => {
  const metricsA = createBuildMetrics();
  const metricsB = createBuildMetrics();
  const recordA = {
    code: 'export const load = () => import("./first.js");',
    id: "/src/shared.js",
  };
  const recordB = { code: recordA.code, id: "/src/shared.js" };

  getCapturedSourceFile(recordA, recordA.code, metricsA);
  getCapturedSourceFile(recordA, recordA.code, metricsA);
  getCapturedSourceFile(recordB, recordB.code, metricsB);
  recordA.code = 'export const load = () => import("./second.js");';
  getCapturedSourceFile(recordA, recordA.code, metricsA);

  expect(getCapturedModuleAnalysis(recordA).dynamicImportSpecifiers).toEqual([
    "./second.js",
  ]);
  expect(getCapturedModuleAnalysis(recordB).dynamicImportSpecifiers).toEqual([
    "./first.js",
  ]);

  expect(metricsA.parseCacheMisses).toBe(2);
  expect(metricsA.parseCacheHits).toBe(1);
  expect(metricsB.parseCacheMisses).toBe(1);
  expect(metricsB.parseCacheHits).toBe(0);
});

test("fused dependency files are partitioned once under their contributing packages", async () => {
  globalThis.__gcc_current_module_url = pathToFileURL(
    path.join(process.cwd(), "dist/index.mjs"),
  ).href;
  const fixture = await createFixture();
  const fusedFile = path.join(fixture.projectRoot, "fused.js");
  const pkgAFile = path.join(fixture.projectRoot, "pkg-a.js");
  const pkgBFile = path.join(fixture.projectRoot, "pkg-b.js");
  const appFile = path.join(fixture.projectRoot, "app.js");
  await fs.writeFile(fusedFile, 'this["fusedKey"] = 1; this.fusedKey;\n');
  await fs.writeFile(pkgAFile, 'this["aOnly"] = 1; this.aOnly;\n');
  await fs.writeFile(pkgBFile, 'this["bOnly"] = 1; this.bOnly;\n');
  await fs.writeFile(appFile, "export const app = 1;\n");
  const materialized = {
    authoredFiles: [appFile],
    entries: [{ file: "./app.js", sourceModuleId: appFile }],
    modules: [
      {
        filePath: fusedFile,
        id: fusedFile,
        relativePath: "fused.js",
        sourceModuleIds: [
          path.join(fixture.projectRoot, "node_modules/pkg-a/fused.js"),
          path.join(fixture.projectRoot, "node_modules/pkg-b/fused.js"),
        ],
      },
      {
        filePath: pkgAFile,
        id: pkgAFile,
        relativePath: "pkg-a.js",
        sourceModuleIds: [
          path.join(fixture.projectRoot, "node_modules/pkg-a/index.js"),
        ],
      },
      {
        filePath: pkgBFile,
        id: pkgBFile,
        relativePath: "pkg-b.js",
        sourceModuleIds: [
          path.join(fixture.projectRoot, "node_modules/pkg-b/index.js"),
        ],
      },
      {
        filePath: appFile,
        id: appFile,
        relativePath: "app.js",
        sourceModuleIds: [path.join(fixture.srcDir, "main.js")],
      },
    ],
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: ["./app.js"],
    runtimeResolutions: [],
    srcDir: fixture.projectRoot,
  };
  const partitioned = splitRuntimeModules(materialized);
  expect(partitioned.appRuntimeFiles).toEqual([appFile]);
  expect([...partitioned.dependencyFilesByPackage.keys()].sort()).toEqual([
    "pkg-a",
    "pkg-a\0pkg-b",
    "pkg-b",
  ]);
  expect(partitioned.dependencyFilesByPackage.get("pkg-a")).toEqual([pkgAFile]);
  expect(partitioned.dependencyFilesByPackage.get("pkg-b")).toEqual([pkgBFile]);
  expect(partitioned.dependencyFilesByPackage.get("pkg-a\0pkg-b")).toEqual([
    fusedFile,
  ]);
  const generatedExternFile = path.join(
    fixture.projectRoot,
    "fused.externs.js",
  );
  await generateViteRuntimeAwareExterns({
    captureRoot: fixture.projectRoot,
    generatedExternFile,
    modules: ["pkg-a", "pkg-b"],
    options: { compiler: { cache: { mode: "off" } } },
    materialized,
    protocolHelpers: {
      keyExclusionListCallees: [],
      keyReadCallees: [],
    },
  });
  const externText = await fs.readFile(generatedExternFile, "utf8");
  expect(externText).toContain("Object.prototype.fusedKey;");
  expect(externText).toContain("Object.prototype.aOnly;");
  expect(externText).toContain("Object.prototype.bOnly;");
});

test("capture demotes only const bindings that the module writes", () => {
  const result = demoteReassignedConstants(
    [
      "const crudSchemas = reactive([]);",
      "const untouched = 1;",
      "const object = { value: 1 };",
      "const render = () => ($event) => crudSchemas = $event;",
      "object.value = 2;",
      "function shadow(crudSchemas) { crudSchemas = []; }",
    ].join("\n"),
  );

  expect(result.names).toEqual(["crudSchemas"]);
  expect(
    new Function(
      "reactive",
      `${result.code}\nrender()(42); return [crudSchemas, untouched, object.value];`,
    )((value) => value),
  ).toEqual([42, 1, 2]);
});

test.serial(
  "Vite chunk hoists registry requires above earlier namespace uses",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write("src/dep.js", "export const value = 42;\n");
    await fixture.write(
      "src/main.js",
      [
        "const namespace = {};",
        "Object.assign(namespace, dep);",
        'import * as dep from "./dep.js";',
        "globalThis.result = namespace.value;",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture);
    const sources = await Promise.all(
      (await listFiles(path.join(fixture.projectRoot, "dist")))
        .filter((file) => file.endsWith(".js"))
        .map((file) => fixture.read(path.join("dist", file))),
    );
    expect(sources.join("\n")).toContain("result");
  },
);

test.serial(
  "resolveNormalizedBridgeModuleIds follows bridge imports introduced by compat normalization",
  async () => {
    const fixture = await createFixture();
    const entryId = path.join(fixture.projectRoot, "src", "entry.js");
    const depId = path.join(fixture.projectRoot, "src", "dep.js");
    const capturedModules = new Map([
      [
        entryId,
        {
          code: [
            'export { dep } from "./dep.js";',
            "class Widget {",
            "  static {",
            "    this.ready = true;",
            "  }",
            "}",
            "",
          ].join("\n"),
          id: entryId,
        },
      ],
      [
        depId,
        {
          code: 'export const dep = "dep";\n',
          id: depId,
        },
      ],
    ]);

    const normalizedCapturedModules = await normalizeRetainedCapturedModules({
      capturedModules,
      moduleIds: [entryId],
    });
    const additionalBridgeModuleIds =
      await resolveNormalizedBridgeModuleIds.call(
        createCapturePluginContext(),
        {
          capturedModules,
          normalizedCapturedModules,
          resolutionCache: new Map(),
          retainedModuleIds: [entryId],
        },
      );

    expect(additionalBridgeModuleIds).toContain(depId);
  },
);

test.serial(
  "Vite resolveFileUrl honors order-pre hooks before earlier normal hooks",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'import url from "virtual:ordered-asset"; globalThis["__orderedAssetUrl"] = url;\n',
    );
    await buildViteFixture(fixture, {
      compilerLines: ['        chunks: { outputType: "script" },'],
      pluginEntries: [
        `{
          name: "ordinary-asset-owner",
          resolveId(id) {
            return id === "virtual:ordered-asset" ? "\\0virtual:ordered-asset" : null;
          },
          load(id) {
            if (id !== "\\0virtual:ordered-asset") return null;
            const referenceId = this.emitFile({
              type: "asset",
              fileName: "asset.svg",
              source: "<svg/>",
            });
            return "export default import.meta.ROLLUP_FILE_URL_" + referenceId + ";";
          },
          resolveFileUrl({ fileName }) {
            return fileName === "asset.svg" ? JSON.stringify("/wrong.svg") : null;
          },
        },`,
        `{
          name: "preferred-asset-owner",
          resolveFileUrl: {
            order: "pre",
            handler({ fileName }) {
              return fileName === "asset.svg" ? JSON.stringify("/correct.svg") : null;
            },
          },
        },`,
      ],
    });

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const source = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    const runtimeGlobal = { location: new URL("http://example.test/") };
    new Function("globalThis", source)(runtimeGlobal);
    expect(runtimeGlobal.__orderedAssetUrl).toBe("/correct.svg");
  },
);

test.serial(
  "Vite applies host defines to optional chains while preserving shadowed identifiers and literals",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      ".env.production",
      "VITE_GCC_DEFINE_CDN=https://cdn.example\n",
    );
    await fixture.write(
      "src/main.js",
      [
        "function readShadowed(feature) { return feature?.enabled; }",
        'globalThis["__definedValues"] = [',
        "  feature?.enabled,",
        "  readShadowed({ enabled: 33 }),",
        '  "feature.enabled",',
        "  settings.label,",
        "  import.meta.env.MODE,",
        "  import.meta.env.VITE_GCC_DEFINE_CDN,",
        "  import.meta.env.OVERRIDE,",
        "  import.meta.env.GCC_MISSING_DEFINE,",
        "];",
        "",
      ].join("\n"),
    );
    await buildViteFixture(fixture, {
      compilerLines: ['        chunks: { outputType: "script" },'],
      configLines: [
        `  define: ${JSON.stringify({
          "feature.enabled": false,
          settings: { label: "configured" },
          "import.meta.env.OVERRIDE": JSON.stringify("user"),
        })},`,
      ],
    });

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const source = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    const runtimeGlobal = { location: new URL("http://example.test/") };
    new Function("globalThis", source)(runtimeGlobal);
    expect(runtimeGlobal.__definedValues).toEqual([
      false,
      33,
      "feature.enabled",
      "configured",
      "production",
      "https://cdn.example",
      "user",
      undefined,
    ]);
  },
);

test.serial(
  "gccTsBundler resolves Vite asset and public placeholders before final output hashing",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      [
        'import logo from "./logo.svg";',
        'globalThis.__viteAssetUrls = [logo, new URL("/public-logo.svg", import.meta.url).href];',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>A</text></svg>\n',
    );
    await fixture.write(
      "public/public-logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    );

    const build = () =>
      buildViteFixture(fixture, {
        buildLines: [
          "    assetsInlineLimit: 0,",
          '    rollupOptions: { output: { entryFileNames: "scripts/[name]-[hash].js" } },',
        ],
        configLines: ['  base: "./",'],
      });

    await build();
    const firstFiles = await listFiles(fixture.outDir);
    const firstJsFile = firstFiles.find((filePath) => filePath.endsWith(".js"));
    const firstLogoFile = firstFiles.find(
      (filePath) =>
        filePath.startsWith("assets/logo-") && filePath.endsWith(".svg"),
    );
    expect(firstJsFile).toMatch(/^scripts\/.+\.js$/u);
    expect(firstLogoFile).toBeTruthy();
    const firstSource = await fixture.read(path.join("dist", firstJsFile));
    expect(firstSource).not.toContain("__VITE_ASSET__");
    expect(firstSource).not.toContain("__VITE_PUBLIC_ASSET__");
    expect(firstSource).toContain(`../${firstLogoFile}`);
    expect(firstSource).toContain("../public-logo.svg");

    await fixture.write(
      "src/logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>B</text></svg>\n',
    );
    await build();
    const secondFiles = await listFiles(fixture.outDir);
    const secondJsFile = secondFiles.find((filePath) =>
      filePath.endsWith(".js"),
    );
    expect(secondJsFile).toMatch(/^scripts\/.+\.js$/u);
    expect(secondJsFile).not.toBe(firstJsFile);
    const secondSource = await fixture.read(path.join("dist", secondJsFile));
    expect(secondSource).not.toContain("__VITE_ASSET__");
    expect(secondSource).not.toContain("__VITE_PUBLIC_ASSET__");
  },
);

test.serial(
  "gccTsBundler rejects multiple distinct HTML entry facades",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/a.js"></script>\n',
    );
    await fixture.write(
      "pages/b.html",
      '<script type="module" src="../src/b.js"></script>\n',
    );
    await fixture.write("src/a.js", "globalThis.__pageA = true;\n");
    await fixture.write("src/b.js", "globalThis.__pageB = true;\n");

    await expect(
      buildViteFixture(fixture, {
        buildLines: [
          '    rollupOptions: { input: { a: "index.html", b: "pages/b.html" } },',
        ],
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "does not yet support multiple distinct HTML entry facades",
      ),
    });
  },
);

test.serial(
  "gccTsBundler makes relative-base entry URLs relative to each HTML asset",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "pages/app.html",
      '<script type="module" src="../src/main.js"></script>\n',
    );
    await fixture.write("src/main.js", 'document.body.textContent = "ok";\n');

    await buildViteFixture(fixture, {
      buildLines: ['    rollupOptions: { input: "pages/app.html" },'],
      configLines: ['  base: "./",'],
    });

    const html = await fixture.read("dist/pages/app.html");
    const entryScript = readRewrittenEntryScript(html);
    expect(entryScript).toMatch(/^\.\.\/assets\/.+\.js$/u);
    expect(
      (await listFiles(fixture.outDir)).includes(
        path.posix.normalize(`pages/${entryScript}`),
      ),
    ).toBe(true);
  },
);

test.serial(
  "gccTsBundler removes only Rollup chunks and preserves JavaScript assets",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write("src/main.js", 'document.body.textContent = "ok";\n');

    await buildViteFixture(fixture, {
      pluginEntries: ["    emitJavaScriptAsset,"],
      preambleLines: [
        "const emitJavaScriptAsset = {",
        '  name: "emit-javascript-asset",',
        "  buildStart() {",
        "    this.emitFile({",
        '      type: "asset",',
        '      fileName: "extras/keep.js",',
        '      source: "globalThis.__keepAsset = true;\\n",',
        "    });",
        "  },",
        "};",
      ],
    });

    expect(await fixture.read("dist/extras/keep.js")).toContain("__keepAsset");
  },
);

test.serial(
  "gccTsBundler recognizes local named default exports in dependency metadata",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'import * as ns from "pkg"; globalThis.__nsDefault = ns.default;\n',
    );
    await fixture.write(
      "node_modules/pkg/package.json",
      '{"name":"pkg","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    );
    await fixture.write(
      "node_modules/pkg/index.js",
      'const value = "EXPECTED_DEFAULT"; export { value as default };\n',
    );

    await buildViteFixture(fixture);

    const jsFile = (await listFiles(fixture.outDir)).find((filePath) =>
      filePath.endsWith(".js"),
    );
    expect(jsFile).toBeTruthy();
    expect(await fixture.read(path.join("dist", jsFile))).toContain(
      "EXPECTED_DEFAULT",
    );
  },
);

test.serial(
  "full Vite pipeline preserves aliased static writes read through superclass this",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      [
        "class Base {",
        "  static read() { return this.value; }",
        "}",
        "var _a;",
        'let Derived = (_a = class extends Base {}, _a.value = "retained", _a);',
        'globalThis["__aliasedStaticWrite"] = Base.read.call(Derived);',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, {
      compilerLines: ['        chunks: { outputType: "script" },'],
    });

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const source = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    const runtimeGlobal = { location: new URL("http://example.test/") };
    new Function("globalThis", source)(runtimeGlobal);
    expect(runtimeGlobal.__aliasedStaticWrite).toBe("retained");
  },
);

test.serial(
  "vendor chunk keeps virtual modules with authored dependencies in the base chunk",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'import { bridged } from "virtual:bridge"; globalThis.__vendorVirtual = bridged;\n',
    );
    await fixture.write("src/value.js", 'export const value = "APP_VALUE";\n');

    await buildViteFixture(fixture, {
      compilerLines: ['        chunks: { outputType: "esm" },'],
      pluginEntries: ["    virtualBridge,"],
      preambleLines: [
        "const virtualBridge = {",
        '  name: "virtual-bridge",',
        "  resolveId(id) {",
        '    return id === "virtual:bridge" ? "\\0virtual:bridge" : null;',
        "  },",
        "  load(id) {",
        '    if (id === "\\0virtual:bridge") return \'import { value } from "/src/value.js"; export const bridged = value;\';',
        "  },",
        "};",
      ],
    });

    const jsFiles = (await listFiles(fixture.outDir)).filter((filePath) =>
      filePath.endsWith(".js"),
    );
    expect(jsFiles).toHaveLength(1);
    expect(await fixture.read(path.join("dist", jsFiles[0]))).toContain(
      "APP_VALUE",
    );
  },
);

test.serial(
  "lazy dependency roots receive dependency prebundle compatibility lowering",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'globalThis.__loadPrivate = () => import("pkg").then((module) => module.read());\n',
    );
    await fixture.write(
      "node_modules/pkg/package.json",
      '{"name":"pkg","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    );
    await fixture.write(
      "node_modules/pkg/index.js",
      [
        "class Box {",
        "  #value = 7;",
        "  read() { return this.#value; }",
        "}",
        "export function read() { return new Box().read(); }",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, { configLines: ['  base: "./",'] });

    const jsFiles = (await listFiles(fixture.outDir)).filter((filePath) =>
      filePath.endsWith(".js"),
    );
    expect(jsFiles.length).toBeGreaterThan(1);
    const sources = await Promise.all(
      jsFiles.map((filePath) => fixture.read(path.join("dist", filePath))),
    );
    expect(sources.join("\n")).not.toContain("#value");
  },
);

test.serial(
  "gccTsBundler bridges legacy Closure targets through Vite's capture floor",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      "const add = (left, right) => left + right; globalThis.__legacy = add(2, 3);\n",
    );

    await buildViteFixture(fixture, {
      buildLines: ['    target: "es5",'],
    });

    const html = await fixture.read("dist/index.html");
    expect(html).toContain('<script type="module" crossorigin');
    expect(html).not.toContain("<script defer src=");
    const jsFile = (await listFiles(fixture.outDir)).find((filePath) =>
      filePath.endsWith(".js"),
    );
    const source = await fixture.read(path.join("dist", jsFile));
    expect(source).not.toContain("=>");
    expect(source).not.toMatch(/\b(?:const|let)\b/u);
  },
);

test.serial(
  "gccTsBundler wires lazy Vite CSS through the runtime when cssCodeSplit is enabled",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture);

    const files = await listFiles(fixture.outDir);
    const cssFiles = files.filter((filePath) => filePath.endsWith(".css"));
    expect(cssFiles.length).toBeGreaterThan(1);

    const html = await fixture.read("dist/index.html");
    expect(html).not.toContain('rel="modulepreload"');
    const entryScript = readRewrittenEntryScript(html);
    expect(entryScript).toMatch(/^\/assets\/.+\.js$/u);
    expect(files).toContain(toDistRelativeFile(entryScript));

    const linkedCss = cssFiles.filter((fileName) => html.includes(fileName));
    expect(linkedCss.length).toBeGreaterThan(0);
    const lazyCss = cssFiles.find((fileName) => !html.includes(fileName));
    expect(lazyCss).toBeTruthy();

    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    expect(mainJs).toContain(lazyCss);
    expect(mainJs).toContain("globalThis.__g");
    expect(mainJs).not.toContain("if(!r||!r.k");

    const runtimeManifest = extractRuntimeInitManifest(mainJs).manifest;
    expect(Array.isArray(runtimeManifest)).toBe(true);
    const runtimeRows = runtimeManifest[1];
    expect(Array.isArray(runtimeRows)).toBe(true);
    const baseRow = runtimeRows.find(
      (entry) => Array.isArray(entry) && entry[1] === "",
    );
    expect(baseRow?.[2]).toEqual([]);
    const lazyRow = runtimeRows.find(
      (entry) =>
        Array.isArray(entry) &&
        Array.isArray(entry[2]) &&
        entry[2].includes(lazyCss),
    );
    expect(lazyRow?.[2]).toEqual([lazyCss]);

    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousLoadFeature = globalThis.__loadFeature;
    const loadedCss = [];
    const mountedNodes = [];
    const events = [];
    const appendChild = (node) => {
      if (node.rel === "stylesheet") {
        loadedCss.push(node.href);
        queueMicrotask(() => {
          events.push("css");
          node.onload?.();
        });
      } else {
        events.push("mount");
        mountedNodes.push(node);
      }
      return node;
    };
    try {
      globalThis.document = {
        body: { appendChild },
        createElement: () => ({}),
        documentElement: { appendChild },
        getElementById: () => ({}),
        head: { appendChild },
        querySelectorAll: () =>
          linkedCss.map((fileName) => ({
            href: new URL(fileName, "http://vite.test/").toString(),
          })),
      };
      globalThis.location = { href: "http://vite.test/index.html" };
      // A runtime root left on globalThis by a concurrently-running test file
      // carries that build's module registry, so this bundle would look up its
      // own module ids in a stranger's table and fail with `m<id>`.
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?css=${Date.now()}`
      );
      expect(typeof globalThis.__loadFeature).toBe("function");
      await globalThis.__loadFeature();
      expect(loadedCss).toHaveLength(1);
      expect(loadedCss[0]?.endsWith(`/${lazyCss}`)).toBe(true);
      expect(events).toEqual(["css", "mount"]);
      expect(mountedNodes).toContainEqual(
        expect.objectContaining({
          className: "feature-panel",
          textContent: "lazy feature",
        }),
      );
    } finally {
      if (previousDocument === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previousDocument;
      }
      if (previousLocation === undefined) {
        delete globalThis.location;
      } else {
        globalThis.location = previousLocation;
      }
      if (previousRuntime === undefined) {
        delete globalThis.__g;
      } else {
        globalThis.__g = previousRuntime;
      }
      if (previousLoadFeature === undefined) {
        delete globalThis.__loadFeature;
      } else {
        globalThis.__loadFeature = previousLoadFeature;
      }
    }
  },
);

test.serial(
  "gccTsBundler keeps eager Vite CSS when cssCodeSplit is disabled",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      build: {
        cssCodeSplit: false,
      },
    });

    const files = await listFiles(fixture.outDir);
    const cssFiles = files.filter((filePath) => filePath.endsWith(".css"));
    expect(cssFiles).toHaveLength(1);

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    expect(mainJs).not.toContain(cssFiles[0]);
  },
);

test.serial(
  "gccTsBundler materializes only retained Rollup modules from the final chunk graph",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      [
        "<!doctype html>",
        '<html lang="en">',
        "  <body>",
        '    <script type="module" src="/src/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.js",
      [
        'import { alive } from "./entry.js";',
        "document.body.textContent = alive;",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.js",
      [
        'export { alive } from "./alive.js";',
        'export { dead } from "./dead.js";',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/alive.js",
      ['export const alive = "alive";', ""].join("\n"),
    );
    await fixture.write(
      "src/dead.js",
      [
        'export const dead = "dead";',
        'export function deadBranch() { return "tree-shaken"; }',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, {
      debugDir: ".gcc-debug",
    });

    const runtimeModuleSourceMap = await readRuntimeModuleSourceMap(
      fixture,
      ".gcc-debug",
    );
    const runtimeModuleFiles = Object.values(runtimeModuleSourceMap).join("\n");
    expect(runtimeModuleFiles).toContain("/src/main.js");
    expect(runtimeModuleFiles).toContain("/src/alive.js");
    expect(runtimeModuleFiles).not.toContain("/src/dead.js");
    // `entry.js` only forwards `alive`, so the binding now comes straight from
    // the module that declares it and the barrel itself has no reader left -
    // which is exactly what Rollup's own binding resolution did.
    expect(runtimeModuleFiles).not.toContain("/src/entry.js");

    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const mainJs = await fixture.read(
      path.join("dist", toDistRelativeFile(entryScript)),
    );
    expect(mainJs).not.toContain("tree-shaken");
  },
);

test.serial(
  "gccTsBundler follows Vite entry and chunk naming config",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      buildLines: [
        "    rollupOptions: {",
        "      output: {",
        '        entryFileNames: "entry/[name]-[hash].js",',
        '        chunkFileNames: "chunks/[name]-[hash].js",',
        "      },",
        "    },",
      ],
    });

    const files = await listFiles(fixture.outDir);
    const jsFiles = files.filter((filePath) => filePath.endsWith(".js"));
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);

    expect(entryScript).toMatch(/^\/entry\/.+\.js$/u);
    expect(files).toContain(toDistRelativeFile(entryScript));
    expect(jsFiles.some((filePath) => filePath.startsWith("chunks/"))).toBe(
      true,
    );
    expect(jsFiles).not.toContain("main.js");
    for (const filePath of jsFiles) {
      const source = await fixture.read(path.join("dist", filePath));
      for (const match of source.matchAll(/(["'`])(\.[^"'`]+\.js)\1/gu)) {
        expect(files).toContain(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(filePath), match[2]),
          ),
        );
      }
    }
  },
);

test.serial(
  "materialization rewrites warmed captured imports across source and virtual identities",
  async () => {
    const fixture = await createFixture();
    await fixture.write("package.json", JSON.stringify({ type: "module" }));
    const ids = [
      "main.js",
      "main.jsx",
      "main.ts",
      "main.tsx",
      "component.vue?vue&type=script&lang.ts",
    ].map((name) => path.join(fixture.projectRoot, "src", name));
    ids.push("\0virtual:captured-entry");
    const targets = new Map(
      ["static", "forwarded", "lazy"].map((name) => [
        `./${name}.ts`,
        path.join(fixture.projectRoot, "src", `${name}.ts`),
      ]),
    );
    const capturedModules = new Map(
      ids.map((id) => [
        id,
        {
          id,
          code: [
            'import { value } from "./static.ts";',
            'export { value as forwarded } from "./forwarded.ts";',
            'export const load = () => import("./lazy.ts");',
            "export const initial = value;",
          ].join("\n"),
        },
      ]),
    );
    for (const [specifier, id] of targets) {
      capturedModules.set(id, {
        id,
        code: `export const value = ${JSON.stringify(specifier)};`,
      });
    }
    for (const record of capturedModules.values()) {
      getCapturedSourceFile(record, record.code);
    }
    const materialized = await materializeCapturedGraph.call(
      {
        ...createCapturePluginContext(),
        async resolve(specifier) {
          return { id: targets.get(specifier), external: false };
        },
      },
      {
        capturedModules,
        config: { root: fixture.projectRoot },
        dynamicRootModuleIds: [targets.get("./lazy.ts")],
        entryModuleIds: ids,
        nativeDefines: undefined,
        resolutionCache: new Map(),
        moduleIds: [...capturedModules.keys()],
        srcDir: path.join(fixture.projectRoot, ".gcc-debug", "src"),
      },
    );
    for (const id of ids) {
      const module = materialized.modules.find(
        (candidate) => candidate.id === id,
      );
      const emitted = await import(pathToFileURL(module.filePath).href);
      expect(emitted.initial).toBe("./static.ts");
      expect(emitted.forwarded).toBe("./forwarded.ts");
      expect((await emitted.load()).value).toBe("./lazy.ts");
    }
  },
);

test.serial(
  "materializeCapturedGraph preserves pruning boundaries for empty, dynamic, and CSS side-effect stubs",
  async () => {
    const fixture = await createFixture();
    const srcDir = path.join(fixture.projectRoot, ".gcc-debug", "src");
    const mainId = path.join(fixture.projectRoot, "src", "main.js");
    const emptyId = path.join(fixture.projectRoot, "src", "empty.ts");
    const lazyId = path.join(fixture.projectRoot, "src", "lazy.js");
    const styleId = path.join(fixture.projectRoot, "src", "style.js");
    const capturedModules = new Map([
      [
        mainId,
        {
          code: [
            'import "./empty.ts";',
            'export const loadLazy = () => import("./lazy.js");',
            'import "./style.js";',
            "",
          ].join("\n"),
          id: mainId,
        },
      ],
      [
        emptyId,
        {
          code: "export {};\n",
          id: emptyId,
        },
      ],
      [
        lazyId,
        {
          code: "export {};\n",
          id: lazyId,
        },
      ],
      [
        styleId,
        {
          code: 'import "./style.css";\nexport {};\n',
          id: styleId,
        },
      ],
    ]);

    const materialized = await materializeCapturedGraph.call(
      createCapturePluginContext(),
      {
        capturedModules,
        config: { root: fixture.projectRoot },
        dynamicRootModuleIds: [lazyId],
        entryModuleIds: [mainId],
        nativeDefines: undefined,
        resolutionCache: new Map(),
        moduleIds: [mainId, emptyId, lazyId, styleId],
        srcDir,
      },
    );

    expect(materialized.retainedEmptyModuleIds).toContain(emptyId);
    expect(materialized.retainedEmptyModuleIds).toContain(lazyId);
    expect(materialized.retainedEmptyModuleIds).not.toContain(styleId);
    expect(materialized.prunedEmptyModuleIds).toContain(emptyId);
    expect(materialized.prunedEmptyModuleIds).not.toContain(lazyId);
    expect(materialized.prunedEmptyModuleIds).not.toContain(styleId);
    expect(materialized.modules.map((module) => module.id)).not.toContain(
      emptyId,
    );
    expect(materialized.modules.map((module) => module.id)).toEqual(
      expect.arrayContaining([lazyId, styleId]),
    );
    expect(materialized.runtimeEntries.join("\n")).not.toContain("empty");

    const rewrittenMain = await fixture.read(
      path.relative(
        fixture.projectRoot,
        materialized.modules.find((module) => module.id === mainId).filePath,
      ),
    );
    expect(rewrittenMain).not.toContain("empty.ts");
    expect(rewrittenMain).toContain('import("./lazy.js")');
    expect(rewrittenMain).toContain('import "./style.js"');
  },
);

test.serial(
  "Vite es2020 keeps Unicode property escapes in a dependency chunk",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "node_modules/property-regex/package.json",
      JSON.stringify({
        name: "property-regex",
        type: "module",
        version: "1.0.0",
      }),
    );
    await fixture.write(
      "node_modules/property-regex/index.js",
      "export const isIdeographPair = (value) => /^\\p{Unified_Ideograph}{2}$/u.test(value);\n",
    );
    await fixture.write(
      "src/main.js",
      'import { isIdeographPair } from "property-regex"; globalThis["__regexResult"] = isIdeographPair("漢字");\n',
    );

    await buildViteFixture(fixture, {
      buildLines: [
        '    target: "es2020",',
        '    rollupOptions: { output: { manualChunks: (id) => id.includes("property-regex") ? "dependency" : undefined } },',
      ],
    });
    const outputs = await listFiles(path.join(fixture.projectRoot, "dist"));
    expect(outputs.some((file) => /dependency.*\.js$/u.test(file))).toBe(true);

    await expect(
      buildViteFixture(fixture, {
        buildLines: [
          '    target: "es2015",',
          '    rollupOptions: { output: { manualChunks: (id) => id.includes("property-regex") ? "dependency" : undefined } },',
        ],
      }),
    ).rejects.toThrow(
      /dependency\.linked\.js[\s\S]*RegExp unicode property escape[\s\S]*ECMASCRIPT_2018/u,
    );
  },
);

test("resolveViteLanguageOut derives compiler output from Vite build.target", () => {
  expect(
    resolveViteLanguageOut({
      build: { target: false },
    }),
  ).toBe("ECMASCRIPT_NEXT");
  expect(
    resolveViteLanguageOut({
      build: { target: "esnext" },
    }),
  ).toBe("ECMASCRIPT_NEXT");
  expect(
    resolveViteLanguageOut({
      build: { target: "es5" },
    }),
  ).toBe("ECMASCRIPT5");
  expect(
    resolveViteLanguageOut({
      build: { target: "baseline-widely-available" },
    }),
  ).toBe("ECMASCRIPT_2021");
  expect(
    resolveViteLanguageOut({
      build: { target: "es2020" },
    }),
  ).toBe("ECMASCRIPT_2020");
  expect(
    resolveViteLanguageOut({
      build: { target: "chrome87" },
    }),
  ).toBe("ECMASCRIPT_2021");
  expect(
    resolveViteLanguageOut({
      build: { target: ["es2020", "chrome64"] },
    }),
  ).toBe("ECMASCRIPT_2018");
  expect(
    resolveViteLanguageOut({
      build: { target: ["es2020", "es5"] },
    }),
  ).toBe("ECMASCRIPT5");
});

test("resolveViteLanguageOut rejects unsupported target strings", () => {
  expect(() =>
    resolveViteLanguageOut({
      build: { target: "last 2 versions" },
    }),
  ).toThrow(/could not derive a compiler output level/);
});

test("Vite separates legacy capture targets and treats explicit auto as omission", () => {
  expect(applyViteBuildGuards({ build: { target: "es3" } }).build.target).toBe(
    "es2015",
  );
  expect(applyViteBuildGuards({ build: { target: "es5" } }).build.target).toBe(
    "es2015",
  );
  expect(
    applyViteBuildGuards({ build: { target: "es2018" } }).build.target,
  ).toBeUndefined();

  const baseInput = {
    config: { build: { target: "es2018" } },
    entries: ["./main.js"],
    externs: [],
    manifestFile: "manifest.json",
    outDir: "/tmp/dist",
    projectRoot: "/tmp/project",
    publicPath: "/",
    srcDir: "/tmp/project/src",
  };
  const resolve = (chunks) =>
    normalizeBuildOptions(
      createCompilerOptions({
        ...baseInput,
        options: { compiler: { chunks } },
      }),
    ).chunks;
  const omitted = resolve({});
  const explicitAuto = resolve({ outputType: "auto" });

  expect(omitted.outputType).toBe("esm");
  expect(explicitAuto.outputType).toBe("esm");
  expect(omitted.vendorChunk).toBe(false);
  expect(explicitAuto.vendorChunk).toBe(false);
});

test("resolveViteCaptureRootPath is deterministic for identical inputs", () => {
  const input = {
    config: {
      base: "/",
      build: {
        assetsDir: "assets",
        cssCodeSplit: true,
        minify: "esbuild",
        target: "esnext",
      },
      mode: "production",
      root: "/tmp/demo",
    },
    options: {
      compiler: {
        compilationLevel: "ADVANCED",
      },
      externs: {
        generate: {
          mode: "runtime-aware",
          modules: ["pkg"],
        },
      },
    },
    projectRoot: "/tmp/demo",
  };

  const captureRoot = resolveViteCaptureRootPath(input);
  expect(captureRoot).toBe(resolveViteCaptureRootPath(input));
  expect(
    captureRoot.startsWith(`${path.resolve("/tmp/demo")}${path.sep}`),
  ).toBe(false);
  expect(path.basename(path.dirname(captureRoot))).toBe("vite-capture");
});

test("resolveViteCaptureRootPath uses the specified persistent cache.dir", () => {
  const input = {
    config: {
      base: "/",
      build: {
        assetsDir: "assets",
        cssCodeSplit: true,
        minify: "esbuild",
        target: "esnext",
      },
      mode: "production",
      root: "/tmp/demo",
    },
    options: {
      compiler: {
        cache: { dir: ".cache", mode: "persistent" },
        compilationLevel: "ADVANCED",
      },
    },
    projectRoot: "/tmp/demo",
  };

  const captureRoot = resolveViteCaptureRootPath(input);
  expect(captureRoot.startsWith(path.resolve("/tmp/demo", ".cache"))).toBe(
    true,
  );
  expect(path.basename(path.dirname(captureRoot))).toBe("vite-capture");
});

test("resolveViteCaptureRootPath changes when material build identity changes", () => {
  const baseInput = {
    config: {
      base: "/",
      build: {
        assetsDir: "assets",
        cssCodeSplit: true,
        minify: "esbuild",
        target: "esnext",
      },
      mode: "production",
      root: "/tmp/demo",
    },
    options: {
      compiler: {
        compilationLevel: "ADVANCED",
      },
    },
    projectRoot: "/tmp/demo",
  };

  expect(
    resolveViteCaptureRootPath({
      ...baseInput,
      config: {
        ...baseInput.config,
        build: {
          ...baseInput.config.build,
          target: "es2018",
        },
      },
    }),
  ).not.toBe(resolveViteCaptureRootPath(baseInput));
});

test("Vite debug workspace cleanup preserves caller-owned directory contents", async () => {
  const fixture = await createFixture();
  await fixture.write("debug/notes.txt", "caller-owned\n");
  const input = {
    config: {},
    debugDir: "debug",
    options: { compiler: { cache: { mode: "off" } } },
    projectRoot: fixture.projectRoot,
  };
  const first = await prepareViteWorkspace(input);
  try {
    await fs.writeFile(
      path.join(first.captureRoot, "obsolete.js"),
      "old build",
    );
  } finally {
    await first.dispose();
  }
  const second = await prepareViteWorkspace(input);
  try {
    expect(await fixture.read("debug/notes.txt")).toBe("caller-owned\n");
    expect(await fs.readdir(second.captureRoot)).not.toContain("obsolete.js");
  } finally {
    await second.dispose();
  }
});

test.serial(
  "gccTsBundler does not write .gcc-ts-bundler-vite into the project without persistent cache",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);
    await buildViteFixture(fixture);

    expect(
      await listDirectoryNames(
        path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"),
      ),
    ).toEqual([]);
  },
);

test.serial(
  "one Vite watcher recovers from worker rejection with current imports and exports",
  { timeout: 60000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/stable.js",
      'export const kept = "kept";\nexport const restored = "restored";\n',
    );
    await fixture.write("src/worker.js", 'self.postMessage("worker");\n');
    await fixture.write(
      "src/removed.js",
      'globalThis["__removedModuleRan"] = true;\n',
    );
    const initialMain =
      'import "./removed.js"; import { kept } from "./stable.js"; globalThis["__watchResult"] = kept;\n';
    const workerMain =
      'import Worker from "./worker.js?worker"; import { kept } from "./stable.js"; globalThis["__watchResult"] = kept; globalThis["__worker"] = Worker;\n';
    const recoveredMain =
      'import { restored } from "./stable.js"; globalThis["__watchResult"] = restored;\n';
    await fixture.write("src/main.js", initialMain);
    const viteUrl = pathToFileURL(
      path.join(process.cwd(), "node_modules/vite/dist/node/index.js"),
    ).href;
    const pluginUrl = pathToFileURL(
      path.join(process.cwd(), "dist/vite/index.mjs"),
    ).href;
    await fixture.write(
      "watch.mjs",
      `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from ${JSON.stringify(viteUrl)};
import { gccTsBundler } from ${JSON.stringify(pluginUrl)};

const plugin = gccTsBundler({
  compiler: { cache: { mode: "persistent", dir: ".cache" } },
  report: { file: "watch-report.json" },
});
const watcher = await build({
  configFile: false,
  root: process.cwd(),
  logLevel: "silent",
  build: {
    outDir: "dist",
    target: "es2018",
    modulePreload: false,
    watch: {},
  },
  plugins: [plugin],
});
let phase = 0;
let buildError;
let queue = Promise.resolve();
const observed = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("watch sequence timed out")), 45000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    watcher.on("event", (event) => {
      queue = queue.then(async () => {
        if (event.code === "START") buildError = undefined;
        if (event.code === "ERROR") buildError = event.error;
        if (event.code !== "END") return;
        if (phase === 1) {
          assert.match(String(buildError), /does not support worker entry graphs/);
          phase = 2;
          await fs.writeFile("src/main.js", ${JSON.stringify(recoveredMain)});
          return;
        }
        if (buildError) throw buildError;
        const html = await fs.readFile("dist/index.html", "utf8");
        const script = html.match(/<script[^>]*src="([^"]+)"/)?.[1];
        assert.ok(script, "successful build has an entry script");
        globalThis.location = { href: "http://vite.test/index.html" };
        delete globalThis.__g;
        await import(pathToFileURL(path.resolve("dist", script.replace(/^\\//, ""))).href + "?phase=" + phase);
        observed.push(globalThis.__watchResult);
        if (phase === 0) {
          assert.equal(globalThis.__watchResult, "kept");
          phase = 1;
          await fs.writeFile("src/main.js", ${JSON.stringify(workerMain)});
          return;
        }
        assert.equal(globalThis.__watchResult, "restored");
        const report = JSON.parse(await fs.readFile("watch-report.json", "utf8"));
        assert.equal(report.modules.deadModules.some((module) => module.id === "src/removed.js"), false);
        await fs.writeFile("watch-result.json", JSON.stringify(observed));
        clearTimeout(timer);
        resolve();
      }).catch(fail);
    });
  });
} finally {
  await watcher.close();
}
`,
    );
    await execFileAsync(
      process.execPath,
      [path.join(fixture.projectRoot, "watch.mjs")],
      { cwd: fixture.projectRoot, timeout: 55000 },
    );
    expect(JSON.parse(await fixture.read("watch-result.json"))).toEqual([
      "kept",
      "restored",
    ]);
  },
);

test.serial(
  "gccTsBundler reuses captured inputs and preserves published assets on identical cached builds",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });
    const firstFiles = await listFiles(fixture.outDir);
    const firstContents = await Promise.all(
      firstFiles.map((file) => fixture.read(path.join("dist", file))),
    );
    const second = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    expect(
      await listDirectoryNames(persistentViteCaptureDir(fixture.projectRoot)),
    ).toHaveLength(1);
    expect(
      await listDirectoryNames(
        path.join(fixture.projectRoot, ".gcc-ts-bundler-vite"),
      ).catch(() => []),
    ).toEqual([]);
    expect(await listFiles(fixture.outDir)).toEqual(firstFiles);
    expect(
      await Promise.all(
        firstFiles.map((file) => fixture.read(path.join("dist", file))),
      ),
    ).toEqual(firstContents);
    expect(second.stderr).not.toContain(
      "[gcc-ts-bundler timing] closure:compile:",
    );
    expect(second.stderr).not.toContain(
      "[gcc-ts-bundler timing] native-emit:transpile:",
    );
  },
);
test.serial(
  "Vite delivers unified metadata and type-only edits invalidate caches",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<!doctype html><script type="module" src="/src/main.ts"></script>\n',
    );
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import type { Config } from "./types";',
        "function label(config: Config): string { return config.label; }",
        'document.body.textContent = label({ label: "ok" });',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/types.ts",
      "export interface Config { label: string; optional?: string }\n",
    );
    const options = {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    };

    const first = await buildViteFixture(fixture, options);
    expect(first.stderr).toMatch(
      /closure:type-metadata-job: metadata=true .*inference=true/u,
    );
    expect(first.stderr).toMatch(
      /\[gcc-ts-bundler timing\] closure:platform-externs: bytes=\d+ metadata=true/u,
    );

    await fixture.write(
      "src/types.ts",
      "export interface Config { label: string; optional?: number }\n",
    );
    const rebuilt = await buildViteFixture(fixture, options);
    expect(rebuilt.stderr).toContain(
      "[gcc-ts-bundler timing] cache:native-emit: miss",
    );
    expect(rebuilt.stderr).toContain(
      "[gcc-ts-bundler timing] closure:compile:",
    );
  },
);

test.serial(
  "Vite routes typed extern declarations to Closure but not native preservation",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<!doctype html><script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/main.js",
      'globalThis["__typedExternRead"] = externalValue.typedOnly;\n',
    );
    await fixture.write(
      "barrier.externs.js",
      "/** @externs */\nObject.prototype.barrierOnly;\n",
    );
    await fixture.write(
      "typed.externs.js",
      [
        "/** @externs */",
        "/** @constructor */",
        "function ExternalThing() {}",
        "/** @type {string} */",
        "ExternalThing.prototype.typedOnly;",
        "/** @type {!ExternalThing} */",
        "var externalValue;",
        "",
      ].join("\n"),
    );

    const built = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      compilerLines: [
        '        externs: ["./barrier.externs.js"],',
        '        typedExterns: ["./typed.externs.js"],',
      ],
      env: { GCC_BUILD_TIMINGS: "1" },
    });
    expect(built.stderr).toContain(
      "[gcc-ts-bundler timing] native-emit:extern-preserved-properties: 1",
    );

    const [nativeExtern] = await findFilesNamed(
      path.join(fixture.projectRoot, ".cache"),
      "native-generated.externs.js",
    );
    expect(nativeExtern).toBeTruthy();
    const nativeExternText = await fs.readFile(nativeExtern, "utf8");
    expect(nativeExternText).toContain("barrierOnly");
    expect(nativeExternText).not.toContain("typedOnly");
  },
);

test.serial(
  "Vite escape hatch removes optional metadata, inference, and typed platform slicing",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<!doctype html><script type="module" src="/src/main.ts"></script>\n',
    );
    await fixture.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ESNext",
        },
        include: ["src"],
      }),
    );
    await fixture.write(
      "src/main.ts",
      [
        "enum Mode { Active = 1 }",
        "function select(value: number): Mode { void value; return Mode.Active; }",
        'globalThis["__mode"] = select(1);',
        "",
      ].join("\n"),
    );

    const built = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: {
        GCC_BUILD_TIMINGS: "1",
        GCC_DISABLE_TYPE_INFERENCE: "1",
      },
    });
    expect(built.stderr).toMatch(
      /closure:type-metadata-job: metadata=false .*inference=false/u,
    );
    expect(built.stderr).not.toContain(
      "[gcc-ts-bundler timing] closure:platform-externs: bytes=",
    );

    const metadataFiles = (
      await findFilesNamed(
        path.join(fixture.projectRoot, ".cache"),
        "meta.json",
      )
    ).filter((filePath) =>
      filePath.includes(`${path.sep}native-emit${path.sep}`),
    );
    expect(metadataFiles.length).toBeGreaterThan(0);
    const nativeMetadata = JSON.parse(
      await fs.readFile(metadataFiles[0], "utf8"),
    );
    const delivered = nativeMetadata.typeMetadata.reduce(
      (counts, file) => ({
        annotationCount: counts.annotationCount + file.counts.annotationCount,
        enumDeclarationCount:
          counts.enumDeclarationCount + file.counts.enumDeclarationCount,
        memberAnnotationCount:
          counts.memberAnnotationCount + file.counts.memberAnnotationCount,
        typeDeclarationCount:
          counts.typeDeclarationCount + file.counts.typeDeclarationCount,
      }),
      {
        annotationCount: 0,
        enumDeclarationCount: 0,
        memberAnnotationCount: 0,
        typeDeclarationCount: 0,
      },
    );
    expect(delivered.enumDeclarationCount).toBe(0);
    expect(delivered.annotationCount).toBe(0);
    expect(delivered.memberAnnotationCount).toBe(0);
    expect(delivered.typeDeclarationCount).toBe(0);
  },
);

test.serial(
  "gccTsBundler restores current chunk ownership when the capture root is deleted",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);
    const options = {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    };

    await buildViteFixture(fixture, options);
    const firstFiles = await listFiles(fixture.outDir);
    const firstContents = await Promise.all(
      firstFiles.map((file) => fixture.read(path.join("dist", file))),
    );
    await fs.rm(persistentViteCaptureDir(fixture.projectRoot), {
      force: true,
      recursive: true,
    });
    await buildViteFixture(fixture, options);

    expect(await listFiles(fixture.outDir)).toEqual(firstFiles);
    expect(
      await Promise.all(
        firstFiles.map((file) => fixture.read(path.join("dist", file))),
      ),
    ).toEqual(firstContents);
  },
);

test.serial(
  "gccTsBundler republishes deleted assets from the immutable build cache",
  { timeout: 20000 },
  async () => {
    const fixture = await createFixture();
    await writeViteCssFixture(fixture);

    await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    const firstFiles = await listFiles(fixture.outDir);
    const firstContents = await Promise.all(
      firstFiles.map((file) => fixture.read(path.join("dist", file))),
    );
    await fs.rm(fixture.outDir, { force: true, recursive: true });

    const restored = await buildViteFixture(fixture, {
      cache: { dir: ".cache", mode: "persistent" },
      env: { GCC_BUILD_TIMINGS: "1" },
    });

    expect(await listFiles(fixture.outDir)).toEqual(firstFiles);
    expect(
      await Promise.all(
        firstFiles.map((file) => fixture.read(path.join("dist", file))),
      ),
    ).toEqual(firstContents);
    expect(restored.stderr).not.toContain(
      "[gcc-ts-bundler timing] closure:compile:",
    );
  },
);

test.serial(
  "gccTsBundler rejects compiler.languageOut in Vite mode with an actionable error",
  async () => {
    const fixture = await createFixture();
    const pluginUrl = pathToFileURL(
      path.join(process.cwd(), "dist/vite/index.mjs"),
    ).href;
    const viteBin = path.join(
      process.cwd(),
      "node_modules",
      "vite",
      "bin",
      "vite.js",
    );
    await fixture.write(
      "index.html",
      [
        "<!doctype html>",
        "<html>",
        "  <body>",
        '    <script type="module" src="/src/main.js"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    );
    await fixture.write("src/main.js", 'console.log("vite");\n');
    await fixture.write(
      "vite.config.mjs",
      [
        `import { gccTsBundler } from ${JSON.stringify(pluginUrl)};`,
        "",
        "export default {",
        "  plugins: [",
        "    gccTsBundler({",
        "      compiler: {",
        '        languageOut: "ECMASCRIPT5",',
        "      },",
        "    }),",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );

    await expect(
      execFileAsync(process.execPath, [viteBin, "build"], {
        cwd: fixture.projectRoot,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(VITE_LANGUAGE_OUT_ERROR),
    });
  },
);

// --- chunk naming ---------------------------------------------------------
//
// These exercise src/vite/naming.ts directly with a hand-built compiled-output
// directory: two chunks, a base and one lazy chunk, wired the way Closure
// emits them for each chunk output type.

const NAMING_OUTPUT_OPTIONS = {
  chunkFileNames: "assets/[name]-[hash].js",
  entryFileNames: "assets/[name]-[hash].js",
  format: "es",
};

async function createNamingWorkspace(input) {
  const outDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "gcc-ts-bundler-naming-"),
  );
  onTestFinished(async () => {
    await fs.rm(outDir, { force: true, recursive: true });
  });

  const baseChunkId = input.baseChunkId ?? "main";
  const manifestFilePath = path.join(outDir, "manifest.json");
  // The vendor chunk is deliberately just another manifest row: the base
  // chunk depends on it, it depends on nothing, and naming treats it like any
  // other non-base chunk.
  const hasVendor = input.vendorSource !== undefined;
  await fs.writeFile(
    manifestFilePath,
    JSON.stringify({
      baseChunk: baseChunkId,
      chunks: {
        lazy: { css: [], deps: [baseChunkId], modules: [], url: "/lazy.js" },
        [baseChunkId]: {
          css: [],
          deps: hasVendor ? ["vendor"] : [],
          modules: [],
          url: "/main.js",
        },
        ...(hasVendor
          ? { vendor: { css: [], deps: [], modules: [], url: "/vendor.js" } }
          : {}),
      },
      loader: "script",
      modules: {},
      publicPath: "/",
    }),
    "utf8",
  );
  await fs.writeFile(path.join(outDir, "main.js"), input.baseSource, "utf8");
  await fs.writeFile(path.join(outDir, "lazy.js"), input.lazySource, "utf8");
  if (hasVendor) {
    await fs.writeFile(
      path.join(outDir, "vendor.js"),
      input.vendorSource,
      "utf8",
    );
  }

  return {
    manifestFilePath,
    outDir,
    outputFiles: [
      path.join(outDir, "main.js"),
      path.join(outDir, "lazy.js"),
      ...(hasVendor ? [path.join(outDir, "vendor.js")] : []),
    ],
  };
}

async function runNamingPasses(workspace, chunkOutputType) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(workspace.manifestFilePath, "utf8"),
    workspace.manifestFilePath,
  );
  // Direct naming is also used without a native source-map sidecar.
  const chunkModuleIds = buildChunkModuleIdLookup({
    jsChunks: [],
    manifest,
    runtimeModuleIdToOriginalIds: new Map(),
  });
  const renamed = await renameCompiledNonBaseJsOutputs({
    baseChunkName: "main",
    chunkOutputType,
    chunkModuleIds,
    dynamicRootModuleIds: [],
    jsChunks: [],
    manifest,
    manifestFilePath: workspace.manifestFilePath,
    outDir: workspace.outDir,
    outputFiles: workspace.outputFiles,
    outputOptions: NAMING_OUTPUT_OPTIONS,
    publicPath: "/",
  });
  const finalized = await finalizeBaseJsOutputName({
    baseChunkFilePath: renamed.baseChunkFilePath,
    baseSeed: renamed.baseSeed,
    chunkOutputType,
    deferredChunkSeeds: renamed.deferredChunkSeeds,
    emittedOutputFiles: renamed.emittedOutputFiles,
    manifest,
    manifestFilePath: workspace.manifestFilePath,
    outDir: workspace.outDir,
    outputOptions: NAMING_OUTPUT_OPTIONS,
    publicPath: "/",
  });
  const emitted = finalized.emittedOutputFiles.map((filePath) =>
    path.relative(workspace.outDir, filePath).replace(/\\/g, "/"),
  );
  return {
    baseScriptFileName: finalized.baseScriptFileName,
    emitted,
    manifest,
    read: (relativePath) =>
      fs.readFile(path.join(workspace.outDir, relativePath), "utf8"),
  };
}

const ESM_BASE_SOURCE =
  'var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"./lazy.js",[]]],[0,1],"/assets/"]);export{r};\n';
const ESM_LAZY_SOURCE = 'import{r}from"./main.js";r.u(1);\n';

test("compiled emit fails closed on malformed native source maps", async () => {
  const workspace = await createNamingWorkspace({
    baseSource: ESM_BASE_SOURCE,
    lazySource: ESM_LAZY_SOURCE,
  });
  const runtimeModuleSourceMapFilePath = path.join(
    workspace.outDir,
    "sources.json",
  );
  const input = {
    compiled: {
      chunkOutputType: "esm",
      compiledCoreOutputs: {
        finalOutDir: workspace.outDir,
        outputFiles: workspace.outputFiles,
      },
      cssOwnership: { enabled: false },
      dynamicRootModuleIds: [],
      jsChunks: [],
      manifestFilePath: workspace.manifestFilePath,
      materialized: { modules: [] },
      publicPath: "/",
      runtimeModuleSourceMapFilePath,
    },
    options: {},
    outputOptions: NAMING_OUTPUT_OPTIONS,
    timingTotals: createTimingTotals(),
  };
  await fs.writeFile(runtimeModuleSourceMapFilePath, "{broken", "utf8");
  await expect(renameCompiledEmitOutputs(input)).rejects.toThrow(SyntaxError);
  await fs.writeFile(runtimeModuleSourceMapFilePath, '{"runtime":42}', "utf8");
  await expect(renameCompiledEmitOutputs(input)).rejects.toThrow(TypeError);
});

test("esm chunk naming hashes every chunk and rewrites import specifiers", async () => {
  const workspace = await createNamingWorkspace({
    baseSource: ESM_BASE_SOURCE,
    lazySource: ESM_LAZY_SOURCE,
  });
  const result = await runNamingPasses(workspace, "esm");

  const baseFileName = result.baseScriptFileName;
  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  expect(baseFileName).toMatch(/^assets\/main-[\w-]{8}\.js$/u);
  expect(lazyFileName).toMatch(/^assets\/shared-lazy-[\w-]{8}\.js$/u);
  expect(result.emitted.sort()).toEqual([baseFileName, lazyFileName].sort());

  // The lazy chunk imports the base chunk under its final hashed name, and the
  // base chunk's runtime manifest points at the lazy chunk's final name.
  const lazySource = await result.read(lazyFileName);
  expect(lazySource).toContain(`"./${path.posix.basename(baseFileName)}"`);
  expect(lazySource).not.toContain('"./main.js"');
  const baseSource = await result.read(baseFileName);
  expect(baseSource).toContain(`"./${path.posix.basename(lazyFileName)}"`);
  expect(baseSource).not.toContain('"./lazy.js"');
  expect(result.manifest.chunks.main.url).toBe(`/${baseFileName}`);
});

test("esm chunk naming resolves the base chunk under its compiler chunk id", async () => {
  // Closure names every output after its chunk id and the pipeline renames the
  // base chunk on the way out, so siblings still import `./<chunkId>.js`.
  const workspace = await createNamingWorkspace({
    baseChunkId: "c0abc",
    baseSource: ESM_BASE_SOURCE,
    lazySource: 'import{r}from"./c0abc.js";r.u(1);\n',
  });
  const result = await runNamingPasses(workspace, "esm");

  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  const lazySource = await result.read(lazyFileName);
  expect(lazySource).toContain(
    `"./${path.posix.basename(result.baseScriptFileName)}"`,
  );
  expect(lazySource).not.toContain('"./c0abc.js"');
});

test("esm chunk naming rehashes dependents when a referenced chunk changes", async () => {
  const first = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_SOURCE,
      lazySource: ESM_LAZY_SOURCE,
    }),
    "esm",
  );
  const second = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_SOURCE.replace(
        "export{r}",
        "console.log(1);export{r}",
      ),
      lazySource: ESM_LAZY_SOURCE,
    }),
    "esm",
  );

  // The lazy chunk's own bytes are unchanged, but it embeds the base chunk's
  // name: without folding the reference closure into the hash it would keep a
  // stale name while its shipped bytes changed.
  expect(second.baseScriptFileName).not.toBe(first.baseScriptFileName);
  expect(second.manifest.chunks.lazy.url).not.toBe(
    first.manifest.chunks.lazy.url,
  );
});

const ESM_VENDOR_SOURCE = "export var dep=1;\n";
const ESM_BASE_WITH_VENDOR_SOURCE =
  'import{dep}from"./vendor.js";var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"./vendor.js",[]],[[0],"./lazy.js",[]]],[0,1,2],"/assets/"]);export{r};\n';

test("esm chunk naming rewrites base-dependency import specifiers", async () => {
  const workspace = await createNamingWorkspace({
    baseSource: ESM_BASE_WITH_VENDOR_SOURCE,
    lazySource: ESM_LAZY_SOURCE,
    vendorSource: ESM_VENDOR_SOURCE,
  });
  const result = await runNamingPasses(workspace, "esm");

  const vendorFileName = toDistRelativeFile(result.manifest.chunks.vendor.url);
  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  expect(result.emitted.sort()).toEqual(
    [result.baseScriptFileName, lazyFileName, vendorFileName].sort(),
  );

  // The base chunk's import of a chunk it depends on is rewritten to the final
  // hashed name, exactly like the manifest urls of the lazy chunks.
  const baseSource = await result.read(result.baseScriptFileName);
  expect(baseSource).toContain(`"./${path.posix.basename(vendorFileName)}"`);
  expect(baseSource).not.toContain('"./vendor.js"');
});

test("vendor chunk keeps its file name across an app-code edit", async () => {
  // Only the base chunk body differs; vendor and lazy bytes are identical.
  const first = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_WITH_VENDOR_SOURCE,
      lazySource: ESM_LAZY_SOURCE,
      vendorSource: ESM_VENDOR_SOURCE,
    }),
    "esm",
  );
  const second = await runNamingPasses(
    await createNamingWorkspace({
      baseSource: ESM_BASE_WITH_VENDOR_SOURCE.replace(
        "export{r}",
        "console.log(1);export{r}",
      ),
      lazySource: ESM_LAZY_SOURCE,
      vendorSource: ESM_VENDOR_SOURCE,
    }),
    "esm",
  );

  // The whole point of the vendor chunk: nothing it contains references the
  // entry, so its reference closure is empty and an app edit cannot rename it.
  // On this app that is the biggest chunk, so its cache entry survives.
  expect(second.manifest.chunks.vendor.url).toBe(
    first.manifest.chunks.vendor.url,
  );

  // Pinned limit, not an oversight: a lazy chunk's shipped bytes contain
  // `import ... from "./<entry>-<hash>.js"`, so when the entry is renamed the
  // lazy chunk's bytes really do change and it must be renamed too. Full lazy
  // stability would need import-map indirection.
  expect(second.baseScriptFileName).not.toBe(first.baseScriptFileName);
  expect(second.manifest.chunks.lazy.url).not.toBe(
    first.manifest.chunks.lazy.url,
  );
});

test("script chunk naming leaves chunk sources untouched", async () => {
  const baseSource =
    'var r=globalThis.__g;r.a([0,[[[],"",[]],[[0],"lazy.js",[]]],[0,1],"/assets/"]);\n';
  const lazySource = "globalThis.__g.u(1);\n";
  const workspace = await createNamingWorkspace({ baseSource, lazySource });
  const result = await runNamingPasses(workspace, "script");

  const lazyFileName = toDistRelativeFile(result.manifest.chunks.lazy.url);
  // Script output only ever rewrites the base chunk's runtime manifest; the
  // lazy chunk keeps its exact compiled bytes.
  expect(await result.read(lazyFileName)).toBe(lazySource);
  const baseSourceOut = await result.read(result.baseScriptFileName);
  expect(baseSourceOut).toContain(path.posix.basename(lazyFileName));
  expect(baseSourceOut).not.toContain('"lazy.js"');
});

/**
 * Builds the two graphs the externs stage sees. The dependency module differs
 * between them as a remaining string-define hazard: authored source assigns
 * `this.loweredField`, the prebundled output writes it through
 * `Object.defineProperty(this, "loweredField", ...)`.
 */
async function writeExternsGraphFixture(fixture) {
  const preDepFile = path.join(fixture.srcDir, "pre-dep.js");
  const postDepFile = path.join(fixture.srcDir, "post-dep.js");
  const appFile = path.join(fixture.srcDir, "app.js");
  const depModuleId = path.join(
    fixture.projectRoot,
    "node_modules",
    "dep-pkg",
    "index.js",
  );

  await fs.mkdir(fixture.srcDir, { recursive: true });
  await fs.writeFile(
    preDepFile,
    [
      "export class Widget {",
      "  constructor() {",
      "    this.loweredField = 1;",
      "  }",
      "  read(other) {",
      "    return other.loweredField;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    postDepFile,
    [
      "export class Widget {",
      "  constructor() {",
      '    Object.defineProperty(this, "loweredField", { value: 1 });',
      "  }",
      "  read(other) {",
      "    return other.loweredField;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  await fs.writeFile(appFile, "export const app = 1;\n");

  const graph = (depFilePath) => ({
    authoredFiles: [appFile],
    entries: [{ file: "./app.js", sourceModuleId: appFile }],
    modules: [
      {
        filePath: appFile,
        id: appFile,
        relativePath: "app.js",
        sourceModuleIds: [appFile],
      },
      {
        filePath: depFilePath,
        id: depFilePath,
        relativePath: path.basename(depFilePath),
        sourceModuleIds: [depModuleId],
      },
    ],
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: ["./app.js", `./${path.basename(depFilePath)}`],
    srcDir: fixture.srcDir,
  });

  return { post: graph(postDepFile), pre: graph(preDepFile) };
}

test("typed extern scopes follow original Vite entries through materialized output paths", async () => {
  const fixture = await createFixture();
  const settledDir = path.join(fixture.projectRoot, "settled");
  const originalA = path.join(fixture.projectRoot, "src/a.ts");
  const originalB = path.join(fixture.projectRoot, "src/b.ts");
  const materialized = {
    entries: [
      { file: "./fused-a.js", sourceModuleId: originalA },
      { file: "./fused-b.js", sourceModuleId: originalB },
    ],
    modules: [
      {
        filePath: path.join(settledDir, "fused-a.js"),
        sourceModuleIds: [
          originalA,
          path.join(fixture.projectRoot, "src/not-entry.ts"),
        ],
      },
    ],
    srcDir: settledDir,
  };
  const input = {
    captureRoot: fixture.projectRoot,
    materialized,
    projectRoot: fixture.projectRoot,
    options: {
      compiler: {
        typedExterns: [
          "./global.externs.js",
          { path: "./scoped.externs.js", entries: ["./src/a.ts"] },
        ],
      },
    },
  };
  const externs = await resolveCompilerExterns(input);
  const resolved = normalizeBuildOptions({
    entries: materialized.entries.map((entry) => entry.file),
    projectRoot: fixture.projectRoot,
    srcDir: settledDir,
    typedExterns: externs.typedDeclarations,
  });
  expect(resolved.typedExterns).toEqual([
    {
      path: path.join(fixture.projectRoot, "global.externs.js"),
      entryFiles: [],
    },
    {
      path: path.join(fixture.projectRoot, "scoped.externs.js"),
      entryFiles: [path.join(settledDir, "fused-a.js")],
    },
  ]);
  input.options.compiler.typedExterns[1].entries = ["./src/not-entry.ts"];
  await expect(resolveCompilerExterns(input)).rejects.toThrow(
    /not a configured Vite source entry/,
  );
  input.options.compiler.typedExterns[1].entries = [];
  await expect(resolveCompilerExterns(input)).rejects.toThrow(
    /nonempty entries/,
  );
});

test("boundary-aware externs analyze the settled graph's app entry", async () => {
  const fixture = await createExternFixture();
  const finalSrcDir = path.join(fixture.projectRoot, "settled");
  const finalEntry = path.join(finalSrcDir, "app.js");
  await fixture.write(
    "settled/app.js",
    'import { Controller } from "contract-pkg"; class Host { constructor() { new Controller(this); } addController() {} removeController() {} requestUpdate() {} updateComplete = Promise.resolve(true); } new Host();\n',
  );
  const generatedExternFile = path.join(
    fixture.projectRoot,
    "boundary.externs.js",
  );
  const materialized = {
    authoredFiles: [finalEntry],
    entries: [
      {
        file: "./app.js",
        sourceModuleId: path.join(fixture.srcDir, "main.ts"),
      },
    ],
    modules: [
      {
        filePath: finalEntry,
        id: finalEntry,
        relativePath: "app.js",
        sourceModuleIds: [path.join(fixture.srcDir, "main.ts")],
      },
    ],
    prunedEmptyModuleIds: [],
    retainedEmptyModuleIds: [],
    runtimeEntries: ["./app.js"],
    srcDir: finalSrcDir,
  };
  const options = {
    compiler: { cache: { mode: "off" } },
    externs: {
      generate: {
        mode: "boundary-aware",
        modules: ["contract-pkg"],
        outputFile: generatedExternFile,
      },
    },
  };
  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized,
    options,
    projectRoot: fixture.projectRoot,
  });
  const barrierNames = async () =>
    accountBarriers({
      label: "settled graph",
      text: await fs.readFile(generatedExternFile, "utf8"),
    }).propertyNames;
  expect(await barrierNames()).toContain("addController");

  // Same settled filename, but no current boundary consumer. Original source
  // still constructs Controller and must not leak into the current externs.
  await fs.writeFile(finalEntry, "export const app = 1;\n");
  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized,
    options,
    projectRoot: fixture.projectRoot,
  });
  expect(await barrierNames()).not.toContain("addController");
});

test("dependency hazards are read from the post-prebundle graph", async () => {
  // Running the externs stage straight from src skips the bundler define that
  // normally supplies this; the package signature only needs to resolve to a
  // package.json.
  globalThis.__gcc_current_module_url = pathToFileURL(
    path.join(process.cwd(), "dist/index.mjs"),
  ).href;
  const fixture = await createFixture();
  const graphs = await writeExternsGraphFixture(fixture);
  const generatedExternFile = path.join(
    fixture.projectRoot,
    "generated.externs.js",
  );

  const options = {
    compiler: { cache: { mode: "off" } },
    externs: {
      generate: {
        modules: ["dep-pkg"],
        outputFile: generatedExternFile,
      },
    },
  };

  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized: graphs.post,
    options,
    projectRoot: fixture.projectRoot,
  });

  // The string-keyed definition only exists after prebundling. Scanning the
  // pre-prebundle graph would see `this.loweredField = 1` (dot-defined,
  // dot-accessed, safe) and emit nothing, silently dropping a real hazard.
  expect(await fs.readFile(generatedExternFile, "utf8")).toContain(
    "Object.prototype.loweredField;",
  );

  // Control: feeding the pre-prebundle graph must NOT find it,
  // distinguishing a real lowering hazard from unconditional preservation.
  await resolveCompilerExterns({
    captureRoot: fixture.projectRoot,
    materialized: graphs.pre,
    options,
    projectRoot: fixture.projectRoot,
  });
  expect(await fs.readFile(generatedExternFile, "utf8")).not.toContain(
    "Object.prototype.loweredField;",
  );
});

test.serial(
  "Vite keeps recursive matcher receiver properties linked across inferred and declared types",
  { timeout: 60000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.ts"></script>\n',
    );
    await fixture.write(
      "src/types.d.ts",
      [
        "export interface RouteRecord { aliasOf?: RouteRecord }",
        "export interface Matcher { record: RouteRecord; children: Matcher[]; parent?: Matcher; matcherOnly: number }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/matcher.ts",
      [
        'import type { Matcher, RouteRecord } from "./types";',
        "interface Parser { parserOnly: number }",
        "const assign = Object.assign;",
        "export function link(parser: Parser, record: RouteRecord, parent: Matcher) {",
        "  const matcher = assign(parser, { record, parent, children: [], matcherOnly: 1 });",
        '  if (!matcher["record"].aliasOf === !parent.record.aliasOf) parent.children.push(matcher);',
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import { link } from "./matcher";',
        'globalThis["__linkRecursiveMatchers"] = link;',
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, { buildLines: ['    target: "es2020",'] });
    const html = await fixture.read("dist/index.html");
    const entryScript = readRewrittenEntryScript(html);
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    try {
      globalThis.location = { href: "http://vite.test/index.html" };
      delete globalThis.__g;
      await import(
        `${pathToFileURL(path.join(fixture.outDir, toDistRelativeFile(entryScript))).href}?recursive-matcher=${Date.now()}`
      );
      const record = {};
      const shared = {
        builtOnly: 1,
        children: [],
        matcherOnly: 1,
        parserOnly: 1,
        record,
      };
      globalThis["__linkRecursiveMatchers"](shared, record, shared);
      expect(shared.children[0]).toBe(shared);
      expect(shared.record).toBe(record);
    } finally {
      delete globalThis["__linkRecursiveMatchers"];
      if (previousLocation === undefined) delete globalThis.location;
      else globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
    }
  },
);
test.serial(
  "gccTsBundler writes an evidence report with byte deltas and pinned properties",
  { timeout: 30000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "index.html",
      '<script type="module" src="/src/main.js"></script>\n',
    );
    await fixture.write(
      "src/greet.js",
      "export function greet(name) { return `hello:${name}`; }\n",
    );
    await fixture.write(
      "src/main.js",
      [
        'import { greet } from "./greet.js";',
        'globalThis["__reportFixtureResult"] = greet("report");',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "externs/app.externs.js",
      [
        "/**",
        " * @fileoverview",
        " * @externs",
        " */",
        "Object.prototype.myPinnedProp;",
        "",
      ].join("\n"),
    );

    await buildViteFixture(fixture, {
      compilerLines: ['        externs: ["externs/app.externs.js"],'],
      pluginOptionLines: ['      report: { file: "gcc-report.json" },'],
    });

    const report = JSON.parse(await fixture.read("gcc-report.json"));
    expect(report.version).toBe(1);
    expect(report.javascript.baseline.chunkCount).toBeGreaterThanOrEqual(1);
    expect(report.javascript.baseline.rawBytes).toBeGreaterThan(0);
    expect(report.javascript.baseline.gzipBytes).toBeGreaterThan(0);
    expect(report.javascript.output.fileCount).toBeGreaterThanOrEqual(1);
    expect(report.javascript.output.rawBytes).toBeGreaterThan(0);
    // Baseline must be the pre-replacement Vite chunks, not the compiled
    // output measured against itself.
    expect(report.javascript.output.rawBytes).not.toBe(
      report.javascript.baseline.rawBytes,
    );
    expect(Number.isFinite(report.javascript.deltaPct.raw)).toBe(true);
    expect(Number.isFinite(report.javascript.deltaPct.gzip)).toBe(true);
    expect(report.modules.capturedCount).toBeGreaterThanOrEqual(
      report.modules.compiledCount,
    );
    expect(report.modules.compiledCount).toBeGreaterThan(0);
    expect(Array.isArray(report.modules.deadModules)).toBe(true);
    expect(report.properties.pinned).toContain("myPinnedProp");
    expect(report.properties.renameBarrierFiles).toContain(
      "externs/app.externs.js",
    );
  },
);
