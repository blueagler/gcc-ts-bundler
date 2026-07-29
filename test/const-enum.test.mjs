import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture, findFilesNamed } from "./helpers.mjs";

/**
 * `const enum` has no runtime representation in TypeScript: the object is
 * erased and every member read is inlined at the use site. We used to
 * synthesise a `@enum` object for it anyway, which made the erased value
 * observable (`import * as m from "./x"; m.ConstEnum` returned an object where
 * `tsc` returns `undefined`) and shipped bytes no legal program can reach —
 * TypeScript rejects every use of a const enum outside a property access.
 *
 * That divergence is what the tsickle `export` corpus suite caught.
 */

let importCounter = 0;

const HELPER = [
  "export const enum ConstEnum { AValue = 1, BValue = 2 }",
  'export const enum StrConst { S = "s" }',
  "export enum PlainEnum { X = 10, Y = 20 }",
  "",
].join("\n");

const ENTRY = [
  'import { ConstEnum, PlainEnum, StrConst } from "./helper";',
  "export function readConst(): number { return ConstEnum.AValue + ConstEnum.BValue; }",
  "export function readPlain(): number { return PlainEnum.X + PlainEnum.Y; }",
  'export function readStr(): string { return StrConst.S; }',
  'export function probe(): string { return [readConst(), readPlain(), readStr()].join("|"); }',
  "",
].join("\n");

async function buildConstEnumFixture(options = {}) {
  const fixture = await createFixture();
  await fixture.write("src/helper.ts", HELPER);
  await fixture.write("src/entry.ts", ENTRY);
  const result = await build({
    cache: { mode: "off" },
    entries: ["./entry.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    ...options,
  });
  expect(
    result.ok,
    (result.diagnostics ?? []).map(({ message }) => message).join("\n"),
  ).toBe(true);
  return fixture;
}

test.serial(
  "const enums are erased at runtime while their reads keep working",
  { timeout: 30_000 },
  async () => {
    const fixture = await buildConstEnumFixture();
    const outputPath = path.join(fixture.outDir, "entry.js");
    const module = await import(
      `${pathToFileURL(outputPath).href}?const-enum=${importCounter++}`
    );

    // Values first: erasing the object must not change what the program
    // computes. `tsc` on the same fixture prints exactly this.
    expect(module.probe()).toBe("3|30|s");
    expect(module.readConst()).toBe(3);
    expect(module.readStr()).toBe("s");

    // The erased object is not observable — this is the assertion the corpus
    // `export` suite makes, where the reference gives `undefined` and we used
    // to give an object.
    expect(module.ConstEnum).toBeUndefined();
    expect(module.StrConst).toBeUndefined();
  },
);

test.serial(
  "the const-enum declaration never reaches the Closure inputs",
  { timeout: 30_000 },
  async () => {
    // Emit-shape check, one layer below the bundle: the declaration is dropped
    // from the emitted module rather than being lowered by SWC into the
    // `var E = function(E){…}({})` form, which is what happened when the
    // metadata simply stopped describing it. The final bundle cannot show this
    // — Closure folds every read to a constant and deletes all three objects.
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/helper.ts", HELPER);
    await fixture.write("src/entry.ts", ENTRY);
    const result = await build({
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(result.ok).toBe(true);

    const nativeEmit = (files) =>
      files.find((file) => file.includes("/native-emit/") && file.includes("/out/src/"));

    const helperSource = await Bun.file(
      nativeEmit(await findFilesNamed(cacheDir, "helper.js")),
    ).text();
    expect(helperSource).not.toContain("ConstEnum");
    expect(helperSource).not.toContain("StrConst");
    expect(helperSource).not.toContain("AValue");
    // The rule is about `const`, not about enums: a plain enum keeps the
    // runtime object, and erasing it would be wrong in the other direction.
    expect(helperSource).toContain("PlainEnum");

    const entrySource = await Bun.file(
      nativeEmit(await findFilesNamed(cacheDir, "entry.js")),
    ).text();
    // Reads are inlined from the TypeScript AST before `strip` runs, which is
    // why erasing the object is safe.
    expect(entrySource).toContain("1 + 2");
    expect(entrySource).toContain('"s"');
    expect(entrySource).not.toContain("ConstEnum.AValue");
  },
);

test.serial(
  "const-enum semantics survive the type-inference escape hatch",
  { timeout: 60_000 },
  async () => {
    // Enum lowering must not depend on type metadata: with inference disabled
    // the metadata channel is silent and the inliner is the only thing
    // resolving members.
    //
    // Run in a child process on purpose. `GCC_DISABLE_TYPE_INFERENCE` is read
    // from the environment, and bun runs test *files* concurrently, so setting
    // it in-process leaks into every other file's builds — which is exactly
    // how this test first showed up as five unrelated failures elsewhere.
    const fixture = await createFixture();
    await fixture.write("src/helper.ts", HELPER);
    await fixture.write("src/entry.ts", ENTRY);
    const driver = path.join(fixture.projectRoot, "build.mjs");
    await fixture.write(
      "build.mjs",
      [
        `import { build } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "dist", "index.mjs")).href)};`,
        "const result = await build({",
        '  cache: { mode: "off" },',
        '  entries: ["./entry.ts"],',
        `  outDir: ${JSON.stringify(fixture.outDir)},`,
        `  projectRoot: ${JSON.stringify(fixture.projectRoot)},`,
        `  srcDir: ${JSON.stringify(fixture.srcDir)},`,
        "});",
        "if (!result.ok) {",
        "  console.error(JSON.stringify(result.diagnostics));",
        "  process.exit(1);",
        "}",
        `const m = await import(${JSON.stringify(pathToFileURL(path.join(fixture.outDir, "entry.js")).href)});`,
        'console.log(JSON.stringify({ constEnum: m.ConstEnum ?? null, probe: m.probe() }));',
        "",
      ].join("\n"),
    );

    const child = Bun.spawnSync({
      cmd: ["node", driver],
      env: { ...process.env, GCC_DISABLE_TYPE_INFERENCE: "1" },
    });
    const stdout = child.stdout.toString().trim();
    expect(child.exitCode, `${stdout}\n${child.stderr.toString()}`).toBe(0);
    const observed = JSON.parse(stdout.split("\n").at(-1));
    expect(observed.probe).toBe("3|30|s");
    expect(observed.constEnum).toBeNull();
  },
);

test.serial(
  "preserveConstEnums keeps the object TypeScript would keep",
  { timeout: 30_000 },
  async () => {
    // The rule is keyed on the compiler options that own the question, not on
    // a name list: with `preserveConstEnums` TypeScript emits the object, so
    // erasing it would be the divergence.
    const fixture = await createFixture();
    await fixture.write(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "bundler",
            preserveConstEnums: true,
            strict: true,
            target: "ESNext",
          },
        },
        null,
        2,
      ),
    );
    await fixture.write("src/helper.ts", HELPER);
    await fixture.write("src/entry.ts", ENTRY);
    const result = await build({
      cache: { mode: "off" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expect(
      result.ok,
      (result.diagnostics ?? []).map(({ message }) => message).join("\n"),
    ).toBe(true);

    const outputPath = path.join(fixture.outDir, "entry.js");
    const module = await import(
      `${pathToFileURL(outputPath).href}?const-enum-preserve=${importCounter++}`
    );
    expect(module.probe()).toBe("3|30|s");
  },
);
