import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../../dist/index.mjs";
import { createFixture } from "../helpers.mjs";

/**
 * ES modules export *bindings*, not values: when the exporting module reassigns
 * an exported binding, every importer observes the new value. `tsc` + Node do,
 * and so does every other bundler.
 *
 * The `goog.module` output shape did not. `exports.X = X;` was written once at
 * declaration time and the importer aliased it with `const X = require(...).X;`
 * -- two snapshots -- so a mutation was invisible across module boundaries while
 * the exporting module itself saw it. A silent value divergence, not a build
 * error, in the default (unchunked) build.
 *
 * The chunked shapes were already correct: the bundler runtime classifies an
 * export as `Static` or `Live` and gives a live one a getter slot, and hoisted
 * output is live by construction because the importer references the exporter's
 * variable. These tests cover all three shapes so the three cannot drift.
 */

let importCounter = 0;

test.serial(
  "a dependent chunk binds the hoisted import, not the shadowing base-chunk name",
  { timeout: 30_000 },
  async () => {
    // After `Id`/`SyntaxContext` becomes `SymbolId`/`Scoping`, a mis-tracked
    // symbol makes `hoist`/`emit_hoist` emit a *direct* binding to the wrong
    // declaration -- and nothing fails to compile. Here the base chunk holds
    // two top-level `label` declarations after hoisting (its own, plus
    // `shared`'s) and the lazy chunk references `shared`'s across the chunk
    // boundary. The identity decision is observable only by running both:
    // picking the base chunk's own `label` yields "MAIN_..." in the lazy chunk.
    // Values, not output text -- the goldens already cover text.
    //
    // Every label is derived from a `globalThis` read so Closure cannot fold it.
    // With plain string constants, constant propagation answers the question at
    // compile time and inlines the literal into the lazy chunk, so the runtime
    // never touches the binding and the test passes vacuously.
    const fixture = await createFixture();
    await fixture.write(
      "src/shared.ts",
      [
        "export const label = (): string =>",
        '  "SHARED_" + (globalThis as Record<string, unknown>)["__oxcSalt"];',
        "export function readLabel(): string { return label(); }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/feature.ts",
      [
        'import { label } from "./shared";',
        'const inner = "FEATURE_LOCAL";',
        "export function describe(): string { return label() + `|` + inner; }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        // Same top-level name as `shared`'s export, different value.
        "const label = (): string =>",
        '  "MAIN_" + (globalThis as Record<string, unknown>)["__oxcSalt"];',
        'import { readLabel } from "./shared";',
        'const load = () => import("./feature");',
        '(globalThis as Record<string, unknown>)["__oxcBase"] = () =>',
        "  label() + `|` + readLabel();",
        '(globalThis as Record<string, unknown>)["__oxcLazy"] = () =>',
        "  load().then((m) => m.describe());",
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
    expectBuilt(result);

    // Pin that this is really a cross-chunk case: two chunks, one of which is
    // loaded on demand by the other.
    const chunkFiles = result.outputFiles.filter((file) => file.endsWith(".js"));
    expect(chunkFiles).toHaveLength(2);
    const baseFile = chunkFiles.find((file) => file.endsWith("main.js"));
    const lazyFile = chunkFiles.find((file) => file !== baseFile);
    expect(baseFile).toBeTruthy();
    expect(lazyFile).toBeTruthy();

    // Run in a child process on purpose. Loading a chunked bundle installs a
    // runtime registry on `globalThis.__g` and needs `document`/`location`
    // stubs, and bun runs test *files* concurrently -- sharing those globals
    // with the chunk tests in `chunks-runtime.test.mjs` makes the two races and
    // fails with an unregistered-module error. A child process owns its globals.
    await fixture.write(
      "run.mjs",
      [
        'globalThis.document = { body: { textContent: "" } };',
        `globalThis.location = { href: ${JSON.stringify(pathToFileURL(baseFile).href)} };`,
        'globalThis["__oxcSalt"] = "SALT";',
        `await import(${JSON.stringify(pathToFileURL(baseFile).href)});`,
        "console.log(JSON.stringify({",
        '  base: globalThis["__oxcBase"](),',
        '  lazy: await globalThis["__oxcLazy"](),',
        "}));",
        "",
      ].join("\n"),
    );
    const child = Bun.spawnSync({
      cmd: ["node", path.join(fixture.projectRoot, "run.mjs")],
    });
    const stdout = child.stdout.toString().trim();
    expect(child.exitCode, `${stdout}\n${child.stderr.toString()}`).toBe(0);
    const observed = JSON.parse(stdout.split("\n").at(-1));

    expect(observed.base).toBe("MAIN_SALT|SHARED_SALT");
    // The identity decision under test: the lazy chunk's `label` is `shared`'s
    // hoisted binding, not the base chunk's shadowing one.
    expect(observed.lazy).toBe("SHARED_SALT|FEATURE_LOCAL");
  },
);

for (const mode of ["off", "split", "bundler-runtime"]) {
  test.serial(
    `default expressions snapshot imported values while default aliases stay live (${mode})`,
    { timeout: 30_000 },
    async () => {
      const fixture = await createFixture();
      await fixture.write(
        "src/a.ts",
        "export let x = 1; export function bump() { x++; }\n",
      );
      await fixture.write(
        "src/b.ts",
        [
          'import { x } from "./a";',
          "export default x;",
          'export { x as live } from "./a";',
        ].join("\n"),
      );
      await fixture.write(
        "src/c.ts",
        [
          // Declaration order does not change an imported binding's identity.
          "export { x as default };",
          'import { x } from "./a";',
        ].join("\n"),
      );
      await fixture.write(
        "src/d.ts",
        'export { x as default } from "./a";\n',
      );
      await fixture.write(
        "src/main.ts",
        [
          'import snapshot, { live } from "./b";',
          'import localDefault from "./c";',
          'import forwardedDefault from "./d";',
          'import { bump } from "./a";',
          "bump();",
          '(globalThis as Record<string, unknown>)["__exportTopology"] =',
          "  [snapshot, live, localDefault, forwardedDefault];",
        ].join("\n"),
      );
      const result = await build({
        cache: { mode: "off" },
        chunks: { mode, publicPath: "./" },
        entries: ["./main.ts"],
        outDir: fixture.outDir,
        projectRoot: fixture.projectRoot,
        srcDir: fixture.srcDir,
      });
      expectBuilt(result);
      const mainFile = path.join(fixture.outDir, "main.js");
      await fixture.write(
        "run.mjs",
        [
          'globalThis.document = { body: { textContent: "" } };',
          `globalThis.location = { href: ${JSON.stringify(pathToFileURL(mainFile).href)} };`,
          `await import(${JSON.stringify(pathToFileURL(mainFile).href)});`,
          'console.log(JSON.stringify(globalThis["__exportTopology"]));',
        ].join("\n"),
      );
      const child = Bun.spawnSync({
        cmd: ["node", path.join(fixture.projectRoot, "run.mjs")],
      });
      const stdout = child.stdout.toString().trim();
      expect(child.exitCode, `${stdout}\n${child.stderr.toString()}`).toBe(0);
      expect(JSON.parse(stdout.split("\n").at(-1))).toEqual([1, 2, 2, 2]);
    },
  );
}

const HELPER = [
  "export let mutable = 1;",
  "export let untouched = 5;",
  "export const fixed = 9;",
  "export function bump(): number {",
  "  mutable = mutable + 1;",
  "  return mutable;",
  "}",
  "// The exporting module's own view, for comparison with the importer's.",
  "export function readMutable(): number { return mutable; }",
  "export function shadowed(): number { const mutable = 100; return mutable; }",
  "let renamed = 2;",
  "export function bumpRenamed(): number { renamed += 3; return renamed; }",
  "export { renamed as alias };",
  "",
].join("\n");

function expectBuilt(result) {
  expect(
    result.ok,
    (result.diagnostics ?? []).map(({ message }) => message).join("\n"),
  ).toBe(true);
}

test.serial(
  "an importer observes a reassignment of an exported binding",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/helper.ts", HELPER);
    await fixture.write(
      "src/entry.ts",
      [
        "import {",
        "  alias,",
        "  bump,",
        "  bumpRenamed,",
        "  fixed,",
        "  mutable,",
        "  readMutable,",
        "  shadowed,",
        "  untouched,",
        '} from "./helper";',
        "export function probe(): string {",
        // Read before any mutation, so a stale *and* an eagerly-evaluated
        // implementation are both visible in the result.
        "  const before = mutable;",
        "  bump();",
        "  bump();",
        "  bumpRenamed();",
        "  return [",
        "    before,",
        "    mutable,",
        "    readMutable(),",
        "    alias,",
        "    fixed,",
        "    untouched,",
        "    shadowed(),",
        '  ].join("|");',
        "}",
        "",
      ].join("\n"),
    );

    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expectBuilt(result);

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "live-bindings",
    );

    // before=1 (read before the mutations), mutable=3 (two bumps -- this is the
    // defect: it read 1), the exporter's own view agrees at 3, the renamed
    // export `alias` is live at 5, `fixed`/`untouched` are unchanged, and the
    // function-local `mutable` in `shadowed()` was not confused with the export.
    expect(module.probe()).toBe("1|3|3|5|9|5|100");
  },
);

test.serial(
  "a reassigned export stays live across a lazy chunk boundary",
  { timeout: 30_000 },
  async () => {
    // Same contract, the other two emitters: the base chunk is scope-hoisted and
    // the lazy chunk goes through the bundler runtime's export slots. Executed in
    // a child process because loading a chunked bundle installs a runtime
    // registry on `globalThis.__g`, and bun runs test files concurrently.
    const fixture = await createFixture();
    await fixture.write("src/helper.ts", HELPER);
    await fixture.write(
      "src/lazy.ts",
      [
        'import { mutable, readMutable } from "./helper";',
        "export function read(): string {",
        '  return [mutable, readMutable()].join("|");',
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/main.ts",
      [
        'import { bump, mutable, readMutable } from "./helper";',
        '(globalThis as Record<string, unknown>)["__liveBase"] = () => {',
        "  bump();",
        '  return [mutable, readMutable()].join("|");',
        "};",
        '(globalThis as Record<string, unknown>)["__liveLazy"] = () =>',
        '  import("./lazy").then((m) => m.read());',
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
    expectBuilt(result);

    const baseFile = result.outputFiles.find((file) => file.endsWith("main.js"));
    expect(baseFile).toBeTruthy();
    await fixture.write(
      "run.mjs",
      [
        'globalThis.document = { body: { textContent: "" } };',
        `globalThis.location = { href: ${JSON.stringify(pathToFileURL(baseFile).href)} };`,
        `await import(${JSON.stringify(pathToFileURL(baseFile).href)});`,
        "console.log(JSON.stringify({",
        '  base: globalThis["__liveBase"](),',
        '  lazy: await globalThis["__liveLazy"](),',
        "}));",
        "",
      ].join("\n"),
    );
    const child = Bun.spawnSync({
      cmd: ["node", path.join(fixture.projectRoot, "run.mjs")],
    });
    const stdout = child.stdout.toString().trim();
    expect(child.exitCode, `${stdout}\n${child.stderr.toString()}`).toBe(0);
    const observed = JSON.parse(stdout.split("\n").at(-1));

    // One bump before either read: both chunks see 2, and both agree with the
    // exporting module's own view.
    expect(observed.base).toBe("2|2");
    expect(observed.lazy).toBe("2|2");
  },
);

test.serial(
  "constant and never-written exports preserve their values",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      [
        'export const tag = "TAG";',
        "export let neverWritten = 2;",
        "export function read(): string { return tag; }",
        "export class Box { value = 1; }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { Box, neverWritten, read, tag } from "./helper";',
        "export function probe(): string {",
        '  return [tag, neverWritten, read(), new Box().value].join("|");',
        "}",
        "",
      ].join("\n"),
    );

    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expectBuilt(result);

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "const-only",
    );
    expect(module.probe()).toBe("TAG|2|TAG|1");
  },
);

test.serial(
  "public ESM bindings follow package, namespace, star, alias and mts resolution",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "node_modules/live-counter/package.json",
      JSON.stringify({ name: "live-counter", type: "module", exports: "./index.js" }),
    );
    await fixture.write(
      "node_modules/live-counter/index.js",
      [
        "export let count = 0;",
        "export { count as first, count as second };",
        "export const fixed = 41;",
        "export function bump() { count++; }",
      ].join("\n"),
    );
    await fixture.write("src/star.ts", 'export * from "live-counter";\n');
    await fixture.write(
      "src/relay.ts",
      'export { count as relayed, first, second, bump, fixed } from "./star";\n',
    );
    await fixture.write(
      "src/local.mts",
      "export let local = 10; export function bumpLocal() { local += 2; }\n",
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { count, bump } from "live-counter";',
        'import * as counter from "live-counter";',
        'import * as sameCounter from "live-counter";',
        'import { relayed, first, second } from "./relay";',
        'import { local, bumpLocal } from "./local.mjs";',
        'export { count, first, second, bump, fixed } from "live-counter";',
        'export { relayed } from "./relay";',
        'export { local, bumpLocal } from "./local.mjs";',
        "export { counter };",
        'export const __gccBinding_probe = "unchanged";',
        'export const __gccBindingProtocol__ = "user-value";',
        "export function read() { return [count, counter.count, relayed, first, second, local]; }",
        "export function mutate() { bump(); bumpLocal(); }",
        "export function sameNamespace() { return counter === sameCounter; }",
      ].join("\n"),
    );
    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "off", outputType: "esm" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expectBuilt(result);
    const output = await importOutput(path.join(fixture.outDir, "entry.js"), "package-live");
    expect(output.read()).toEqual([0, 0, 0, 0, 0, 10]);
    expect(output.sameNamespace()).toBe(true);
    output.mutate();
    expect(output.read()).toEqual([1, 1, 1, 1, 1, 12]);
    expect([output.count, output.first, output.second, output.relayed, output.local]).toEqual([1, 1, 1, 1, 12]);
    output.bump();
    expect(output.counter.count).toBe(2);
    expect(output.count).toBe(2);
    expect(output.fixed).toBe(41);
    expect(output.__gccBinding_probe).toBe("unchanged");
    expect(output.__gccBindingProtocol__).toBe("user-value");
  },
);

async function importOutput(outputPath, tag) {
  return import(`${pathToFileURL(outputPath).href}?${tag}=${importCounter++}`);
}
