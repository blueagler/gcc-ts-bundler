import path from "node:path";
import ts from "typescript";
import { expect, test } from "bun:test";

import { scanClosureIrFiles, collectClosureIrFiles } from "../src/stages/native/closure-ir/metadata.ts";
import { createFixture } from "./helpers.mjs";

function createProgram(fileNames, rootDir) {
  const compilerOptions = {
    allowJs: true,
    experimentalDecorators: true,
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

test.serial("closure-ir scan skips plain runtime files and analyzes typed closure inputs", async () => {
  const fixture = await createFixture();
  await fixture.write("src/plain.ts", "export const plain = 1;\n");
  await fixture.write(
    "src/typed.ts",
    "export const typed: number = 1;\n",
  );
  await fixture.write(
    "src/types.ts",
    "export interface PanelProps { label: string; }\n",
  );
  await fixture.write(
    "src/state.ts",
    "export enum RouteState { Home = 'home', About = 'about' }\n",
  );

  const fileNames = [
    path.join(fixture.srcDir, "plain.ts"),
    path.join(fixture.srcDir, "typed.ts"),
    path.join(fixture.srcDir, "types.ts"),
    path.join(fixture.srcDir, "state.ts"),
  ];
  const { program } = createProgram(fileNames, fixture.projectRoot);
  const scan = scanClosureIrFiles({ fileNames, program });
  const featuresByFile = new Map(
    scan.files.map(({ features }) => [features.filePath, features]),
  );

  expect(scan.scannedFileCount).toBe(4);
  expect(scan.analyzedFileCount).toBe(3);
  expect(scan.hasEnumDeclarations).toBe(true);
  expect(featuresByFile.get(fileNames[0]).shouldAnalyze).toBe(false);
  expect(featuresByFile.get(fileNames[0]).needsSemanticPreflight).toBe(false);
  expect(featuresByFile.get(fileNames[1]).needsSemanticPreflight).toBe(true);
  expect(featuresByFile.get(fileNames[1]).shouldAnalyze).toBe(true);
  expect(featuresByFile.get(fileNames[1]).hasTypeDrivenClosureDocs).toBe(true);
  expect(featuresByFile.get(fileNames[2]).hasTypeDeclarations).toBe(true);
  expect(featuresByFile.get(fileNames[2]).needsSemanticPreflight).toBe(true);
  expect(featuresByFile.get(fileNames[3]).hasEnumDeclarations).toBe(true);
  expect(featuresByFile.get(fileNames[3]).needsSemanticPreflight).toBe(true);
});

test.serial("closure-ir collection emits empty metadata for skipped files", async () => {
  const fixture = await createFixture();
  await fixture.write("src/plain.ts", "export const plain = 1;\n");
  await fixture.write(
    "src/types.ts",
    "export type PanelConfig = { label: string; };\n",
  );

  const fileNames = [
    path.join(fixture.srcDir, "plain.ts"),
    path.join(fixture.srcDir, "types.ts"),
  ];
  const { compilerOptions, program } = createProgram(
    fileNames,
    fixture.projectRoot,
  );
  const result = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });
  const filesByPath = new Map(result.files.map((file) => [file.filePath, file]));

  expect(result.diagnostics).toHaveLength(0);
  expect(filesByPath.get(fileNames[0])).toEqual({
    decoratedOutputText: undefined,
    enumDeclarations: [],
    filePath: fileNames[0],
    topLevelDocs: [],
    typeDeclarations: [],
  });
  expect(filesByPath.get(fileNames[1]).typeDeclarations.length).toBeGreaterThan(0);
});

test.serial("closure-ir collection lowers TypeScript types into broad Closure annotations", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/typed.ts",
    [
      "export interface User { name: string; tags: string[]; }",
      "function localScore(user: User, weight: number): number {",
      "  return user.name.length * weight;",
      "}",
      "const parse = (input: string): User => ({ name: input, tags: [] });",
      "const handlers: { current: number; load(input: string): number } = {",
      "  current: 1,",
      "  load(input) { return input.length; },",
      "};",
      "class Worker {",
      "  count: number = 0;",
      "  constructor(label: string) { this.count = label.length; }",
      "  run(user: User): string { return user.name; }",
      "  get size(): number { return this.count; }",
      "}",
      "export const worker = new Worker('x');",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "typed.ts")];
  const { compilerOptions, program } = createProgram(
    fileNames,
    fixture.projectRoot,
  );
  const result = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });
  const [file] = result.files;
  const typeSnippets = file.typeDeclarations.map((decl) => decl.snippet).join("\n");
  const docs = file.topLevelDocs;

  expect(result.diagnostics).toHaveLength(0);
  expect(typeSnippets).toContain("function User()");
  expect(typeSnippets).toContain("User.prototype.tags");
  expect(typeSnippets).toContain("@record");
  expect(typeSnippets).toContain("load");
  expect(docs.some((doc) => doc.kind === "function" && doc.name === "localScore" && doc.jsdoc.includes("@param {!User} user"))).toBe(true);
  expect(docs.some((doc) => doc.kind === "variable" && doc.name === "parse" && doc.jsdoc.includes("@return {!User}"))).toBe(true);
  expect(docs.some((doc) => doc.kind === "field" && doc.owner === "Worker" && doc.name === "count" && doc.jsdoc.includes("@type {number}"))).toBe(true);
  expect(docs.some((doc) => doc.kind === "method" && doc.owner === "Worker" && doc.name === "run" && doc.jsdoc.includes("@return {string}"))).toBe(true);
  expect(docs.some((doc) => doc.kind === "getter" && doc.owner === "Worker" && doc.name === "size" && doc.jsdoc.includes("@return {number}"))).toBe(true);
  expect(docs.some((doc) => doc.kind === "objectMethod" && doc.owner === "handlers" && doc.name === "load" && doc.jsdoc.includes("@return {number}"))).toBe(true);
});

