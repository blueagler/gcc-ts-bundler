import fs from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { expect, test } from "bun:test";

import {
  createClosureDocRenderContext,
  toClosureType,
} from "../src/build/transpile/closure-ir/metadata/type-render.ts";

/**
 * The tsickle `translate()` adoption table (docs/research/tsickle-lessons.md).
 *
 * Every case here is a trap someone hit in Google production; the test name
 * states the trap, not the syntax. These are correctness regressions, not size
 * ones — the measured fidelity value of the whole table is ~0.7%.
 */

const LIB_DIR = `${path.dirname(
  ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ESNext }),
)}${path.sep}`;

/** Renders the declared type of `let v: …` in a one-file program. */
function render(source) {
  const file = "/case.ts";
  const files = new Map([
    [file, ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true)],
  ]);
  const load = (name) => {
    if (files.has(name)) return files.get(name);
    const full = name.startsWith("/") ? name : LIB_DIR + name;
    try {
      const sourceFile = ts.createSourceFile(
        name,
        fs.readFileSync(full, "utf8"),
        ts.ScriptTarget.ESNext,
        true,
      );
      files.set(name, sourceFile);
      return sourceFile;
    } catch {
      return undefined;
    }
  };
  const program = ts.createProgram(
    [file],
    {
      lib: ["lib.esnext.d.ts"],
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    },
    {
      fileExists: (name) => !!load(name),
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => `${LIB_DIR}lib.esnext.d.ts`,
      getNewLine: () => "\n",
      getSourceFile: (name) => load(name),
      readFile: (name) => load(name)?.text,
      useCaseSensitiveFileNames: () => true,
      writeFile: () => {},
    },
  );
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(file);
  let declaration;
  const walk = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "v") {
      declaration = node;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  if (!declaration) throw new Error("fixture has no `let v` declaration");
  const context = createClosureDocRenderContext(sourceFile);
  const rendered = toClosureType(
    checker.getTypeAtLocation(declaration),
    checker,
    context,
    new Set(),
    declaration.type,
  );
  return { context, rendered };
}

/** Type references are minted as opaque tokens; compare on shape. */
const TOKEN = /__GCC_TYPE_\d+__/gu;
const shape = (rendered) => rendered.replace(TOKEN, "T");

test("unknown renders as the ALL type, not as the unknown type", () => {
  // `?` says "the compiler has no idea"; TS `unknown` says "every value is
  // allowed". Emitting `?` throws away a fact the checker proved, and makes
  // `unknown` indistinguishable from a translation failure in the ledger.
  expect(render("let v: unknown;").rendered).toBe("*");
  expect(render("let v: any;").rendered).toBe("?");
});

test("empty anonymous object is `*`, never `!Object`", () => {
  // `!Object` is not a supertype of `string`/`number`, so rendering `{}` that
  // way turns every primitive assignment into a type error.
  expect(render("let v: {};").rendered).toBe("*");
});

test("`object` renders as !Object", () => {
  // NonPrimitive carries no other type flag, so it has to be checked before
  // the primitive switch or it falls through to `?`.
  expect(shape(render("let v: object;").rendered)).toBe("!T");
});

test("bigint and symbol have real Closure spellings", () => {
  // Both used to degrade to `?`. Closure has no symbol *uniqueness*, so a
  // unique symbol is still just `symbol`.
  expect(render("let v: bigint;").rendered).toBe("bigint");
  expect(render("let v: symbol;").rendered).toBe("symbol");
  expect(
    render("declare const s: unique symbol; let v: typeof s;").rendered,
  ).toBe("symbol");
});

test("enum member literal renders as the parent enum, not the widened primitive", () => {
  // `E.A` must be `!E`: the widened `number` erases the nominal identity that
  // `@enum` checking depends on.
  expect(shape(render("enum E { A = 1, B = 2 } let v: E.A;").rendered)).toBe(
    "!T",
  );
});

test("single-member enum still walks to its parent symbol (TS#28869)", () => {
  // getBaseTypeOfLiteralType returns the literal itself for a single-member
  // enum, so without the parent-symbol walk this silently rendered `number`.
  expect(shape(render("enum S { Only = 1 } let v: S.Only;").rendered)).toBe(
    "!T",
  );
});

