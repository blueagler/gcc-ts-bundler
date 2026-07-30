import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
// The evidence-class rule lives in src and is asserted directly, so this test
// is meaningful before dist is rebuilt; the tests above validate the built
// artifact and need `bun run build:js` to see rule changes.
import { generateExterns as generateExternsFromSource } from "../src/api/build.ts";
import {
  createFixture,
  createExternFixture,
  createRuntimeExternFixture,
  execFileAsync,
  findFilesNamed,
  getProjectCacheDir,
} from "./helpers.mjs";

test.serial(
  "generateExterns follows declaration dependencies and emits stable property externs",
  async () => {
    const fixture = await createExternFixture();

    const result = await generateExterns({
      appEntryFiles: ["./main.ts"],
      modules: ["contract-pkg"],
      mode: "boundary-aware",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(
      result.scannedFiles.some((filePath) =>
        filePath.endsWith("/base-host/index.d.ts"),
      ),
    ).toBe(true);
    expect(result.mode).toBe("boundary-aware");
    expect(result.text).toContain("Object.prototype.addController;");
    expect(result.text).toContain("Object.prototype.removeController;");
    expect(result.text).toContain("Object.prototype.requestUpdate;");
    expect(result.text).toContain("Object.prototype.updateComplete;");
    expect(result.text).not.toContain("Object.prototype.hostConnected;");
    expect(result.text).not.toContain("Object.prototype.hostDisconnected;");
    expect(result.text).not.toContain("Object.prototype.togglePlay;");
    expect(result.text).not.toContain("Object.prototype.isAnimating;");
    expect(result.text).not.toContain("Object.prototype.link;");
    expect(result.text).not.toContain("Object.prototype.attribute;");
    expect(result.text).not.toContain("Object.prototype.reflect;");
    expect(result.text).not.toContain("Object.prototype.map;");
    expect(result.text).not.toContain("__gcc_extern_");
  },
);

test.serial(
  "generateExterns resolves package subpaths that ship sibling declaration files",
  async () => {
    const fixture = await createExternFixture();

    const result = await generateExterns({
      appEntryFiles: ["./main.ts"],
      includeDependencies: false,
      mode: "boundary-aware",
      modules: ["contract-pkg/decorators.js"],
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    // The subpath's own declaration file is the one that gets scanned — the
    // package root's is not pulled in when dependencies are not followed.
    expect(result.scannedFiles).toHaveLength(1);
    expect(result.mode).toBe("boundary-aware");
    expect(result.scannedFiles[0]).toContain("decorators.d.ts");
  },
);

test.serial(
  "generateExterns boundary-aware mode ignores app-only object protocol keys",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        "const tpl = {",
        '  ["__protocol__"]: 1,',
        "  values: [],",
        "};",
        "export const view = tpl;",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "node_modules/dummy-pkg/package.json",
      JSON.stringify(
        {
          name: "dummy-pkg",
          types: "./index.d.ts",
        },
        null,
        2,
      ),
    );
    await fixture.write(
      "node_modules/dummy-pkg/index.d.ts",
      "export interface Dummy {}\n",
    );

    const result = await generateExterns({
      appEntryFiles: ["./main.ts"],
      modules: ["dummy-pkg"],
      mode: "boundary-aware",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });

    expect(result.text).not.toContain("Object.prototype.__protocol__;");
    expect(result.text).not.toContain("Object.prototype.values;");
  },
);

test.serial(
  "generateExterns runtime-aware mode captures public runtime protocols without noise",
  async () => {
    const runtimeFixture = await createRuntimeExternFixture();
    await runtimeFixture.write(
      "src/index.ts",
      [
        'import { Counter } from "runtime-pkg";',
        "const counter = Counter.from();",
        "counter.reset();",
        'export const current = counter.bump("demo");',
        "",
      ].join("\n"),
    );

    const runtimeResult = await generateExterns({
      appEntryFiles: ["./index.ts"],
      mode: "runtime-aware",
      modules: ["runtime-pkg"],
      projectRoot: runtimeFixture.projectRoot,
      runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
      srcDir: runtimeFixture.srcDir,
    });

    expect(runtimeResult.mode).toBe("runtime-aware");
    expect(runtimeResult.text).toContain("Object.prototype.counts;");
    expect(runtimeResult.text).toContain("Object.prototype.current;");
    expect(runtimeResult.text).toContain("Object.prototype.previous;");
    expect(runtimeResult.text).toContain("Object.prototype.is_fork;");
    expect(runtimeResult.text).toContain("Object.prototype.id;");
    expect(runtimeResult.text).toContain("Object.prototype.label;");
    expect(runtimeResult.text).toContain("Object.prototype.reset;");
    expect(runtimeResult.text).toContain("Object.prototype.from;");
    expect(runtimeResult.text).not.toContain("Object.prototype.bump;");
    expect(runtimeResult.text).not.toContain(
      "Object.prototype.addEventListener;",
    );
    expect(runtimeResult.text).not.toContain("Object.prototype.apply;");
    expect(runtimeResult.text).not.toContain("Object.prototype.length;");

    const protocolFixture = await createFixture();
    await protocolFixture.write(
      "src/runtime.js",
      [
        "const helpers = {",
        "  prop(props, key) {",
        "    return props[key];",
        "  },",
        "  rest_props(props, keys) {",
        "    return keys.length ? props : {};",
        "  },",
        "};",
        "export function view(props) {",
        '  return helpers.prop(props, "variant") ?? helpers.rest_props(props, ["$$slots", "$$events", "$$legacy", "size"]);',
        "}",
        "",
      ].join("\n"),
    );

    const protocolResult = await generateExterns({
      mode: "runtime-aware",
      modules: ["demo-runtime"],
      projectRoot: protocolFixture.projectRoot,
      protocolHelpers: {
        keyExclusionListCallees: ["rest_props"],
        keyReadCallees: ["prop"],
      },
      runtimeEntryFiles: ["./runtime.js"],
      srcDir: protocolFixture.srcDir,
    });

    expect(protocolResult.text).toContain("Object.prototype.$$slots;");
    expect(protocolResult.text).toContain("Object.prototype.$$events;");
    expect(protocolResult.text).toContain("Object.prototype.$$legacy;");
    expect(protocolResult.text).toContain("Object.prototype.variant;");
    expect(protocolResult.text).toContain("Object.prototype.size;");
    expect(protocolResult.text).not.toContain("Object.prototype.prop;");
    expect(protocolResult.text).not.toContain("Object.prototype.rest_props;");
  },
);

test.serial(
  "generateExterns runtime-aware mode externs only mixed definition/read pairs",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/runtime.js",
      [
        "const __publicField = (obj, key, value) => (obj[key] = value);",
        "export class Widget {",
        "  constructor() {",
        // string-keyed definition, read back through a dot: Closure renames the
        // read and leaves the string, so this one needs an extern.
        '    __publicField(this, "loweredField", 1);',
        '    Object.defineProperty(this, "definedField", { value: 2 });',
        '    this["bracketField"] = 3;',
        // dot definitions: safe unless something reads them as a string.
        "    this.dotOnlyField = 4;",
        "    this.literalReadField = 5;",
        "    this.inCheckField = 6;",
        "  }",
        "  read(other) {",
        "    return (",
        "      this.loweredField +",
        "      this.definedField +",
        "      this.bracketField +",
        "      other.dotOnlyField +",
        '      other["literalReadField"] +',
        '      ("inCheckField" in other ? 1 : 0)',
        "    );",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const result = await generateExternsFromSource({
      mode: "runtime-aware",
      modules: ["demo-runtime"],
      projectRoot: fixture.projectRoot,
      runtimeEntryFiles: ["./runtime.js"],
      srcDir: fixture.srcDir,
    });

    // string-defined + dot-accessed -> externed.
    expect(result.text).toContain("Object.prototype.loweredField;");
    expect(result.text).toContain("Object.prototype.definedField;");
    expect(result.text).toContain("Object.prototype.bracketField;");
    // dot-defined + literal string read -> externed.
    expect(result.text).toContain("Object.prototype.literalReadField;");
    expect(result.text).toContain("Object.prototype.inCheckField;");
    // dot-defined + dot-accessed renames consistently in one Closure
    // invocation, so externing it would only block optimisation.
    expect(result.text).not.toContain("Object.prototype.dotOnlyField;");
  },
);

test.serial(
  "runtime-aware mode catches constructed-key prefixes and camelized kebab keys",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/runtime.js",
      [
        "// vue vapor's event delegation shape: handlers assigned with a dot,",
        "// read back through a key built from a template literal.",
        "export function attach(node, handler) {",
        "  node.$evtclick = handler;",
        "}",
        "export function dispatch(node, event) {",
        "  const key = `$evt${event.type}`;",
        "  return node[key];",
        "}",
        "// vapor props: quoted kebab-case pass site, camelCase declaration,",
        "// bridged by camelize() at runtime.",
        "export function pass(component) {",
        '  return { "click-count": () => component.count };',
        "}",
        "export function declare(props) {",
        "  return props.clickCount;",
        "}",
        "// An ordinary message template must not become prefix evidence.",
        "export function label(kind) {",
        "  return `count: ${kind}`;",
        "}",
        "export function readCount(state) {",
        "  return state.countLabel;",
        "}",
        "",
      ].join("\n"),
    );

    const result = await generateExternsFromSource({
      mode: "runtime-aware",
      modules: ["demo-runtime"],
      projectRoot: fixture.projectRoot,
      runtimeEntryFiles: ["./runtime.js"],
      srcDir: fixture.srcDir,
    });

    // `$`-prefixed template head + dot mention -> externed.
    expect(result.text).toContain("Object.prototype.$evtclick;");
    // Hyphenated string definition externs its camelCase alias too.
    expect(result.text).toContain("Object.prototype.clickCount;");
    // Non-$/_ template heads are not prefix evidence.
    expect(result.text).not.toContain("Object.prototype.countLabel;");
  },
);

