import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture, findFilesNamed } from "./helpers.mjs";

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

    // Cost, one layer down: the value export is untouched -- it is what a
    // namespace import, a star re-export and the entry facade read -- and only
    // the two reassigned exports gained an accessor. `untouched` and `fixed` did
    // not, so a `const`-only module emits exactly the bytes it did before.
    const helperEmit = await fs.readFile(
      (await findFilesNamed(cacheDir, "helper.js")).find(
        (file) => file.includes("/native-emit/") && file.includes("/out/src/"),
      ),
      "utf8",
    );
    expect(helperEmit).toContain("exports.mutable = mutable;");
    expect(helperEmit).toContain("exports.__gccLive_mutable");
    expect(helperEmit).toContain("exports.__gccLive_alias");
    expect(helperEmit).not.toContain("__gccLive_untouched");
    expect(helperEmit).not.toContain("__gccLive_fixed");
    expect(helperEmit).not.toContain("__gccLive_renamed");

    // And Closure removes the indirection: the accessor is a one-line getter, so
    // the shipped bundle carries neither the function nor the property name.
    const bundle = await fixture.read("dist/entry.js");
    expect(bundle).not.toContain("__gccLive");
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
  "a const-only module keeps its snapshot export shape",
  { timeout: 30_000 },
  async () => {
    // The liveness machinery is scoped to provably-reassigned exports. Nothing
    // in a module without one may change, which is what keeps the corpus and the
    // property ledger stable -- every export in the examples is a `const`, a
    // function or a class.
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

    const emitted = await Promise.all(
      ["helper.js", "entry.js"].map(async (name) =>
        fs.readFile(
          (await findFilesNamed(cacheDir, name)).find(
            (file) => file.includes("/native-emit/") && file.includes("/out/src/"),
          ),
          "utf8",
        ),
      ),
    );
    for (const source of emitted) {
      expect(source).not.toContain("__gccLive");
    }
    // A `let` that is never written is still a plain snapshot alias.
    expect(emitted[1]).toContain("const neverWritten = __goog_import_0.neverWritten;");

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "const-only",
    );
    expect(module.probe()).toBe("TAG|2|TAG|1");
  },
);

async function importOutput(outputPath, tag) {
  return import(`${pathToFileURL(outputPath).href}?${tag}=${importCounter++}`);
}