test("tuples render as !Array<?>, never as a union of element types", () => {
  // Unioning the element types makes every tuple position assignable to every
  // other, so positional reads get the wrong type reported. Measured at Google
  // to buy no optimization as long as destructuring is aliased.
  expect(shape(render("let v: [string, number];").rendered)).toBe("!T<?>");
  expect(shape(render("let v: [];").rendered)).toBe("!T<?>");
});

test("index signatures render as !Object<K, V>", () => {
  expect(shape(render("let v: { [k: string]: number };").rendered)).toBe(
    "!T<string, number>",
  );
  expect(shape(render("let v: { [k: number]: boolean };").rendered)).toBe(
    "!T<number, boolean>",
  );
});

test("construct signatures carry no `!` on the new: target", () => {
  // Nullability on `new:` stops Closure recognising the annotation as a
  // constructor type at all — it is silently not a ctor, not a nullable one.
  const { rendered } = render("class C {} let v: new (a: string) => C;");
  expect(shape(rendered)).toBe("function(new:T, string)");
  expect(rendered).not.toContain("new:!");
});

test("a `this` parameter moves into Closure's this: slot instead of vanishing", () => {
  // The `this` param is in the declaration's parameter list but not in the
  // signature's, so dropping it silently changed the arity contract of every
  // this-typed callback.
  const { rendered } = render("let v: (this: Date, a: string) => void;");
  expect(shape(rendered)).toBe("function(this:!T, string): void");
});

test("optional parameters are detected by initializer as well as questionToken", () => {
  expect(
    render("declare function f(a?: string, b = 2): void; let v: typeof f;")
      .rendered,
  ).toBe("function(string=, number=): void");
});

test("rest parameters unwrap the array type", () => {
  expect(
    render("declare function g(...r: number[]): void; let v: typeof g;")
      .rendered,
  ).toBe("function(...number): void");
});

test("an overload set degrades rather than picking one signature", () => {
  // Closure's function syntax expresses exactly one signature; silently
  // emitting the first one reports a type the program does not have.
  const { rendered } = render(
    "interface MC { (a: string): number; (a: number): string; } let v: MC;",
  );
  expect(rendered).toBe("?");
});

test("generic function types erase their own type parameters", () => {
  // Closure has no generic function types — only generic declarations carry
  // @template — so a bare `T` inside the annotation resolves to nothing.
  expect(render("let v: <T>(a: T) => T;").rendered).toBe("function(?): ?");
});

test("mapped types degrade instead of naming a type-only alias", () => {
  // A mapped type's alias names a type, never a runtime value; referencing it
  // mints a dangling identifier.
  expect(render("type M = { [K in 'a'|'b']: number }; let v: M;").rendered).toBe(
    "?",
  );
});

test("boolean literal unions collapse to a single boolean", () => {
  expect(render("let v: true | false;").rendered).toBe("boolean");
});

test("template literal types widen to string", () => {
  expect(render("type TL = `a${string}`; let v: TL;").rendered).toBe("string");
});

test("declaration-file structural shapes still degrade to one `?` atom", () => {
  // Guards the deliberate non-adoption of tsickle's record-literal row: the
  // structural-record experiment measured zero delivered bytes and was
  // deleted. This test fails if it is ever re-synthesized.
  expect(render("let v: { a: string; b: number };").rendered).toBe("?");
});

test("a degraded generic target drops its type arguments (`?<...>` is a syntax error)", async () => {
  const { applyTypeArgumentsForTest } = await import(
    "../src/build/transpile/closure-ir/metadata/type-render.ts"
  );
  // `?<A, B>` does not parse. A degraded target has to take its arguments with
  // it, or one bad atom poisons the whole annotation with a parse error
  // reported far from the cause.
  expect(applyTypeArgumentsForTest("?", ["string"])).toBe("?");
  expect(applyTypeArgumentsForTest("*", ["string"])).toBe("?");
  expect(applyTypeArgumentsForTest("!Foo", ["?"])).toBe("!Foo<?>");
  expect(applyTypeArgumentsForTest("!Foo", [])).toBe("!Foo");
});

