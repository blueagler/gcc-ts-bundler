import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture } from "./helpers.mjs";

/**
 * Regressions for the three post-Closure rewrites this pipeline used to run on
 * optimizer output. Each one guessed at semantics Closure had already erased,
 * and each one is reproduced here as the concrete miscompilation it caused:
 *
 * - the ES5 helper "fingerprint" matcher deleted any user function whose shape
 *   resembled a tslib helper and substituted a helper with different behaviour;
 * - the decorator-metadata rewrite respelled string literals from the
 *   property-renaming report, including keys of network JSON;
 * - the runtime-root canonicaliser ran `String.replaceAll` over minified
 *   JavaScript, hitting string literals and unrelated property accesses.
 *
 * All three are now handled before Closure runs, so these fixtures must come
 * through byte-faithful and behave exactly as written.
 */

async function buildEs5Fixture(files, overrides = {}) {
  const fixture = await createFixture();
  for (const [relativePath, contents] of Object.entries(files)) {
    await fixture.write(relativePath, contents);
  }
  const result = await build({
    cache: { mode: "off" },
    chunks: { mode: "bundler-runtime" },
    entries: ["./main.ts"],
    languageOut: "ECMASCRIPT5",
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(
      `fixture build failed: ${JSON.stringify(result.diagnostics)}\n${result.diagnostics
        .map((diagnostic) => `${diagnostic.file ?? ""}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return { fixture, result };
}

/**
 * The bundler-runtime preamble reads `document.currentScript` and
 * `location.href` to resolve chunk URLs, so evaluating a script chunk outside a
 * browser needs both present.
 */
async function evalInBrowserStub(code) {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousRuntime = globalThis.__g;
  const previousGcc = globalThis.$gcc;
  globalThis.document = {
    createElement: () => ({}),
    currentScript: { src: "https://example.test/main.js" },
    documentElement: { appendChild: () => {} },
    head: { appendChild: () => {} },
    querySelectorAll: () => [],
  };
  globalThis.location = { href: "https://example.test/index.html" };
  // Start from a clean runtime root. The preamble is `a = e.__g || (e.__g = {})`
  // and self-guards on its own renamed ready flag, so a runtime left on
  // globalThis by a concurrently-running test file -- renamed from a different
  // name pool -- makes this chunk skip initialisation and then call a function
  // its own naming never defined.
  delete globalThis.__g;
  delete globalThis.$gcc;
  try {
    (0, eval)(code);
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
    if (previousRuntime === undefined) delete globalThis.__g;
    else globalThis.__g = previousRuntime;
    if (previousGcc === undefined) delete globalThis.$gcc;
    else globalThis.$gcc = previousGcc;
  }
}

test.serial(
  "keeps a user function that matches the retired tslib fingerprint",
  { timeout: 20000 },
  async () => {
    // Three parameters, a "name" string, Object.defineProperty and a return:
    // the exact shape the old classifier accepted as `__setFunctionName`. It
    // replaced this body with tslib's, turning `"b" + "a"` into `"b" + " " + "a"`.
    const { fixture, result } = await buildEs5Fixture({
      "src/main.ts": [
        "function labelize(target: object, label: string, prefix: string) {",
        '  return Object.defineProperty(target, "name", {',
        "    configurable: true,",
        "    value: prefix + label,",
        "  });",
        "}",
        "",
        "// Three parameters, `arguments`, `.call`, a loop and a return: the old",
        "// `__runInitializers` fingerprint.",
        "function applyAll(context: object, steps: Array<(value: number) => number>, seed: number) {",
        "  const useSeed = arguments.length > 2;",
        "  let value = seed;",
        "  for (let index = 0; index < steps.length; index += 1) {",
        "    value = useSeed",
        "      ? steps[index]!.call(context, value)",
        "      : steps[index]!.call(context, 0);",
        "  }",
        "  return useSeed ? value : 0;",
        "}",
        "",
        '(globalThis as any)["__probe"] = () => [',
        '  String((labelize({}, "a", "b") as { name: string }).name),',
        "  applyAll({}, [(value: number) => value + 1], 1),",
        "];",
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/main.js");
    // The helper bag the old rewriter installed is gone entirely.
    expect(output).not.toContain("globalThis.__g._");
    expect(output).not.toMatch(/_\[\d\]=function/u);

    const previousProbe = globalThis.__probe;
    try {
      await evalInBrowserStub(output);
      const [labelledName, applied] = globalThis.__probe();
      // tslib's `__setFunctionName` would produce "b a" here.
      expect(labelledName).toBe("ba");
      expect(applied).toBe(2);
    } finally {
      if (previousProbe === undefined) {
        delete globalThis.__probe;
      } else {
        globalThis.__probe = previousProbe;
      }
    }
  },
);

test.serial(
  "leaves dictionary key comparisons and label lists alone",
  { timeout: 20000 },
  async () => {
    // `data` comes from the network, so its keys are never renamed. The old
    // decorator-metadata rewrite respelled `"variant"` to whatever Closure had
    // renamed some unrelated property to, and did the same to the label list.
    const { fixture, result } = await buildEs5Fixture({
      "src/main.ts": [
        "interface Widget { variant: string; size: string }",
        "const widget: Widget = { variant: 'a', size: 'b' };",
        "",
        "function inspect(raw: string) {",
        "  const data: Record<string, unknown> = JSON.parse(raw);",
        "  const found: string[] = [];",
        "  for (const key in data) {",
        '    if (key === "variant") {',
        "      found.push(String(data[key]));",
        "    }",
        "  }",
        '  const labels = "variant size".split(" ");',
        "  return [found, labels, widget.variant];",
        "}",
        "",
        '(globalThis as any)["__inspect"] = inspect;',
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/main.js");
    // Closure folds `"variant size".split(" ")` into an array literal; both the
    // comparison key and the folded list must keep their authored spelling.
    expect(output).toMatch(/["'`]variant["'`]/u);
    expect(output).toMatch(/["'`]size["'`]/u);

    const previousInspect = globalThis.__inspect;
    try {
      await evalInBrowserStub(output);
      const [found, labels] = globalThis.__inspect(
        '{"variant":"solid","size":"lg"}',
      );
      expect(found).toEqual(["solid"]);
      expect(labels).toEqual(["variant", "size"]);
    } finally {
      if (previousInspect === undefined) {
        delete globalThis.__inspect;
      } else {
        globalThis.__inspect = previousInspect;
      }
    }
  },
);

test.serial(
  "leaves string literals and property chains alone in script chunks",
  { timeout: 20000 },
  async () => {
    // `canonicalizeBundlerRuntimeRootAccess` replaced every `<alias>.` in the
    // file, so a minified alias named `b` rewrote `"tab.js"` to `"taG.js"` and
    // `o.b.c` to `o.G.c`.
    const { fixture, result } = await buildEs5Fixture({
      "src/main.ts": [
        "const nested = { b: { c: 41 } };",
        'const assetUrl = "https://cdn.example.com/tab.js";',
        '(globalThis as any)["__asset"] = () => ({',
        "  url: assetUrl,",
        "  value: nested.b.c + 1,",
        "});",
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/main.js");
    expect(output).toContain("https://cdn.example.com/tab.js");
    expect(output).not.toContain("taG.js");

    const previousAsset = globalThis.__asset;
    try {
      await evalInBrowserStub(output);
      const asset = globalThis.__asset();
      expect(asset.url).toBe("https://cdn.example.com/tab.js");
      expect(asset.value).toBe(42);
    } finally {
      if (previousAsset === undefined) {
        delete globalThis.__asset;
      } else {
        globalThis.__asset = previousAsset;
      }
    }
  },
);

test.serial(
  "drops framework bundler directives from terminal browser output",
  { timeout: 20000 },
  async () => {
    const { fixture, result } = await buildEs5Fixture({
      "src/client-only.ts": [
        '"use client";',
        "export const clientValue = 7;",
        "",
      ].join("\n"),
      "src/server-only.ts": [
        '"use server";',
        "export const serverValue = 8;",
        "",
      ].join("\n"),
      "src/main.ts": [
        'import { clientValue } from "./client-only";',
        'import { serverValue } from "./server-only";',
        "",
        '(globalThis as any)["__directives"] = () => clientValue + serverValue;',
        // A string statement that is not in the directive prologue is data, not
        // a directive, and has to survive.
        'const note = "use client";',
        '(globalThis as any)["__note"] = () => note;',
        "",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    const output = await fixture.read("dist/main.js");
    expect(output).not.toMatch(/^\s*"use client";/mu);
    expect(output).not.toMatch(/;"use server";/u);

    const previousDirectives = globalThis.__directives;
    const previousNote = globalThis.__note;
    try {
      await evalInBrowserStub(output);
      expect(globalThis.__directives()).toBe(15);
      expect(globalThis.__note()).toBe("use client");
    } finally {
      if (previousDirectives === undefined) {
        delete globalThis.__directives;
      } else {
        globalThis.__directives = previousDirectives;
      }
      if (previousNote === undefined) {
        delete globalThis.__note;
      } else {
        globalThis.__note = previousNote;
      }
    }
  },
);