test.serial(
  "externs CLI emits boundary-aware and runtime-aware outputs",
  async () => {
    const boundaryFixture = await createExternFixture();
    const boundaryOutputFile = path.join(
      boundaryFixture.projectRoot,
      "closure-externs",
      "contract.generated.js",
    );

    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "bin", "gcc-ts-bundler.mjs"),
      "externs",
      "--entry",
      "./main.ts",
      "--project-root",
      boundaryFixture.projectRoot,
      "--src-dir",
      boundaryFixture.srcDir,
      "--module",
      "contract-pkg",
      "--output-file",
      boundaryOutputFile,
    ]);

    const boundaryOutput = await fs.readFile(boundaryOutputFile, "utf8");
    expect(boundaryOutput).toContain("/** @externs */");
    expect(boundaryOutput).toContain("Object.prototype.addController;");
    expect(boundaryOutput).toContain("Object.prototype.updateComplete;");
    expect(boundaryOutput).not.toContain("Object.prototype.togglePlay;");
    expect(boundaryOutput).not.toContain("Object.prototype.attribute;");

    const runtimeFixture = await createRuntimeExternFixture();
    const runtimeOutputFile = path.join(
      runtimeFixture.projectRoot,
      "closure-externs",
      "runtime.generated.js",
    );

    await execFileAsync(process.execPath, [
      path.join(process.cwd(), "bin", "gcc-ts-bundler.mjs"),
      "externs",
      "--entry",
      "./index.ts",
      "--project-root",
      runtimeFixture.projectRoot,
      "--src-dir",
      runtimeFixture.srcDir,
      "--runtime-entry",
      "./node_modules/runtime-pkg/index.js",
      "--mode",
      "runtime-aware",
      "--module",
      "runtime-pkg",
      "--output-file",
      runtimeOutputFile,
    ]);

    const runtimeOutput = await fs.readFile(runtimeOutputFile, "utf8");
    expect(runtimeOutput).toContain("Object.prototype.counts;");
    expect(runtimeOutput).toContain("Object.prototype.label;");
    expect(runtimeOutput).not.toContain("Object.prototype.addEventListener;");
  },
);