test.serial("closure-ir emits tsickle-style function and heritage JSDoc", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/signatures.ts",
    [
      "class Base {}",
      "export interface Box<T> { value?: T; load(input?: string): Promise<T>; }",
      "/** @deprecated old path */",
      "export function optional(a: string, b?: number, c = false, ...rest: string[]): string { return a; }",
      "export function withThis(this: { prefix: string }, value: string): string { return this.prefix + value; }",
      "export function overload(value: string): string;",
      "export function overload(value: number): number;",
      "export function overload(value: string | number): string | number { return value; }",
      "export class Worker<T extends { id: string }> extends Base implements Box<T> {",
      "  value?: T;",
      "  constructor(value: T) { this.value = value; }",
      "  load(input?: string): Promise<T> { return Promise.resolve(this.value!); }",
      "}",
      "export const indexMap: Record<string, number> = { a: 1 };",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "signatures.ts")];
  const { compilerOptions, program } = createProgram(
    fileNames,
    fixture.projectRoot,
  );
  const result = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });
  const [file] = result.files;
  const typeSnippets = file.typeDeclarations.map((decl) => decl.snippet).join("\n");
  const docs = file.topLevelDocs;
  const optionalDoc = docs.find((doc) => doc.kind === "function" && doc.name === "optional")?.jsdoc ?? "";
  const withThisDoc = docs.find((doc) => doc.kind === "function" && doc.name === "withThis")?.jsdoc ?? "";
  const overloadDocs = docs.filter((doc) => doc.kind === "function" && doc.name === "overload");
  const workerDoc = docs.find((doc) => doc.kind === "class" && doc.name === "Worker")?.jsdoc ?? "";
  const constructorDoc = docs.find((doc) => doc.kind === "constructor" && doc.owner === "Worker")?.jsdoc ?? "";
  const indexMapDoc = docs.find((doc) => doc.kind === "variable" && doc.name === "indexMap")?.jsdoc ?? "";

  expect(result.diagnostics).toHaveLength(0);
  expect(typeSnippets).toContain("Box.prototype.value");
  expect(typeSnippets).toContain("@type {(T|undefined)}");
  expect(typeSnippets).toContain("@type {function(string=): !Promise<T>}");
  expect(optionalDoc).toContain("@deprecated old path");
  expect(optionalDoc).toContain("@param {number=} b");
  expect(optionalDoc).toContain("@param {boolean=} c");
  expect(optionalDoc).toContain("@param {...string} rest");
  expect(withThisDoc).toContain("@this {!signatures$Record0}");
  expect(withThisDoc).toContain("@param {string} value");
  expect(overloadDocs).toHaveLength(1);
  expect(overloadDocs[0].jsdoc).toContain("@param {(number|string)} value");
  expect(overloadDocs[0].jsdoc).toContain("@return {(number|string)}");
  expect(workerDoc).toContain("@extends {Base}");
  expect(workerDoc).toContain("@implements {Box<T>}");
  expect(workerDoc).not.toContain("this>");
  expect(constructorDoc).not.toContain("@return");
  expect(indexMapDoc).toContain("@type {!Object<string, number>}");
});

test.serial("closure-ir uses declaration files as type sources for generated records", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/external.d.ts",
    "export interface ExternalConfig { publicName: string; count: number; }\n",
  );
  await fixture.write(
    "src/index.ts",
    [
      'import type { ExternalConfig } from "./external";',
      "const config: ExternalConfig = { publicName: 'demo', count: 1 };",
      "export const count = config.count;",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "index.ts")];
  const { compilerOptions, program } = createProgram(
    fileNames,
    fixture.projectRoot,
  );
  const result = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });
  const [file] = result.files;
  const typeSnippets = file.typeDeclarations.map((decl) => decl.snippet).join("\n");

  expect(result.diagnostics).toHaveLength(0);
  expect(typeSnippets).toContain("function ExternalConfig()");
  expect(typeSnippets).toContain("ExternalConfig.prototype.publicName");
  expect(file.topLevelDocs.some((doc) => doc.name === "config" && doc.jsdoc.includes("@type {!ExternalConfig}"))).toBe(true);
});

