import fs from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";
import { expect, test } from "bun:test";

import { collectTypeMetadataFiles } from "../../src/build/transpile/type-metadata/metadata/index.ts";
import { scanClosureIrSourceFiles } from "../../src/build/transpile/type-metadata/metadata/scan.ts";
import {
  collectNativeTypeMetadataFromContext,
  createNativeTypeAnalysisContext,
} from "../../src/build/transpile/type-metadata/index.ts";
import { createFixture } from "../helpers.mjs";

async function collectMetadata(fixture) {
  const context = await createNativeTypeAnalysisContext({
    fileNames: [path.join(fixture.srcDir, "index.ts")],
    tsConfigPath: path.join(fixture.projectRoot, "tsconfig.json"),
    workspaceDir: fixture.projectRoot,
  });
  return collectNativeTypeMetadataFromContext({ context, scan: undefined });
}

const config = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    target: "ESNext",
    noLib: true,
    types: [],
  },
  include: ["src/**/*.ts"],
});

test("metadata rebuild reads equal-size source and imported declaration changes despite restored mtimes", async () => {
  const fixture = await createFixture();
  await fixture.write("tsconfig.json", config);
  const source = (type) =>
    [
      'import type { Remote } from "./remote";',
      `export function local(value: ${type}): ${type} { return value; }`,
      "export function remote(value: Remote): Remote { return value; }",
      "",
    ].join("\n");
  const timestamp = new Date("2025-01-01T00:00:00Z");
  await fixture.write("src/index.ts", source("string"));
  await fixture.write("src/remote.d.ts", "export type Remote = string;\n");
  for (const name of ["index.ts", "remote.d.ts"]) {
    await fs.utimes(path.join(fixture.srcDir, name), timestamp, timestamp);
  }
  const before = await collectMetadata(fixture);
  for (const bindingName of ["local", "remote"]) {
    const annotation = before.files[0].annotations.find(
      (item) =>
        item.target.kind === "binding" &&
        item.target.bindingName === bindingName,
    );
    expect(annotation.template).toContain("@param {string} value");
    expect(annotation.template).toContain("@return {string}");
  }

  await fixture.write("src/index.ts", source("number"));
  await fixture.write("src/remote.d.ts", "export type Remote = number;\n");
  for (const name of ["index.ts", "remote.d.ts"]) {
    await fs.utimes(path.join(fixture.srcDir, name), timestamp, timestamp);
  }
  const after = await collectMetadata(fixture);
  for (const bindingName of ["local", "remote"]) {
    const annotation = after.files[0].annotations.find(
      (item) =>
        item.target.kind === "binding" &&
        item.target.bindingName === bindingName,
    );
    expect(annotation.template).toContain("@param {number} value");
    expect(annotation.template).toContain("@return {number}");
  }
});