test.serial(
  "build uses explicit runtime-aware externs to preserve runtime and protocol contracts",
  { timeout: 20000 },
  async () => {
    const runtimeFixture = await createRuntimeExternFixture();
    const runtimeExternsFile = path.join(
      runtimeFixture.projectRoot,
      "closure-externs",
      "runtime.generated.js",
    );

    await generateExterns({
      appEntryFiles: ["./index.ts"],
      mode: "runtime-aware",
      modules: ["runtime-pkg"],
      outputFile: runtimeExternsFile,
      projectRoot: runtimeFixture.projectRoot,
      runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
      srcDir: runtimeFixture.srcDir,
    });

    const runtimeResult = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      externs: ["./closure-externs/runtime.generated.js"],
      outDir: runtimeFixture.outDir,
      projectRoot: runtimeFixture.projectRoot,
      srcDir: runtimeFixture.srcDir,
    });

    expect(runtimeResult.ok).toBe(true);
    const runtimeOutput = await runtimeFixture.read("dist/index.js");
    expect(runtimeOutput).not.toMatch(/runtime-pkg/);

    const builtModule = await import(
      `${pathToFileURL(path.join(runtimeFixture.outDir, "index.js")).href}?runtime=${Date.now()}`
    );
    expect(builtModule.first).toBe("demo:1");
    expect(builtModule.second).toBe("demo:2");

    const protocolFixture = await createFixture();
    const protocolExternsFile = path.join(
      protocolFixture.projectRoot,
      "closure-externs",
      "protocol.generated.js",
    );
    await protocolFixture.write(
      "src/helpers.js",
      [
        "export function prop(props, key) {",
        "  return props[key];",
        "}",
        "export function rest_props(props, keys) {",
        "  const next = {};",
        "  for (const key in props) {",
        "    if (keys.includes(key)) {",
        "      continue;",
        "    }",
        "    next[key] = props[key];",
        "  }",
        "  return next;",
        "}",
        "export function render(props) {",
        '  const variant = prop(props, "variant");',
        '  const extra = rest_props(props, ["$$slots", "$$events", "$$legacy", "variant"]);',
        "  return { extra, variant };",
        "}",
        "",
      ].join("\n"),
    );
    await protocolFixture.write(
      "src/main.js",
      [
        'import { render } from "./helpers.js";',
        "const result = render({",
        "  $$slots: { default: true },",
        '  class: "m3-container",',
        '  variant: "filled",',
        "});",
        'globalThis["__protocolHasObjectValue"] = Object.values(result.extra).some((value) => value && typeof value === "object");',
        'globalThis["__protocolVariant"] = result.variant;',
        "",
      ].join("\n"),
    );

    await generateExterns({
      mode: "runtime-aware",
      modules: ["demo-runtime"],
      outputFile: protocolExternsFile,
      projectRoot: protocolFixture.projectRoot,
      runtimeEntryFiles: ["./helpers.js"],
      srcDir: protocolFixture.srcDir,
    });

    const protocolResult = await build({
      cache: { mode: "off" },
      entries: ["./main.js"],
      externs: ["./closure-externs/protocol.generated.js"],
      outDir: protocolFixture.outDir,
      projectRoot: protocolFixture.projectRoot,
      srcDir: protocolFixture.srcDir,
    });

    expect(protocolResult.ok).toBe(true);
    await import(
      `${pathToFileURL(path.join(protocolFixture.outDir, "main.js")).href}?protocol=${Date.now()}`
    );
    expect(globalThis.__protocolHasObjectValue).toBe(false);
    expect(globalThis.__protocolVariant).toBe("filled");
  },
);

