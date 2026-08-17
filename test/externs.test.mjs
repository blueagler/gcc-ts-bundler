import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
// The evidence-class rule lives in src and is asserted directly, so this test
// is meaningful before dist is rebuilt; the tests above validate the built
// artifact and need `bun run build:js` to see rule changes.
import { generateExterns as generateExternsFromSource } from "../src/api/build.ts";
import { mergeRuntimeHazards } from "../src/externs/runtime-analysis.ts";
import {
  createFixture,
  createExternFixture,
  createRuntimeExternFixture,
  execFileAsync,
  findFilesNamed,
  getProjectCacheDir,
} from "./helpers.mjs";

test("mergeRuntimeHazards merges every hazard set without runtime string indexing", () => {
  const first = {
    constructedKeyFragments: new Set(["fragment-a"]),
    constructedKeyPrefixes: new Set(["prefix-a"]),
    cssVariableKeyNames: new Set(["css-variable-a"]),
    dotAccessed: new Set(["accessed-a"]),
    dotDefined: new Set(["defined-a"]),
    enumeratedKeyNames: new Set(["enumerated-a"]),
    protocolMembers: new Set(["protocol-a"]),
    selfReferentialKeys: new Set(["self-a"]),
    stringDefined: new Set(["string-defined-a"]),
    stringLiteralRead: new Set(["string-read-a"]),
  };
  const second = Object.fromEntries(
    Object.entries(first).map(([key, values]) => [
      key,
      new Set([...values].map((value) => value.replace("-a", "-b"))),
    ]),
  );

  const merged = mergeRuntimeHazards(first, second);
  for (const [key, values] of Object.entries(merged)) {
    expect([...values]).toEqual([
      ...first[key],
      ...second[key],
    ]);
  }
});

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
    expect(runtimeResult.text).not.toContain("Object.prototype.counts;");
    expect(runtimeResult.text).not.toContain("Object.prototype.current;");
    expect(runtimeResult.text).not.toContain("Object.prototype.previous;");
    expect(runtimeResult.text).not.toContain("Object.prototype.is_fork;");
    expect(runtimeResult.text).not.toContain("Object.prototype.id;");
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
        // Identifier this-field helpers become dotted assigns before Closure.
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

    // Identifier this-field helpers rename with their dotted reads.
    expect(result.text).not.toContain("Object.prototype.loweredField;");
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
        "// pro-components' intl map: the locale table is dot-defined, its keys",
        "// are re-published dashed, and the lookup is a dashed string literal.",
        "const localeMessages = { zh_CN: 1, en_US: 2 };",
        "const intlMap = Object.fromEntries(",
        "  Object.keys(localeMessages).map((k) => [k.replace('_', '-'), k]),",
        ");",
        "export function zhCN() {",
        '  return intlMap["zh-CN"];',
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
    // …and its underscored alias, which is what the dashed locale lookup
    // reaches. Renaming `zh_CN` leaves `intlMap["zh-CN"]` undefined.
    expect(result.text).toContain("Object.prototype.zh_CN;");
    expect(result.text).not.toContain("Object.prototype.en_US;");
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
    expect(runtimeOutput).not.toContain("Object.prototype.counts;");
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
  expect(accounting.byKind.get("flat")).toBe(2);
  expect(accounting.byKind.get("owner")).toBe(2);
  expect(accounting.byKind.get("record")).toBe(2);
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

// fast-color detects `{ h, s, v }` by passing literal format names to a local
// helper that evaluates `str[0] in input`, so the fixed characters are runtime
// property reads even though they are not literal element-access expressions.
test("literal arguments indexed into object-key probes are rename evidence", async () => {
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
      "const input = { r: 1, g: 2, b: 3, h: 4, s: 5, l: 6, v: 7, z: 8 };",
      "function matchFormat(str) {",
      "  return str[0] in input && str[1] in input && str[2] in input;",
      "}",
      "matchFormat('rgb'); matchFormat('hsl'); matchFormat('hsv');",
      // Numeric string indexing that is not used as an object key is not proof.
      "function first(text) { return text[0]; } first('zoo');",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.stringLiteralRead].sort()).toEqual([
    "b",
    "g",
    "h",
    "l",
    "r",
    "s",
    "v",
  ]);

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  for (const member of ["b", "g", "h", "l", "r", "s", "v"]) {
    expect([...lines]).toContain(`Object.prototype.${member};`);
  }
  expect([...lines]).not.toContain("Object.prototype.z;");
});

