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

test.serial("closure-ir scan skips plain runtime files and keeps analysis features for relevant files", async () => {
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
  expect(scan.analyzedFileCount).toBe(2);
  expect(scan.hasEnumDeclarations).toBe(true);
  expect(featuresByFile.get(fileNames[0]).shouldAnalyze).toBe(false);
  expect(featuresByFile.get(fileNames[0]).needsSemanticPreflight).toBe(false);
  expect(featuresByFile.get(fileNames[1]).needsSemanticPreflight).toBe(true);
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