test.serial(
  "build does not auto-generate runtime-aware dependency externs by default",
  async () => {
    const fixture = await createRuntimeExternFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");

    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      compilationLevel: "ADVANCED",
      entries: ["./index.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const externFiles = await findFilesNamed(
      path.join(projectCacheDir, "native-emit"),
      "runtime-dependency-externs.js",
    );
    expect(externFiles).toHaveLength(0);
  },
);

test("one extern-name predicate, two documented sources", async () => {
  const { isExternPropertyName, isRuntimeExternPropertyName } = await import(
    "../src/externs/shared.ts"
  );

  // Structural / unusable names are rejected by both sources.
  for (const name of ["prototype", "constructor", "#priv", "a@b", "Map"]) {
    expect(isExternPropertyName(name, "contract")).toBe(false);
    expect(isExternPropertyName(name, "runtime")).toBe(false);
  }

  // The divergence that used to be silent, now explicit: framework-internal
  // `_`/`$` protocol members are noise in a .d.ts and load-bearing in emitted
  // runtime code. Dropping them from runtime evidence froze vue reactivity.
  for (const name of ["__v_isRef", "$evtclick", "_value"]) {
    expect(isExternPropertyName(name, "contract")).toBe(false);
    expect(isExternPropertyName(name, "runtime")).toBe(true);
  }

  // Host-object members are already in Closure's browser externs; re-pinning
  // them from runtime evidence is pure cost.
  for (const name of ["addEventListener", "setAttribute", "removeAttribute"]) {
    expect(isExternPropertyName(name, "contract")).toBe(true);
    expect(isExternPropertyName(name, "runtime")).toBe(false);
  }

  expect(isExternPropertyName("clickCount")).toBe(true);
  expect(isRuntimeExternPropertyName("clickCount")).toBe(true);
});