test.serial("closure-ir keeps builtin lib collections and streams as native Closure types", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    [
      "const counts: Map<string, number> = new Map();",
      "const ready: Promise<number> = Promise.resolve(1);",
      "const bytes: ReadableStream<Uint8Array> = new ReadableStream();",
      "export const size = counts.size + 1;",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "index.ts")];
  const { compilerOptions, program } = createProgram(
    fileNames,
    fixture.projectRoot,
  );
  const result = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });
  const [file] = result.files;
  const typeSnippets = file.typeDeclarations.map((decl) => decl.snippet).join("\n");

  expect(result.diagnostics).toHaveLength(0);
  expect(typeSnippets).not.toContain("function Map()");
  expect(typeSnippets).not.toContain("function Promise()");
  expect(typeSnippets).not.toContain("function ReadableStream()");
  expect(file.topLevelDocs.some((doc) => doc.name === "counts" && doc.jsdoc.includes("@type {!Map<string, number>}"))).toBe(true);
  expect(file.topLevelDocs.some((doc) => doc.name === "ready" && doc.jsdoc.includes("@type {!Promise<number>}"))).toBe(true);
  expect(file.topLevelDocs.some((doc) => doc.name === "bytes" && doc.jsdoc.includes("@type {!ReadableStream}"))).toBe(true);
});

test.serial("closure-ir scan skips local helper-heavy files without export or doc shapes", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/helpers.js",
    [
      "function create_node() { return null; }",
      "function mount_component() { return null; }",
      "class InternalRunner {}",
      "const app = create_node();",
      "export default app;",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "helpers.js")];
  const { program } = createProgram(fileNames, fixture.projectRoot);
  const scan = scanClosureIrFiles({ fileNames, program });
  const [entry] = scan.files;

  expect(scan.scannedFileCount).toBe(1);
  expect(scan.analyzedFileCount).toBe(0);
  expect(entry.features.hasTopLevelDocs).toBe(false);
  expect(entry.features.needsSemanticPreflight).toBe(false);
  expect(entry.features.shouldAnalyze).toBe(false);
});

test.serial("closure-ir scan skips compiled svelte-like helper files for doc collection", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/compiled.js",
    [
      "function create_fragment($$ctx) { return $$ctx; }",
      "function instance($$self, $$props, $$invalidate) { return []; }",
      "function append_hydration(target, node) { return target && node; }",
      "const Component = {};",
      "export default Component;",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "compiled.js")];
  const { program } = createProgram(fileNames, fixture.projectRoot);
  const scan = scanClosureIrFiles({ fileNames, program });
  const [entry] = scan.files;

  expect(scan.scannedFileCount).toBe(1);
  expect(scan.analyzedFileCount).toBe(0);
  expect(entry.features.hasTopLevelDocs).toBe(false);
  expect(entry.features.needsSemanticPreflight).toBe(false);
  expect(entry.features.shouldAnalyze).toBe(false);
});

test.serial("closure-ir scan skips plain exported js helpers without jsdoc or object-param components", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/runtime.js",
    [
      "export function ButtonPanel_js($$anchor, $$props) {",
      "  return $$anchor && $$props;",
      "}",
      "",
    ].join("\n"),
  );

  const fileNames = [path.join(fixture.srcDir, "runtime.js")];
  const { program } = createProgram(fileNames, fixture.projectRoot);
  const scan = scanClosureIrFiles({ fileNames, program });
  const [entry] = scan.files;

  expect(scan.scannedFileCount).toBe(1);
  expect(scan.analyzedFileCount).toBe(0);
  expect(entry.features.docEligibility.exportedDeclarationNames).toEqual(
    new Set(["ButtonPanel_js"]),
  );
  expect(entry.features.hasTopLevelDocs).toBe(false);
  expect(entry.features.needsSemanticPreflight).toBe(false);
  expect(entry.features.shouldAnalyze).toBe(false);
});

test.serial("closure-ir scan enables semantic preflight for jsdoc and ts-check javascript", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/jsdoc.js",
    [
      "/** @param {string} label */",
      "export function Button(label) {",
      "  return label;",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/checked.js",
    [
      "// @ts-check",
      "export const value = 1;",
      "",
    ].join("\n"),
  );

  const fileNames = [
    path.join(fixture.srcDir, "jsdoc.js"),
    path.join(fixture.srcDir, "checked.js"),
  ];
  const { program } = createProgram(fileNames, fixture.projectRoot);
  const scan = scanClosureIrFiles({ fileNames, program });
  const featuresByFile = new Map(
    scan.files.map(({ features }) => [path.basename(features.filePath), features]),
  );

  expect(featuresByFile.get("jsdoc.js").needsSemanticPreflight).toBe(true);
  expect(featuresByFile.get("checked.js").needsSemanticPreflight).toBe(true);
});
