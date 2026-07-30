import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../dist/index.mjs";
import { createFixture, findFilesNamed } from "./helpers.mjs";

/**
 * Semantic guards for the swc -> oxc migration risk table (/tmp/gcc-o1-oxc.md
 * section 4, "Top 5 semantic-risk areas"). Every test here passes on today's
 * swc stack and is written to pin *semantics*, not emitted text, so it survives
 * a stack swap and fails only on a real behaviour change:
 *
 *   risk 1 -> const-enum inlining of constant *expressions*, cross-module
 *   risk 3 -> cross-chunk direct-binding identity (shadowed name vs import)
 *   risk 5 -> comment policy: source comments must never reach Closure
 *   risk 2 -> nested exported namespace, Closure-accepted and executing
 *
 * These are the four cases the report calls "new test needed"; the existing
 * goldens cover the rest by asserting output text, which a re-baseline rewrites.
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

// ---------------------------------------------------------------------------
// risk 1: const enum whose member value is a constant expression
// ---------------------------------------------------------------------------

test.serial(
  "const-enum members defined by constant expressions inline cross-module",
  { timeout: 30_000 },
  async () => {
    // oxc does not inline const enums at all, so `EnumValueInlineVisitor` owns
    // the whole job after a migration -- including members whose value is an
    // *expression over earlier members* (`Down = 1 + Up`), which oxc's TS
    // transform leaves unfolded. The enum object is erased, so a folder that
    // silently gives up cannot fall back to a runtime read: the values below
    // are only obtainable by constant-folding the expression chain at compile
    // time. Assert the computed values, never the emitted shape.
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

// ---------------------------------------------------------------------------
// risk 3: cross-chunk direct-binding identity
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// risk 5: comment policy -- source comments must never reach Closure
// ---------------------------------------------------------------------------

/** Leading `//` and `/* *\/` comments, in source order, with positions. */
function extractComments(source) {
  const comments = [];
  // ponytail: regex lexer, not a parser. It over-reports (a `//` inside a
  // string literal counts), which is the safe direction for a "no comments"
  // gate; it is not used to rewrite anything.
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
  for (const match of source.matchAll(pattern)) {
    comments.push(match[0]);
  }
  return comments;
}