test("barrier accounting counts every extern property shape", async () => {
  const { accountBarriers, collectBarrierPropertyNames, formatBarrierWarning } =
    await import("../src/externs/barriers.ts");

  const text = [
    "/** @externs */",
    "// Generated for: react — this comment must not be scanned",
    "Object.prototype.flatOne;",
    'Function.prototype["flat two"];',
    "Owner.prototype.ownerOne;",
    '/** @type {{"recordOne": string, "recordTwo": number}} */',
    "Owner.prototype.typed;",
  ].join("\n");

  expect(collectBarrierPropertyNames(text)).toEqual([
    "flat two",
    "flatOne",
    "ownerOne",
    "recordOne",
    "recordTwo",
    "typed",
  ]);

  const accounting = accountBarriers({ label: "probe", text });
  expect(accounting.byKind.flat).toBe(2);
  expect(accounting.byKind.owner).toBe(2);
  expect(accounting.byKind.record).toBe(2);
  expect(formatBarrierWarning(accounting)).toBeNull();
  expect(formatBarrierWarning(accounting, 1)).toContain("pins 6 property names");
});

// jQuery's Deferred API is defined entirely through concatenated keys
// (`deferred[tuple[0] + "With"] = list.fireWith`) and read back with plain dots
// (`readyList.resolveWith(document, [jQuery])`). Only the dot side renames, so
// the page died with `TypeError: <x>.ga is not a function` on first paint. The
// example used to hide this by pinning jQuery's whole 761-member type surface.
test("concatenated element-access keys are rename evidence", async () => {
  const { analyzeRuntimeUsage } = await import(
    "../src/externs/runtime-analysis.ts"
  );
  const { collectRuntimeUsageExternLines } = await import(
    "../src/externs/render.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "runtime.js",
    [
      "const tuples = [['notify'], ['resolve'], ['reject']];",
      "function Deferred() {",
      "  const list = { fireWith: function () {} };",
      "  const deferred = {};",
      "  tuples.forEach(function (tuple) {",
      "    deferred[tuple[0] + 'With'] = list.fireWith;",
      "  });",
      "  return deferred;",
      "}",
      "const readyList = Deferred();",
      "export function go(doc) { return readyList.resolveWith(doc, []); }",
      // A one-character anchor must NOT become evidence: it would match a
      // large share of any program's member names.
      "export function noisy(bag, k) { return bag[k + 's']; }",
      "export function alsoNoisy(o) { return o.tags + o.things; }",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.constructedKeyFragments]).toContain("suffix:With");
  expect([...hazards.constructedKeyFragments]).not.toContain("suffix:s");

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).toContain("Object.prototype.resolveWith;");
  expect([...lines]).toContain("Object.prototype.fireWith;");
  // The short-anchor guard must keep unrelated members out.
  expect([...lines]).not.toContain("Object.prototype.tags;");
  expect([...lines]).not.toContain("Object.prototype.things;");
});

