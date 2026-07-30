import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import { build } from "../dist/index.mjs";
import { createFixture } from "./helpers.mjs";

/**
 * End-to-end execution of the ES5 chunked delivery path.
 *
 * `chunks.outputType: "auto"` resolves to `"script"` at `ECMASCRIPT5` because
 * ES5 consumers cannot load native modules, so lazy chunks arrive as classic
 * scripts through the runtime's script loader: `document.createElement`, a
 * `document.currentScript`-relative URL, `head.appendChild`, and a load event
 * that resolves the pending import. Nothing else in the suite runs that
 * envelope — the other ES5 tests execute a single chunk, and the chunk tests
 * assert output shape without executing it. This is the coverage the deleted
 * lit-playground example used to carry as a manual build.
 */
test(
  "an ES5 lazy chunk loads and resolves through the script-loader envelope",
  { timeout: 300_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/main.ts",
      [
        'const load = () => import("./feature");',
        '(globalThis as any)["__loadFeature"] = async () => {',
        "  const featureModule = await load();",
        "  return featureModule.describe();",
        "};",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      [
        "export function describe() {",
        '  return "lazy:" + [1, 2, 3].map((value) => value * 2).join(",");',
        "}",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "bundler-runtime", publicPath: "./" },
      entries: ["./main.ts"],
      languageOut: "ECMASCRIPT5",
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const outputNames = result.outputFiles.map((filePath) =>
      path.basename(filePath),
    );
    const lazyName = outputNames.find((name) => name !== "main.js");
    expect(lazyName).toBeTruthy();

    const entryCode = await fs.readFile(
      path.join(fixture.outDir, "main.js"),
      "utf8",
    );
    // Classic scripts, not modules: no import/export in the emitted entry.
    expect(entryCode).not.toMatch(/^\s*(import|export)\s/mu);

    const previousDocument = globalThis.document;
    const previousLocation = globalThis.location;
    const previousRuntime = globalThis.__g;
    const previousGcc = globalThis.$gcc;
    const previousLoad = globalThis.__loadFeature;
    const requestedUrls = [];

    // A browser stub that actually serves the lazy chunk: the loader appends a
    // script element, so this evaluates the matching output file and fires the
    // load event the runtime waits on.
    const createScriptElement = () => {
      const element = { onerror: null, onload: null, src: "" };
      return element;
    };
    globalThis.document = {
      createElement: createScriptElement,
      currentScript: { src: "https://example.test/main.js" },
      documentElement: { appendChild: () => {} },
      head: {
        appendChild(element) {
          requestedUrls.push(element.src);
          const requestedName = path.basename(
            element.src.split("?")[0] ?? element.src,
          );
          void fs
            .readFile(path.join(fixture.outDir, requestedName), "utf8")
            .then((chunkCode) => {
              (0, eval)(chunkCode);
              element.onload?.();
            })
            .catch((error) => {
              element.onerror?.(error);
            });
          return element;
        },
      },
      querySelectorAll: () => [],
    };
    globalThis.location = { href: "https://example.test/index.html" };
    delete globalThis.__g;
    delete globalThis.$gcc;

    try {
      (0, eval)(entryCode);
      expect(await globalThis.__loadFeature()).toBe("lazy:2,4,6");
      expect(requestedUrls.length).toBe(1);
      expect(path.basename(requestedUrls[0].split("?")[0])).toBe(lazyName);
    } finally {
      globalThis.document = previousDocument;
      globalThis.location = previousLocation;
      if (previousRuntime === undefined) delete globalThis.__g;
      else globalThis.__g = previousRuntime;
      if (previousGcc === undefined) delete globalThis.$gcc;
      else globalThis.$gcc = previousGcc;
      if (previousLoad === undefined) delete globalThis.__loadFeature;
      else globalThis.__loadFeature = previousLoad;
    }
  },
);