test("exported declaration modules contribute only explicit global augmentations", async () => {
  const fixture = await createFixture();
  await fixture.write("tsconfig.json", config);
  await fixture.write("src/index.ts", "export const ok = 1;\n");
  await fixture.write(
    "src/module.d.ts",
    [
      "export declare const importedValue: number;",
      "export declare namespace ImportedNamespace { const value: number; }",
      "declare namespace PrivateNamespace { const value: number; }",
      "declare global { var augmentedValue: number; }",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/ambient.d.ts",
    [
      "declare const environmentValue: number;",
      "declare namespace Environment { const value: number; }",
      "declare namespace TypesOnly { interface Value { value: number; } }",
      "",
    ].join("\n"),
  );

  const result = await collectMetadata(fixture);
  expect(result.files[0].ambientGlobals).toEqual([
    "Environment",
    "augmentedValue",
    "environmentValue",
  ]);
});

test("metadata rebuild discovers new ambient declarations from the current config roots", async () => {
  const fixture = await createFixture();
  await fixture.write("tsconfig.json", config);
  await fixture.write("src/index.ts", "export const ok = 1;\n");
  const before = await collectMetadata(fixture);
  expect(before.files[0].ambientGlobals).toEqual([]);

  await fixture.write(
    "src/ambient.d.ts",
    "declare const newlyAvailable: number;\n",
  );
  const after = await collectMetadata(fixture);
  expect(after.files[0].ambientGlobals).toEqual(["newlyAvailable"]);
});

function createProgram(fileNames, rootDir) {
  const compilerOptions = {
    allowJs: true,
    checkJs: true,
    experimentalDecorators: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  return {
    compilerOptions,
    program: ts.createProgram(fileNames, compilerOptions),
  };
}

function collect(fileNames, rootDir, targets) {
  const { compilerOptions, program } = createProgram(fileNames, rootDir);
  return collectTypeMetadataFiles({
    compilerOptions,
    fileNames,
    program,
    targets,
  });
}

function annotation(file, bindingName) {
  return file.annotations.find(
    (item) =>
      item.target.kind === "binding" && item.target.bindingName === bindingName,
  );
}

function renderTemplate(file, item) {
  const symbols = new Map(file.symbols.map((symbol) => [symbol.id, symbol]));
  return item.references.reduce((template, reference) => {
    const symbol = symbols.get(reference.symbolId);
    const name =
      symbol?.builtinName ?? symbol?.localName ?? symbol?.diagnosticName ?? "?";
    return template.replaceAll(reference.token, name);
  }, item.template);
}

test.serial(
  "type metadata scan skips plain files and selects TS/TSX plus typed JS",
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/plain.js", "export const plain = 1;\n");
    await fixture.write(
      "src/typed.tsx",
      "export function View(props: { label: string }) { return <div>{props.label}</div>; }\n",
    );
    await fixture.write(
      "src/typed.js",
      "/** @param {string} value */\nexport function read(value) { return value; }\n",
    );
    const fileNames = ["plain.js", "typed.tsx", "typed.js"].map((name) =>
      path.join(fixture.srcDir, name),
    );
    const { program } = createProgram(fileNames, fixture.projectRoot);
    const scan = scanClosureIrSourceFiles({ fileNames, program });

    expect(scan.scannedFileCount).toBe(3);
    expect(scan.analyzedFileCount).toBe(2);
    expect(scan.files[0].features.shouldAnalyze).toBe(false);
    expect(scan.files[1].features.shouldAnalyze).toBe(true);
    expect(scan.files[2].features.shouldAnalyze).toBe(true);
  },
);

test.serial(
  "metadata uses tokenized canonical symbols for local and aliased runtime classes",
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/model.ts", "export class Original {}\n");
    await fixture.write(
      "src/index.ts",
      [
        'import { Original as Alias } from "./model";',
        "class Local {}",
        "export function use(alias: Alias, local: Local): Alias { return alias; }",
        "",
      ].join("\n"),
    );
    const fileNames = [
      path.join(fixture.srcDir, "model.ts"),
      path.join(fixture.srcDir, "index.ts"),
    ];
    const result = collect(fileNames, fixture.projectRoot);
    const file = result.files[1];
    const doc = annotation(file, "use");

    expect(doc).toBeDefined();
    expect(doc.template).toContain("__GCC_TYPE_");
    expect(doc.template).not.toContain("Alias");
    expect(doc.template).not.toContain("Local");
    expect(renderTemplate(file, doc)).toContain("@param {!Alias} alias");
    expect(renderTemplate(file, doc)).toContain("@param {!Local} local");
    expect(
      file.symbols.some(
        (symbol) => symbol.kind === "runtime" && symbol.localName === "Alias",
      ),
    ).toBe(true);
    expect(new Set(file.symbols.map((symbol) => symbol.id)).size).toBe(
      file.symbols.length,
    );
  },
);

test.serial(
  "named declaration-file types are copied onto the referencing file",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/external.d.ts",
      [
        "export declare class Client { request(): string; }",
        "export interface Config { retries: number; label: string; }",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/index.ts",
      [
        'import type { Client, Config } from "./external";',
        "export function run(client: Client, config: Config, retries: number): string {",
        "  return String(config.label || retries || client);",
        "}",
        "",
      ].join("\n"),
    );
    const fileNames = [path.join(fixture.srcDir, "index.ts")];
    const result = collect(fileNames, fixture.projectRoot);
    const file = result.files[0];
    const doc = annotation(file, "run");
    const rendered = renderTemplate(file, doc);

    expect(rendered).toContain("@param {!Client} client");
    expect(rendered).toContain("@param {!Config} config");
    expect(rendered).toContain("@param {number} retries");
    expect(rendered).toContain("@return {string}");
    expect(file.declarations.length).toBeGreaterThanOrEqual(2);
    expect(
      file.declarations.some((declaration) =>
        declaration.template.includes("@constructor"),
      ),
    ).toBe(true);
    expect(
      file.declarations.some((declaration) =>
        declaration.template.includes("@record"),
      ),
    ).toBe(true);
    expect(
      file.symbols.some((symbol) => symbol.kind === "declared"),
    ).toBe(true);
    expect(
      file.diagnostics.some(
        (item) =>
          item.reason === "ambient-nominal-without-binding" &&
          item.symbolName === "Client",
      ),
    ).toBe(false);
  },
);