// Identifier `this` field helpers become dotted assigns. Minified proven
// helpers (`J`) still write a string key and stay string-defined.
test("identifier this field helpers are not string-defined rename evidence", async () => {
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
      // The real Babel helper, minified to a single letter, exactly as
      // @wecom/jssdk ships it.
      "function J(e, t, n) {",
      "  return t in e ? Object.defineProperty(e, t, { value: n }) : (e[t] = n), e;",
      "}",
      // A same-arity impostor whose body defines no field.
      "function notAHelper(a, b, c) { return a.handle(b, c); }",
      "function Store() {",
      '  _defineProperty(this, "map", new Map());',
      '  _defineProperty2.default(this, "interop", 1);',
      '  J(this, "url", void 0);',
      '  notAHelper(this, "ignored", 1);',
      '  this.listeners.set(this, "alsoIgnored", 1);',
      "}",
      "Store.prototype.read = function () {",
      "  return [this.map.size, this.interop, this.url];",
      "};",
      "",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.stringDefined].sort()).toEqual(["url"]);
  expect([...hazards.dotDefined].sort()).toEqual(
    expect.arrayContaining(["interop", "map"]),
  );

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).not.toContain("Object.prototype.map;");
  expect([...lines]).not.toContain("Object.prototype.interop;");
  expect([...lines]).toContain("Object.prototype.url;");
  // Shape alone is not evidence: three arguments led by `this` also describe
  // `fn.call(this, name, value)` and `store.set(this, key, value)`.
  expect([...lines]).not.toContain("Object.prototype.ignored;");
  expect([...lines]).not.toContain("Object.prototype.alsoIgnored;");
});

test("Babel class descriptors are string-defined rename evidence", async () => {
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
      "function ArrayKeyMap() {}",
      "_createClass(ArrayKeyMap, [{",
      "  key: 'getCompositeKey',",
      "  value: function getCompositeKey(keys) { return keys.join('|'); }",
      "}]);",
      "ArrayKeyMap.prototype.run = function (keys) { return this.getCompositeKey(keys); };",
      // A descriptor-shaped data record without a function body is not a class member.
      "record(ArrayKeyMap, [{ key: 'message', value: 1 }]);",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.stringDefined]).toContain("getCompositeKey");
  expect([...hazards.stringDefined]).not.toContain("message");

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).toContain("Object.prototype.getCompositeKey;");
  expect([...lines]).not.toContain("Object.prototype.message;");
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

// lodash publishes `lodash.bind = func.bind` with a plain dot, then reads the
// same members back through a literal name list:
// `arrayEach(['bind', 'bindKey', …], (methodName) => lodash[methodName]…)`.
// Closure renames the definition, the array string does not follow, and the
// module throws `Cannot set properties of undefined (setting 'placeholder')`
// the moment it evaluates. Every other evidence class misses this shape.
test("finite literal key lists that reach computed access are rename evidence", async () => {
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
      "function arrayEach(items, fn) { items.forEach(fn); }",
      "const lodash = {};",
      "lodash.bind = function () {};",
      "lodash.curry = function () {};",
      // Array-literal list carried by a helper callback.
      "arrayEach(['bind', 'curry'], function (methodName) {",
      "  lodash[methodName].placeholder = lodash;",
      "});",
      // Split-string list, the other spelling of the same idiom.
      "const store = {};",
      "'alpha beta'.split(' ').forEach(function (key) { store[key] = 1; });",
      // for…of over a literal list.
      "const speed = { x: 0, y: 0 };",
      "for (const axis of ['x', 'y']) { speed[axis] = 0; }",
      // A concatenated key is recorded as the key it actually builds.
      "const lazy = {};",
      "arrayEach(['drop'], function (name) { lazy[name + 'Right'] = 1; });",
      // jQuery's `class2type["[object " + name + "]"] = …` runs a name list
      // through element access, but the key it builds is never a renameable
      // identifier property, so the list must not become evidence.
      "const class2type = {};",
      "arrayEach(['Boolean', 'Number'], function (typeName) {",
      "  class2type['[object ' + typeName + ']'] = typeName.toLowerCase();",
      "});",
      // A literal array nothing indexes with is a lookup table, not evidence.
      "export const MESSAGES = ['notFound', 'serverError'];",
      "export function report(code) { return MESSAGES.indexOf(code); }",
      // A dynamic key must not drag the literal names of an unrelated list in.
      "export function pick(bag, key) { return bag[key]; }",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.enumeratedKeyNames].sort()).toEqual([
    "alpha",
    "beta",
    "bind",
    "curry",
    "dropRight",
    "x",
    "y",
  ]);

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).toContain("Object.prototype.bind;");
  expect([...lines]).toContain("Object.prototype.curry;");
  expect([...lines]).toContain("Object.prototype.dropRight;");
  // An unindexed literal array stays out; admitting it would pin every
  // message table and enum in the program.
  expect([...lines]).not.toContain("Object.prototype.notFound;");
  expect([...lines]).not.toContain("Object.prototype.serverError;");
  // A concatenation that cannot produce an identifier is not a rename hazard.
  expect([...lines]).not.toContain("Object.prototype.Boolean;");
  expect([...lines]).not.toContain("Object.prototype.Number;");
});