// Today every comment in the emitted Closure input is machine-written, and this
// is the whole allowed set:
//
//   1. generated Closure JSDoc -- `/** @return {number} */` from the type
//      metadata channel, `/** @pureOrBreakMyCode */` recovered from a source
//      `/*#__PURE__*/` by `pure_calls.rs`;
//   2. the bare `/*#__PURE__*/` that swc's own enum lowering prints in front of
//      the enum IIFE.
//
// Source comments cannot survive, because swc has no comment store at all. Under
// oxc, codegen *does* carry comments, so this pair of patterns is the policy
// gate: whatever a source file wrote must still be absent, and any new generated
// form has to be added here deliberately, with a reason.
const ALLOWED_COMMENTS = [/^\/\*\*[\s\S]*@[A-Za-z]/u, /^\/\*#__PURE__\*\/$/u];
const HOSTILE_MARKERS = [
  "HOSTILE_LICENSE",
  "HOSTILE_CONST",
  "HOSTILE_CAST",
  "HOSTILE_LINE",
  "HOSTILE_ENUM",
  "@license",
  "@preserve",
  "@nocollapse",
  "@suppress",
];

test.serial(
  "hostile source jsdoc never reaches the Closure inputs",
  { timeout: 60_000 },
  async () => {
    // Comment retention is the one migration risk with *zero* coverage today,
    // because swc makes it unrepresentable. If oxc forwards `@const`, `@license`
    // or `@type` casts into Closure's input, Closure reads them as real
    // annotations: `@const` on a reassigned binding is a type error, a wrong
    // `@type` cast changes inference, `@license` changes output preservation,
    // and `@nocollapse`/`@suppress` change renaming. Those are silent
    // miscompiles, not build failures.
    //
    // So pin the contract from both ends: the full ADVANCED job still accepts
    // and executes the module, and every comment in the emitted Closure input
    // is a generated annotation -- never something the source wrote.
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      [
        "/**",
        " * @license HOSTILE_LICENSE-1.0",
        " * @preserve",
        " */",
        "",
        "/** @const HOSTILE_CONST */",
        "export let mutable = 1;",
        "",
        "/** @nocollapse @suppress {checkTypes} HOSTILE_CAST */",
        "export const cast = /** @type {string} */ (String(2));",
        "",
        "// HOSTILE_LINE trailing prose",
        "export function bump(): number {",
        "  mutable = mutable + 1; // HOSTILE_LINE inside a body",
        "  return mutable;",
        "}",
        "export function readMutable(): number { return mutable; }",
        "",
        "/** @enum HOSTILE_ENUM */",
        "export enum Kind { A = 1, B = 2 }",
        "",
        "/** A pure factory. */",
        "export const pure = /*#__PURE__*/ makeToken();",
        'function makeToken(): string { return "TOKEN"; }',
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { bump, cast, Kind, mutable, pure, readMutable } from "./helper";',
        "export function probe(): string {",
        // `mutable` is read straight through the import binding: `@const` must
        // not have frozen it, and the ES live-binding rule says this importer
        // sees the reassignment (see `es-live-bindings.test.mjs`).
        '  return [bump(), bump(), cast, Kind.B, pure, readMutable(), mutable].join("|");',
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
    // A full ADVANCED job: the hostile annotations did not become Closure
    // errors, because Closure never saw them.
    expectBuilt(result);

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "hostile-jsdoc",
    );
    // `@const` on `mutable` did not freeze it (it is reassigned twice), the
    // `@type {string}` cast did not retype `cast`, and `@license`/`@preserve`
    // did not pin dead text into the bundle.
    // The trailing `3` is the imported `mutable` read *after* two `bump()`
    // calls: the importer observes the reassignment.
    expect(module.probe()).toBe("2|3|2|2|TOKEN|3|3");

    const emitted = (await findFilesNamed(cacheDir, "helper.js"))
      .concat(await findFilesNamed(cacheDir, "entry.js"))
      .filter(
        (file) => file.includes("/native-emit/") && file.includes("/out/src/"),
      );
    expect(emitted.length).toBeGreaterThanOrEqual(2);

    let sawGeneratedAnnotation = false;
    for (const file of emitted) {
      const source = await fs.readFile(file, "utf8");
      for (const marker of HOSTILE_MARKERS) {
        expect(source, `${file} leaked ${marker}`).not.toContain(marker);
      }
      for (const comment of extractComments(source)) {
        expect(
          ALLOWED_COMMENTS.some((allowed) => allowed.test(comment)),
          `${file} carries a comment outside the allowed set: ${comment}`,
        ).toBe(true);
        sawGeneratedAnnotation = true;
      }
    }
    // The gate must be able to see comments at all, otherwise it passes vacuously.
    expect(sawGeneratedAnnotation).toBe(true);

    // The source `/*#__PURE__*/` did not pass through as a comment: it was
    // translated into the Closure annotation that actually means something to
    // the compiler. The only `__PURE__` left is swc's own enum-IIFE marker.
    const helperEmit = await fs.readFile(
      emitted.find((file) => file.endsWith("helper.js")),
      "utf8",
    );
    expect(helperEmit).not.toMatch(/__PURE__\*\/\s*makeToken/u);
    expect(helperEmit).toContain("@pureOrBreakMyCode");
  },
);

// ---------------------------------------------------------------------------
// risk 2: nested exported namespace, end to end through Closure
// ---------------------------------------------------------------------------

test.serial(
  "a nested exported namespace survives a full Closure job and executes",
  { timeout: 60_000 },
  async () => {
    // Namespace lowering shape (`var` vs `let`, `_Outer` param aliasing, the
    // nested binding chain) is what feeds Closure's goog.module checks, and the
    // existing namespace goldens assert the *swc* shape -- a re-baseline
    // rewrites them, so they cannot tell us the oxc shape still compiles.
    // This test is deliberately shape-agnostic: it only requires that Closure
    // accepts the lowered module and that the values cross every level of the
    // nesting, including sibling references within a namespace, an alias taken
    // out of the middle of the chain, and a *second* declaration block for the
    // same namespace.
    //
    // The merged block is here because it used to fail: SWC's `strip` qualifies a
    // member reference only inside the block that declares it, so the second
    // block emitted bare `Inner`/`version` reads and Closure rejected the module
    // (JSC_UNDEFINED_VARIABLE). The blocks are now merged before `strip` runs.
    const fixture = await createFixture();
    await fixture.write(
      "src/lib.ts",
      [
        "export namespace Outer {",
        "  export const version = 3;",
        "  export namespace Inner {",
        '    export const tag = "INNER";',
        "    export function twice(value: number): number { return value * 2; }",
        "    export namespace Deep {",
        "      export function thrice(value: number): number {",
        "        return twice(value) + value;",
        "      }",
        "    }",
        "  }",
        "  export function describe(): string {",
        "    return `${version}:${Inner.tag}`;",
        "  }",
        "}",
        "// A second block for the same namespace must merge, not shadow.",
        "export namespace Outer {",
        "  export function versionTwice(): number { return Inner.twice(version); }",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/entry.ts",
      [
        'import { Outer } from "./lib";',
        "export function probe(): string {",
        "  return [",
        "    Outer.version,",
        "    Outer.Inner.tag,",
        "    Outer.Inner.twice(4),",
        "    Outer.Inner.Deep.thrice(4),",
        "    Outer.describe(),",
        "    Outer.versionTwice(),",
        '  ].join("|");',
        "}",
        "export function reachThroughAlias(): number {",
        "  const alias = Outer.Inner;",
        "  return alias.twice(alias.tag.length);",
        "}",
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
    // Closure ADVANCED accepted the lowered namespace chain.
    expectBuilt(result);

    const module = await importOutput(
      path.join(fixture.outDir, "entry.js"),
      "nested-namespace",
    );
    // The trailing `6` comes from the merged second block reading the first
    // block's `Inner` and `version`.
    expect(module.probe()).toBe("3|INNER|8|12|3:INNER|6");
    expect(module.reachThroughAlias()).toBe(10);
  },
);

// ---------------------------------------------------------------------------
// risk 6: enum lowering must not introduce a temporal dead zone
// ---------------------------------------------------------------------------

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