test.serial(
  "explicit records stay type-only and no structural records are generated",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "export interface Box<T> {",
        "  value: T;",
        "  map(input: T): T;",
        "}",
        "export type Pair<T> = {",
        "  left: T;",
        "  right: T;",
        "};",
        "export function consume(pending: PromiseLike<number>, box: Box<string>, pair: Pair<number>): void {",
        "  void pending; void box; void pair;",
        "}",
        "export function destructured({ alpha }: { alpha: string }): number {",
        "  return alpha.length;",
        "}",
        "",
      ].join("\n"),
    );
    const fileNames = [path.join(fixture.srcDir, "index.ts")];
    const result = collect(fileNames, fixture.projectRoot);
    const file = result.files[0];
    const declarations = file.declarations.map((item) =>
      renderTemplate(file, item),
    );
    const box = declarations.find((template) =>
      template.includes("function Box()"),
    );
    const pair = declarations.find((template) =>
      template.includes("function Pair()"),
    );

    for (const [template, name] of [
      [box, "Box"],
      [pair, "Pair"],
    ]) {
      expect(template).toBeDefined();
      expect(template).toContain(" * @template T");
      expect(template.indexOf(`function ${name}() {}`)).toBeLessThan(
        template.indexOf("if (false) {"),
      );
      expect(template.match(/if \(false\) \{/gu)).toHaveLength(1);
      expect(template).toContain(`  ${name}.prototype.`);
    }

    // A PromiseLike-heavy signature used to expand into a chain of synthetic
    // `@record` templates (and malformed `!?` atoms). Nothing structural is
    // generated any more: only the two authored declarations exist.
    expect(declarations).toHaveLength(2);
    expect(
      declarations.some((template) => template.includes(".prototype.then;")),
    ).toBe(false);
    expect(declarations.some((template) => /\$Record\d/u.test(template))).toBe(
      false,
    );
    expect(declarations.some((template) => /\$Param\d/u.test(template))).toBe(
      false,
    );
    expect(declarations.some((template) => template.includes("!?"))).toBe(
      false,
    );
    expect(file.annotations.some((item) => item.template.includes("!?"))).toBe(
      false,
    );

    const consume = renderTemplate(file, annotation(file, "consume"));
    expect(consume).toContain("@param {?} pending");
    expect(consume).toContain("@param {!Box} box");
    expect(consume).toContain("@param {!Pair} pair");
    expect(renderTemplate(file, annotation(file, "destructured"))).toContain(
      "@param {?} __param0",
    );

    expect(result.extractedCounts.typeDeclarationCount).toBe(
      file.declarations.length,
    );
    expect(result.extractedCounts.unresolvedTypeReferenceCount).toBeGreaterThan(
      0,
    );
  },
);

test.serial(
  "intersections degrade instead of inventing a disjoint Object receiver",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "interface Parser { score: number }",
        "interface Matcher { record: { aliasOf?: object }; parent?: Matcher }",
        "export function compare(built: Parser & Matcher, parent: Matcher) {",
        "  return !built.record.aliasOf === !parent.record.aliasOf;",
        "}",
        "",
      ].join("\\n"),
    );
    const fileName = path.join(fixture.srcDir, "index.ts");
    const result = collect([fileName], fixture.projectRoot);
    const rendered = renderTemplate(
      result.files[0],
      annotation(result.files[0], "compare"),
    );

    expect(rendered).toContain("@param {?} built");
    expect(rendered).toContain("@param {?} parent");
  },
);