test("const-bound key lists and element transforms are rename evidence", async () => {
  const { analyzeRuntimeUsage } = await import(
    "../src/externs/runtime-analysis.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "runtime.js",
    [
      // antd's responsive observer, reduced to three breakpoints: the list is
      // a module-level const, reaches the loop through `concat`/`reverse`, and
      // every key is built by `toUpperCase` plus a template.
      "const responsiveArray = ['xxl', 'md', 'xs'];",
      "export const validateBreakpoints = (token) => {",
      "  const revBreakpoints = [].concat(responsiveArray).reverse();",
      "  revBreakpoints.forEach((breakpoint, i) => {",
      "    const breakpointUpper = breakpoint.toUpperCase();",
      "    const screenMin = `screen${breakpointUpper}Min`;",
      "    const screen = `screen${breakpointUpper}`;",
      "    const screenMax = `screen${breakpointUpper}Max`;",
      "    if (!(token[screenMin] <= token[screen])) throw new Error('bad');",
      "    if (!(token[screen] <= token[screenMax])) throw new Error('bad');",
      "  });",
      "};",
      // for…of over the same const binding.
      "export const matchScreen = (screens) => {",
      "  for (const breakpoint of responsiveArray) {",
      "    if (screens[breakpoint]) return breakpoint;",
      "  }",
      "};",
      // Negative: the list is not literal, so nothing about it is known.
      "const dynamicList = Object.keys(globalThis);",
      "const dynamic = {};",
      "dynamicList.forEach((key) => { dynamic[key] = 1; });",
      // Negative: a partial transformation breaks the chain, and a template
      // that cannot build an identifier is a message, not a key.
      "const partialList = ['alpha', 'beta'];",
      "const probe = {};",
      "partialList.forEach((key) => {",
      "  const trimmed = key.slice(1);",
      "  probe[trimmed] = 1;",
      "  probe[`(max-width: ${key}px)`] = 2;",
      "});",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect([...hazards.enumeratedKeyNames].sort()).toEqual([
    "md",
    "screenMD",
    "screenMDMax",
    "screenMDMin",
    "screenXS",
    "screenXSMax",
    "screenXSMin",
    "screenXXL",
    "screenXXLMax",
    "screenXXLMin",
    "xs",
    "xxl",
  ]);
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

// The CSS custom-property protocol. `@ant-design/cssinjs` turns a token object
// into CSS variables by enumerating its keys and transliterating each one into
// a `--ant-…` name, so a renamed key is what lands in the stylesheet — and `$`
// is not a legal CSS identifier, so the declaration is dropped outright. The
// keys never appear as a string literal and the object is assembled by three
// packages of spreads, dot-writes and higher-order calls, so no other evidence
// class reaches them.
test("keys that reach a `--` string construction are rename evidence", async () => {
  const { analyzeCssVariableProtocol } = await import(
    "../src/externs/css-variable-protocol.ts"
  );
  const fixture = await createFixture();
  // Module 1: the sink. The enumerated key escapes into a template with a
  // literal `--` head, through a call — exactly `token2CSSVar(key, prefix)`.
  await fixture.write(
    "css.js",
    [
      "const token2CSSVar = (token, prefix) => `--${prefix}-${token}`;",
      "export const transformToken = (token, config) => {",
      "  const cssVars = {};",
      "  Object.entries(token).forEach(([key, value]) => {",
      "    cssVars[token2CSSVar(key, config.prefix)] = value;",
      "  });",
      "  return cssVars;",
      "};",
      // Negative, same module: `k:v;` declaration text is not a custom
      // property name. This is antd-style's `convertStylishToString` and
      // antd's watermark `getStyleStr`, the round-1 false positives.
      "export const serializeStyle = (style) =>",
      "  Object.keys(style).map((key) => `${key}:${style[key]};`).join('');",
    ].join("\n"),
  );
  // Module 2: the token, assembled the way antd assembles it — an object
  // literal behind a spread helper, a dot-write onto a merged local, and a
  // component token that only arrives through a parameter two calls up.
  await fixture.write(
    "theme.js",
    [
      "import { serializeStyle, transformToken } from './css.js';",
      "const seed = { colorPrimary: '#1677ff' };",
      "function formatToken(base) {",
      "  const merged = Object.assign({}, base);",
      "  merged.motionDurationFast = '0.1s';",
      "  return merged;",
      "}",
      "const buildToken = (overrides) => ({ ...formatToken(seed), ...overrides });",
      "export function useTheme(componentToken) {",
      "  return transformToken(buildToken(componentToken), { prefix: 'ant' });",
      "}",
      "export const render = () => {",
      "  useTheme({ iconGap: 8 });",
      "  return serializeStyle({ neverPinned: '1px' });",
      "};",
    ].join("\n"),
  );

  const result = await analyzeCssVariableProtocol([
    path.join(fixture.projectRoot, "css.js"),
    path.join(fixture.projectRoot, "theme.js"),
  ]);

  expect([...result.keyNames].sort()).toEqual([
    // Object-literal key behind a spread helper and a transparent merge.
    "colorPrimary",
    // Component token, reached only by expanding two call sites upward.
    "iconGap",
    // Dot-write onto the merged local the helper returns.
    "motionDurationFast",
  ]);
  expect(result.sinkSites.length).toBe(1);
  expect(result.sinkSites[0]).toContain("css.js");
});

// The `--` head is the whole discriminator. Enumerating an object and building
// a string out of its keys is ordinary — `pickAttrs`, `dequal` and every
// serializer do it — and pinning on that alone is what made the round-1 probe
// unusable. Without a custom-property name in the output, nothing is pinned.
test("enumeration without a `--` construction pins nothing", async () => {
  const { analyzeCssVariableProtocol } = await import(
    "../src/externs/css-variable-protocol.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "serialize.js",
    [
      // Declaration text: `k:v;`, no custom-property name.
      "export const toStyleString = (style) =>",
      "  Object.keys(style).map((key) => `${key}:${style[key]};`).join('');",
      // A computed read that copies keys through, with no string built at all.
      "export function pickAttrs(props) {",
      "  const picked = {};",
      "  for (const key in props) { picked[key] = props[key]; }",
      "  return picked;",
      "}",
      // A single hyphen is a CSS property name, not a custom property.
      "export const toRule = (rules) =>",
      "  Object.entries(rules).map(([key, value]) => `-${key}:${value}`).join('');",
    ].join("\n"),
  );
  await fixture.write(
    "app.js",
    [
      "import { pickAttrs, toRule, toStyleString } from './serialize.js';",
      "export const run = () => [",
      "  toStyleString({ fontSize: 12 }),",
      "  pickAttrs({ ariaLabel: 'x' }),",
      "  toRule({ webkitBoxOrient: 'vertical' }),",
      "];",
    ].join("\n"),
  );

  const result = await analyzeCssVariableProtocol([
    path.join(fixture.projectRoot, "serialize.js"),
    path.join(fixture.projectRoot, "app.js"),
  ]);

  expect([...result.keyNames]).toEqual([]);
  expect(result.sinkSites).toEqual([]);
});

// antd writes a nested selector as an element-name identifier key with an
// object value: `.anticon { svg: { display: 'block' } }` in
// antd/es/style/index.js. `parseStyle` prints such a key as a *selector*
// (`.anticon svg`), not a declaration, so a renamed key emits `.anticon RA`,
// the rule matches nothing, and the shifted rule text changes the cssinjs
// content hash — a prerendered shell then fails hydration (React #418).
// Cross-module flow cannot reach these objects (they pass through factory
// indirection), so the evidence is local shape: a literal is style-shaped
// when a string key carries selector syntax; its identifier keys with object
// values are selector element names.
test("element-name keys in selector position are rename evidence", async () => {
  const { analyzeCssVariableProtocol } = await import(
    "../src/externs/css-variable-protocol.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "style.js",
    [
      "export const genIconStyle = () => ({",
      "  anticon: {",
      // Selector position: identifier key, object value. Pinned.
      "    svg: { display: 'block' },",
      // Declaration: identifier key, scalar value. `parseStyle` hyphenates it
      // itself, so renaming is harmless and it stays out.
      "    lineHeight: 1,",
      // Already a literal in the output; nothing to rename. Its presence is
      // the style-shape evidence for this literal.
      "    '&:hover': { color: 'red' },",
      "    legend: { padding: 0 },",
      "  },",
      "});",
    ].join("\n"),
  );

  const result = await analyzeCssVariableProtocol([
    path.join(fixture.projectRoot, "style.js"),
  ]);

  // `anticon` keys a literal with no selector-syntax sibling, so the outer
  // object is not style-shaped and `anticon` stays renamable.
  expect([...result.keyNames].sort()).toEqual(["legend", "svg"]);
});

// Without style-shape evidence nothing pins; and inside a style-shaped
// literal, the `_skip_check_`/`_multi_value_` wrapper is a declaration,
// not a selector, so its key stays renamable too.
test("selector keys need style-shape evidence; wrappers stay out", async () => {
  const { analyzeCssVariableProtocol } = await import(
    "../src/externs/css-variable-protocol.ts"
  );
  const fixture = await createFixture();
  await fixture.write(
    "plain.js",
    "export const config = { anticon: { svg: { display: 'block' } } };\n",
  );
  await fixture.write(
    "wrapped.js",
    [
      "export const style = () => ({",
      "  '&:focus': { color: 'blue' },",
      "  margin: { _skip_check_: true, value: '0 0 0 8px' },",
      "});",
    ].join("\n"),
  );

  const result = await analyzeCssVariableProtocol([
    path.join(fixture.projectRoot, "plain.js"),
    path.join(fixture.projectRoot, "wrapped.js"),
  ]);

  expect([...result.keyNames]).toEqual([]);
});

// `@ant-design/cssinjs` marks an RTL-exempt CSS value with a wrapper object,
// `margin: { _skip_check_: true, value: "0 0 0 8px" }`, and recognises it with
// `SKIP_CHECK in value` where `const SKIP_CHECK = "_skip_check_"`. The key is
// an object-literal identifier, so it renames; the const string does not
// follow, `parseStyle` mistakes the wrapper for a nested selector and emits
// `.ant-tabs-tab margin{va:true;value:…}` instead of `.ant-tabs-tab{margin:…}`.
// The tabs lose their gap with no error anywhere.
test("keys read through a const-bound string are rename evidence", async () => {
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
      // The read side: a const string in `in` and in computed-index position.
      "const SKIP_CHECK = '_skip_check_';",
      "const MULTI_VALUE = '_multi_value_';",
      "export function isCompound(value) {",
      "  return typeof value === 'object' && value && (SKIP_CHECK in value || value[MULTI_VALUE]);",
      "}",
      // The definition side: plain object-literal identifier keys.
      "export const wrapped = { _skip_check_: true, value: '0 0 0 8px' };",
      "export const multi = { _multi_value_: true, value: [1, 2] };",
      // A const string that never reaches key position is not evidence.
      "const BANNER = 'headline';",
      "export const notice = { headline: 'hi' };",
      "export function log() { return BANNER; }",
      // A name declared twice is not a proven binding.
      "let mode = 'variant';",
      "mode = 'other';",
      "export const themed = { variant: 1 };",
      "export function pick(bag) { return bag[mode]; }",
      // A const key in ASSIGNMENT position defines, it does not read.
      "const SLOT = 'stored';",
      "export const box = { stored: 0 };",
      "export function put(bag, v) { bag[SLOT] = v; }",
    ].join("\n"),
  );

  const hazards = await analyzeRuntimeUsage(
    [path.join(fixture.projectRoot, "runtime.js")],
    { keyExclusionListCallees: [], keyReadCallees: [] },
  );
  expect(hazards.stringLiteralRead.has("_skip_check_")).toBe(true);
  expect(hazards.stringLiteralRead.has("_multi_value_")).toBe(true);
  expect(hazards.stringLiteralRead.has("headline")).toBe(false);
  expect(hazards.stringLiteralRead.has("variant")).toBe(false);
  expect(hazards.stringLiteralRead.has("stored")).toBe(false);

  const lines = collectRuntimeUsageExternLines(hazards, {
    dotAccessed: new Set(),
    stringLiteralRead: new Set(),
  });
  expect([...lines]).toContain("Object.prototype._skip_check_;");
  expect([...lines]).toContain("Object.prototype._multi_value_;");
  expect([...lines]).not.toContain("Object.prototype.headline;");
  expect([...lines]).not.toContain("Object.prototype.variant;");
  expect([...lines]).not.toContain("Object.prototype.stored;");
});
