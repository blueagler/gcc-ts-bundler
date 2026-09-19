import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../../dist/index.mjs";
import { createFixture, findFilesNamed } from "../helpers.mjs";

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

async function importOutput(outputPath, tag) {
  return import(`${pathToFileURL(outputPath).href}?${tag}=${importCounter++}`);
}

function expectBuilt(result) {
  expect(
    result.ok,
    (result.diagnostics ?? []).map(({ message }) => message).join("\n"),
  ).toBe(true);
}

test.serial(
  "const-enum members defined by constant expressions inline cross-module",
  { timeout: 30_000 },
  async () => {
    // Erasing the enum object requires resolving the complete expression chain:
    // an unfolded member cannot fall back to a runtime enum read.
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      [
        "export const enum Dir {",
        "  Up = 1,",
        "  Down = 1 + Up,",
        "  Both = Down << 2,",
        "  Neg = -Down,",
        "  Mask = Both | Up,",
        "}",
        'export const enum Label { S = "s" }',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { Dir, Label } from "./helper";',
        'export * from "./helper";',
        "export function probe(): string {",
        "  return [Dir.Up, Dir.Down, Dir.Both, Dir.Neg, Dir.Mask, Label.S].join(",
        '    "|",',
        "  );",
        "}",
        "export function sum(): number { return Dir.Down + Dir.Both + Dir.Mask; }",
        "export const inTypePosition: Dir.Both = Dir.Both;",
        "export function branch(value: Dir): string {",
        "  switch (value) {",
        '    case Dir.Both: return "both";',
        '    case Dir.Neg: return "neg";',
        '    default: return "other";',
        "  }",
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
      "const-enum-expr",
    );

    // Up=1, Down=1+1=2, Both=2<<2=8, Neg=-2, Mask=8|1=9.
    expect(module.probe()).toBe("1|2|8|-2|9|s");
    expect(module.sum()).toBe(19);
    expect(module.inTypePosition).toBe(8);
    expect(module.branch(8)).toBe("both");
    expect(module.branch(-2)).toBe("neg");
    expect(module.branch(1)).toBe("other");

    // The enum object stays erased -- the values above came from inlining, not
    // from a preserved runtime object we could have read through.
    expect(module.Dir).toBeUndefined();
    expect(module.Label).toBeUndefined();

    // One layer below the bundle: no member read survives into Closure's input,
    // which is what "the folder owns it" means. Name-only, no shape.
    const entryEmit = await fs.readFile(
      (await findFilesNamed(cacheDir, "entry.js")).find(
        (file) => file.includes("/native-emit/") && file.includes("/out/src/"),
      ),
      "utf8",
    );
    expect(entryEmit).not.toContain("Dir.");
    expect(entryEmit).not.toContain("Label.");
  },
);

test.serial(
  "a forward reference to an exported enum reads undefined instead of throwing",
  { timeout: 30_000 },
  async () => {
    // `tsc` lowers an exported enum to `export var Kind;`, so a value-position
    // read that runs *before* the declaration sees `undefined`. swc matches that
    // contract. oxc 0.142 emits `export let Kind`, which has a temporal dead zone
    // and turns the same read into a hard `ReferenceError: Cannot access 'Kind'
    // before initialization` -- `typeof` does not protect against TDZ, so even the
    // defensive spelling throws (OX-D3 audit, §7, with a minimal repro).
    //
    // This is a divergence from tsc's *emit contract*, not from swc's style, and
    // the classifier files it as `token-level` (`var` -> `let`), which is exactly
    // why that class cannot be dispositioned as bulk-review. Pinned here by
    // execution so the shape stays free to change in the port and the dead zone
    // does not.
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      [
        "export enum Shared { X = 7 }",
        "export function readShared(): number { return Shared.X; }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { readShared, Shared } from "./helper";',
        // Same-module forward reference: this call runs while `Local` is still
        // above its own declaration. Under `var` semantics it reads `undefined`;
        // under `let`/`const` it throws.
        "function earlyLocal(): string { return typeof Local; }",
        "export const localBefore = earlyLocal();",
        "export enum Local { A = 1, B = 2 }",
        "export function localAfter(): string { return typeof Local; }",
        "export function values(): string {",
        '  return [Local.A, Local.B, Shared.X, readShared()].join("|");',
        "}",
        // Control: an *imported* enum is fully initialised before this module
        // body runs, so it is an object here. Keeping both in one fixture stops
        // the forward-reference assertion from passing for the wrong reason.
        "export const importedAtInit = typeof Shared;",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expectBuilt(result);

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "enum-forward-reference",
    );

    // The assertion that fails under an `export let` lowering: reaching this line
    // at all means the forward read did not throw.
    expect(module.localBefore).toBe("undefined");
    expect(module.localAfter()).toBe("object");
    expect(module.importedAtInit).toBe("object");
    expect(module.values()).toBe("1|2|7|7");
  },
);

test.serial(
  "a parameter shadowing a const enum keeps its own property value",
  { timeout: 30_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/entry.ts",
      [
        "const enum E { A = 1 }",
        "function f(E: { A: number }): number { return E.A; }",
        "export const result = f({ A: 9 });",
        "",
      ].join("\n"),
    );

    const result = await build({
      cache: { mode: "off" },
      entries: ["./entry.ts"],
      outDir: fixture.outDir,
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    });
    expectBuilt(result);
    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "const-enum-parameter-shadow",
    );
    expect(module.result).toBe(9);
  },
);

const HELPER = [
  "export const enum ConstEnum { AValue = 1, BValue = 2 }",
  'export const enum StrConst { S = "s" }',
  "export enum PlainEnum { X = 10, Y = 20 }",
  "",
].join("\n");

const ENTRY = [
  'import { ConstEnum, PlainEnum, StrConst } from "./helper";',
  'export * from "./helper";',
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

    // Erasure removes the export itself, not merely its value. An undefined
    // getter would still advertise a runtime binding that TypeScript erased.
    expect("ConstEnum" in module).toBe(false);
    expect("StrConst" in module).toBe(false);
    expect(module.PlainEnum).toEqual({ X: 10, Y: 20, 10: "X", 20: "Y" });
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
        `import { build } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "..", "..", "dist", "index.mjs")).href)};`,
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
    expect(module.ConstEnum).toEqual({
      AValue: 1,
      BValue: 2,
      1: "AValue",
      2: "BValue",
    });
    expect(module.StrConst).toEqual({ S: "s" });
    expect(module.PlainEnum).toEqual({ X: 10, Y: 20, 10: "X", 20: "Y" });
  },
);