test.serial(
  "metadata targets retarget authored files without collecting untargeted inputs",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/a.ts",
      "export const a: Promise<number> = Promise.resolve(1);\n",
    );
    await fixture.write(
      "src/b.ts",
      "export const b: Promise<number> = Promise.resolve(2);\n",
    );
    const a = path.join(fixture.srcDir, "a.ts");
    const b = path.join(fixture.srcDir, "b.ts");
    const emitted = path.join(fixture.projectRoot, "materialized", "a.js");
    const result = collect([a, b], fixture.projectRoot, [
      { emitFilePath: emitted, runtimeModuleId: "app:a", sourceFilePath: a },
    ]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].filePath).toBe(emitted);
    expect(result.files[0].sourceFilePath).toBe(a);
    expect(result.files[0].runtimeModuleId).toBe("app:a");
    expect(annotation(result.files[0], "a")).toBeDefined();
  },
);

test.serial(
  "metadata is deterministic and reports exact extracted counts",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.ts",
      [
        "export interface Item { name: string; }",
        "export const values: Item[] = [];",
        // Non-const: a `const enum` is erased by TypeScript and therefore
        // contributes no enum declaration. The `@enum` metadata path this count
        // measures is the non-const one.
        "export enum State { Ready = 'ready' }",
        "",
      ].join("\n"),
    );
    const fileNames = [path.join(fixture.srcDir, "index.ts")];
    const first = collect(fileNames, fixture.projectRoot);
    const second = collect(fileNames, fixture.projectRoot);

    expect(JSON.stringify(first.files)).toBe(JSON.stringify(second.files));
    expect(first.extractedCounts).toEqual({
      annotationCount: 1,
      enumDeclarationCount: 1,
      // `Item.prototype.name` carries `@type {string}` inside the synthesized
      // `@record`. Record properties are member-level type facts exactly like
      // class fields, so they count as member annotations.
      memberAnnotationCount: 1,
      typeDeclarationCount: 1,
      unresolvedTypeReferenceCount: 0,
    });
  },
);

test.serial(
  "explicit JSDoc JavaScript uses the same tokenized metadata channel",
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/index.js",
      [
        "/**",
        " * @param {Map<string, number>} values",
        " * @return {Promise<number>}",
        " */",
        "export function total(values) { return Promise.resolve(values.size); }",
        "",
      ].join("\n"),
    );
    const fileNames = [path.join(fixture.srcDir, "index.js")];
    const result = collect(fileNames, fixture.projectRoot);
    const file = result.files[0];
    const doc = annotation(file, "total");

    expect(doc).toBeDefined();
    expect(doc.template).toContain("__GCC_TYPE_");
    expect(renderTemplate(file, doc)).toContain(
      "@param {!Map<string, number>} values",
    );
    expect(renderTemplate(file, doc)).toContain("@return {!Promise<number>}");
    expect(result.typeMetadataDiagnostics).toHaveLength(0);
  },
);

async function collectAmbient(fixture, files) {
  for (const [name, text] of Object.entries(files)) {
    await fixture.write(name, text);
  }
  // Only the graph root is handed in, exactly as the build does: ambient
  // declarations must arrive through tsconfig parity, not through this list.
  const result = await collectMetadata(fixture);
  return new Set(result.files.flatMap((file) => file.ambientGlobals ?? []));
}

const AMBIENT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "bundler",
    skipLibCheck: true,
    strict: false,
    target: "ESNext",
  },
  include: ["src/**/*.ts"],
});

test.serial(
  "ambient declarations reach the checker through tsconfig parity, not the import graph",
  async () => {
    const fixture = await createFixture();
    const globals = await collectAmbient(fixture, {
      "tsconfig.json": AMBIENT_TSCONFIG,
      // Imported by nobody; only tsconfig `include` puts it in the program.
      "src/ambient.d.ts":
        "declare var module: { id: string };\ndeclare function ambientFn(): void;\n",
      "src/index.ts": "export const id = module.id;\n",
    });

    expect(globals.has("module")).toBe(true);
    expect(globals.has("ambientFn")).toBe(true);
  },
);