// jquery.js:7135-7143 defines `jQuery.easing = { linear, swing, _default: "swing" }`
// and reads it back as `jQuery.easing[this.easing]` where `this.easing` holds the
// string from `_default`. The key is dot-defined and the read goes through a
// variable, so every other evidence class misses it: Closure renames `swing`, the
// string does not follow, and `.animate()`/`.fadeIn()` silently produce no tween
// inside a requestAnimationFrame tick that surfaces nothing.
test("a string value naming a sibling key is rename evidence", async () => {
  const { analyzeRuntimeUsage } = await import(
    "../src/externs/runtime-analysis.ts"
  );
  const { collectRuntimeUsageExternLines } = await import(
    "../src/externs/render.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "runtime.js",
    [
      "export const easing = {",
      "  linear: function (p) { return p; },",
      "  swing: function (p) { return 0.5 - Math.cos(p * Math.PI) / 2; },",
      "  _default: 'swing'",
      "};",
      "export function ease(name, p) { return easing[name || easing._default](p); }",
      // Values that name nothing in their own literal stay out.
      "export const labels = { title: 'Heading', mode: 'dark' };",
      // A value naming a key of a DIFFERENT literal stays out: the rule does
      // not cross literal boundaries.
      "export const outer = { inner: { deep: 1 }, pick: 'deep' };",
      // A quoted key never renames, so it needs no pin.
      "export const quoted = { 'kept': 1, ref: 'kept' };",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.selfReferentialKeys]).toEqual(["swing"]);

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).toContain("Object.prototype.swing;");
  expect([...lines]).not.toContain("Object.prototype.Heading;");
  expect([...lines]).not.toContain("Object.prototype.deep;");
  expect([...lines]).not.toContain("Object.prototype.kept;");
});

// The audit that justified shipping the rule unconditionally: across all 12
// `_default` sites in the real jquery.js, the sibling-key rule fires exactly
// once. If a future change widens it, this count moves and the test fails.
test("the sibling-key rule fires exactly once across real jquery.js", async () => {
  const { analyzeRuntimeUsage } = await import(
    "../src/externs/runtime-analysis.ts"
  );
  const jquerySource = path.join(
    import.meta.dirname,
    "..",
    "examples",
    "jquery-vite-official",
    "node_modules",
    "jquery",
    "dist",
    "jquery.js",
  );
  try {
    await fs.access(jquerySource);
  } catch {
    return;
  }
  const hazards = await analyzeRuntimeUsage([jquerySource], {
    keyExclusionListCallees: [],
    keyReadCallees: [],
  });
  expect([...hazards.selfReferentialKeys]).toEqual(["swing"]);
});

// Regression lock for the example's posture: proven barriers only.
test("jquery example pins proven barriers, not a type surface", async () => {
  const exampleRoot = path.resolve(
    import.meta.dirname,
    "../examples/jquery-vite-official",
  );
  try {
    await fs.access(path.join(exampleRoot, "node_modules/jquery"));
  } catch {
    return;
  }

  const runtime = await generateExternsFromSource({
    appEntryFiles: ["./src/main.ts"],
    mode: "runtime-aware",
    modules: ["jquery"],
    projectRoot: exampleRoot,
    protocolHelpers: {
      keyExclusionListCallees: [],
      keyReadCallees: ["access", "get", "remove", "set"],
    },
    runtimeEntryFiles: ["./node_modules/jquery/dist/jquery.js"],
    srcDir: ".",
  });

  // The name that broke the page, now proven rather than guessed.
  expect(runtime.renameBarriers.propertyNames).toContain("resolveWith");
  // The handler store jQuery writes as `elemData.events` and reads back as
  // `dataPriv.get(this, "events")`; renaming one side silently unhooks every
  // delegated handler.
  expect(runtime.renameBarriers.propertyNames).toContain("events");
  // Two orders of magnitude below the 761 the type surface produced.
  expect(runtime.renameBarriers.propertyNames.length).toBeLessThan(60);
  expect(runtime.barrierWarnings).toEqual([]);
});