/** Builds a program over one file and returns {checker, sourceFile, context}. */
function programFor(source) {
  const file = "/heritage.ts";
  const files = new Map([
    [file, ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true)],
  ]);
  const load = (name) => {
    if (files.has(name)) return files.get(name);
    const full = name.startsWith("/") ? name : LIB_DIR + name;
    try {
      const sourceFile = ts.createSourceFile(
        name,
        fs.readFileSync(full, "utf8"),
        ts.ScriptTarget.ESNext,
        true,
      );
      files.set(name, sourceFile);
      return sourceFile;
    } catch {
      return undefined;
    }
  };
  const program = ts.createProgram(
    [file],
    {
      lib: ["lib.esnext.d.ts"],
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
    },
    {
      fileExists: (name) => !!load(name),
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => `${LIB_DIR}lib.esnext.d.ts`,
      getNewLine: () => "\n",
      getSourceFile: (name) => load(name),
      readFile: (name) => load(name)?.text,
      useCaseSensitiveFileNames: () => true,
      writeFile: () => {},
    },
  );
  const sourceFile = program.getSourceFile(file);
  return {
    checker: program.getTypeChecker(),
    context: createClosureDocRenderContext(sourceFile),
    sourceFile,
  };
}

function firstClass(sourceFile, name) {
  let found;
  const walk = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return found;
}

test("heritage strips `!` and refuses supertypes with no nominal form", async () => {
  const { buildClassJsDoc } = await import(
    "../src/build/transpile/closure-ir/metadata/docs.ts"
  );
  const { checker, context, sourceFile } = programFor(
    [
      "export class Base<T> { value!: T; }",
      "export interface Contract { run(): void; }",
      "export class Named extends Base<string> implements Contract { run() {} }",
      "type Shape = { [K in 'a' | 'b']: number };",
      "declare const Structural: { new (): Shape };",
      "export class FromStructural extends Structural {}",
      "",
    ].join("\n"),
  );

  const named = buildClassJsDoc(firstClass(sourceFile, "Named"), checker, context);
  // `@extends {!X}` is a syntax error: heritage positions are inherently
  // non-null and Closure rejects the modifier there. Type *arguments* keep it.
  expect(named).not.toMatch(/@extends \{!/u);
  expect(named).not.toMatch(/@implements \{!/u);
  expect(named).toMatch(/@extends \{[^}]*<string>\}/u);
  expect(named).toMatch(/@implements \{/u);
  // tsickle rewrites `implements X` to `@extends` when there is no extends
  // clause; their own comment calls it a poorly-thought-out hack. Not adopted:
  // exactly one @extends here, from the real extends clause.
  expect(named.match(/@extends/gu) ?? []).toHaveLength(1);

  const structural = buildClassJsDoc(
    firstClass(sourceFile, "FromStructural"),
    checker,
    context,
  );
  // A mapped/structural supertype has no nominal Closure form. `@extends {?}`
  // and `@extends {{a: number}}` are not heritage — they are noise that
  // suppresses real inheritance checking, so nothing is emitted.
  expect(structural ?? "").not.toMatch(/@extends \{\?\}/u);
  expect(structural ?? "").not.toMatch(/@extends \{\{/u);
});

test("@const rides only on readonly properties proven never reassigned", async () => {
  const { buildClassMemberDoc } = await import(
    "../src/build/transpile/closure-ir/metadata/docs.ts"
  );
  const { checker, context, sourceFile } = programFor(
    [
      "export class Holder {",
      "  readonly stable: number = 1;",
      "  readonly mutated: number = 2;",
      "  writable: number = 3;",
      "  readonly late!: number;",
      "  bump() { (this as unknown as { mutated: number }).mutated = 9; }",
      "}",
      "",
    ].join("\n"),
  );
  const holder = firstClass(sourceFile, "Holder");
  const docFor = (name) => {
    const member = holder.members.find(
      (item) => item.name && ts.isIdentifier(item.name) && item.name.text === name,
    );
    return buildClassMemberDoc({ checker, context, member }) ?? "";
  };

  // `@const` licenses Closure to collapse the property, so a wrong one changes
  // behaviour. Every step of the rule fails closed.
  expect(docFor("stable")).toContain("@const");
  // Reassigned through an `as`-cast — which defeats `readonly` in TS but not in
  // the emitted program. The file-wide assignment scan catches it.
  expect(docFor("mutated")).not.toContain("@const");
  // Not readonly.
  expect(docFor("writable")).not.toContain("@const");
  // No initializer: written after construction begins, which `@const` forbids.
  expect(docFor("late")).not.toContain("@const");
});