test.serial(
  "declare global members are globals; declare module members are not",
  async () => {
    const fixture = await createFixture();
    const globals = await collectAmbient(fixture, {
      "tsconfig.json": AMBIENT_TSCONFIG,
      "src/ambient.d.ts": [
        "declare global {",
        "  var globalFlag: boolean;",
        "  function globalFn(): void;",
        "}",
        'declare module "some-pkg" {',
        "  var moduleScopedName: number;",
        "  function moduleScopedFn(): void;",
        "}",
        "export {};",
        "",
      ].join("\n"),
      "src/index.ts": "export const ok = 1;\n",
    });

    expect(globals.has("globalFlag")).toBe(true);
    expect(globals.has("globalFn")).toBe(true);
    // Members of an ambient *module* are reached by importing it; pinning them
    // as globals would export a name the program never has in global scope.
    expect(globals.has("moduleScopedName")).toBe(false);
    expect(globals.has("moduleScopedFn")).toBe(false);
  },
);

test.serial("ambient namespace roots route to the extern channel", async () => {
  const fixture = await createFixture();
  const globals = await collectAmbient(fixture, {
    "tsconfig.json": AMBIENT_TSCONFIG,
    // `declare namespace` emits no runtime object, so a value read through it
    // can only come from the environment. Only the *root* is needed: the rest
    // are properties of that object.
    "src/index.ts": [
      "declare namespace exported.namespace { class C {} }",
      "declare namespace typesOnly { interface I { x: number } }",
      "export const v = new exported.namespace.C();",
      "",
    ].join("\n"),
  });

  expect(globals.has("exported")).toBe(true);
  // Not the inner segments: they are properties, not globals.
  expect(globals.has("namespace")).toBe(false);
  expect(globals.has("C")).toBe(false);
  // A type-only namespace has no runtime representation to declare.
  expect(globals.has("typesOnly")).toBe(false);
});

test.serial(
  "ambient declarations in a .ts source are environment names even when the file is a module",
  async () => {
    const fixture = await createFixture();
    const globals = await collectAmbient(fixture, {
      "tsconfig.json": AMBIENT_TSCONFIG,
      // A `declare` in an ordinary source emits no binding, so the reference
      // resolves from global scope — unlike `export declare` in a `.d.ts`,
      // which describes the shape of an import.
      "src/index.ts": [
        "declare const Component: any;",
        "declare function ambientCall(): void;",
        "const local = 1;",
        "export function main() { return [Component, ambientCall, local]; }",
        "",
      ].join("\n"),
    });

    expect(globals.has("Component")).toBe(true);
    expect(globals.has("ambientCall")).toBe(true);
    // Real program declarations are program code, never externs.
    expect(globals.has("local")).toBe(false);
  },
);

test("external ownership keeps generic property instantiations distinct", async () => {
  const fixture = await createFixture();
  const source = [
    'import { accept } from "boundary";',
    "interface Num { numberOnly: number; privateNum: boolean; }",
    "interface Text { textOnly: string; privateText: boolean; }",
    "interface Local<T> { item: T; }",
    "const first: Local<Num> = { item: { numberOnly: 1, privateNum: true } };",
    'const second: Local<Text> = { item: { textOnly: "ok", privateText: true } };',
    "const forwarded = accept;",
    "forwarded(first, second);",
    "export const values = [first.item.numberOnly, second.item.textOnly, first.item.privateNum, second.item.privateText];",
    "",
  ].join("\n");
  await fixture.write("src/index.ts", source);
  await fixture.write(
    "src/boundary.d.ts",
    [
      'declare module "boundary" {',
      "  export interface Box<T> { item: T; }",
      "  export function accept(first: Box<{ numberOnly: number }>, second: Box<{ textOnly: string }>): void;",
      "}",
      "",
    ].join("\n"),
  );
  const entry = path.join(fixture.srcDir, "index.ts");
  const { compilerOptions, program } = createProgram(
    [entry, path.join(fixture.srcDir, "boundary.d.ts")],
    fixture.srcDir,
  );
  const result = collectTypeMetadataFiles({
    compilerOptions,
    externalSpecifiers: ["boundary"],
    fileNames: [entry],
    program,
  });
  const offsets = new Set(result.files[0].externalOwnedMemberAccesses);
  const offset = (access) =>
    Buffer.byteLength(
      source.slice(0, source.lastIndexOf(access) + access.lastIndexOf(".") + 1),
    );
  expect(offsets.has(offset("first.item.numberOnly"))).toBe(true);
  expect(offsets.has(offset("second.item.textOnly"))).toBe(true);
  expect(offsets.has(offset("first.item.privateNum"))).toBe(false);
  expect(offsets.has(offset("second.item.privateText"))).toBe(false);
});
