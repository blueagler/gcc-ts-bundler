import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
import {
  createFixture,
  createExternFixture,
  createRuntimeExternFixture,
  execFileAsync,
  findFilesNamed,
  getProjectCacheDir,
} from "./helpers.mjs";

test.serial("generateExterns follows declaration dependencies and emits stable property externs", async () => {
  const fixture = await createExternFixture();

  const result = await generateExterns({
    appEntryFiles: ["./main.ts"],
    modules: ["contract-pkg"],
    mode: "boundary-aware",
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.scannedFiles.some((filePath) => filePath.endsWith("/base-host/index.d.ts"))).toBe(true);
  expect(result.mode).toBe("boundary-aware");
  expect(result.text).toContain("Object.prototype.addController;");
  expect(result.text).toContain("Object.prototype.removeController;");
  expect(result.text).toContain("Object.prototype.requestUpdate;");
  expect(result.text).toContain("Object.prototype.updateComplete;");
  expect(result.text).not.toContain("Object.prototype.hostConnected;");
  expect(result.text).not.toContain("Object.prototype.hostDisconnected;");
  expect(result.text).not.toContain("Object.prototype.togglePlay;");
  expect(result.text).not.toContain("Object.prototype.isAnimating;");
  expect(result.text).not.toContain("Object.prototype.link;");
  expect(result.text).not.toContain("Object.prototype.attribute;");
  expect(result.text).not.toContain("Object.prototype.reflect;");
  expect(result.text).not.toContain("Object.prototype.map;");
  expect(result.text).not.toContain("__gcc_extern_");
});

test.serial("generateExterns candidates mode resolves package subpaths that ship sibling declaration files", async () => {
  const fixture = await createExternFixture();

  const result = await generateExterns({
    includeDependencies: false,
    mode: "candidates",
    modules: ["contract-pkg/decorators.js"],
    projectRoot: fixture.projectRoot,
  });

  expect(result.scannedFiles).toHaveLength(1);
  expect(result.mode).toBe("candidates");
  expect(result.text).toContain("Object.prototype.attribute;");
  expect(result.text).toContain("Object.prototype.reflect;");
});

test.serial("generateExterns boundary-aware mode ignores app-only object protocol keys", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/main.ts",
    [
      "const tpl = {",
      '  ["__protocol__"]: 1,',
      "  values: [],",
      "};",
      "export const view = tpl;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/dummy-pkg/package.json",
    JSON.stringify(
      {
        name: "dummy-pkg",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
  );
  await fixture.write(
    "node_modules/dummy-pkg/index.d.ts",
    "export interface Dummy {}\n",
  );

  const result = await generateExterns({
    appEntryFiles: ["./main.ts"],
    modules: ["dummy-pkg"],
    mode: "boundary-aware",
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.text).not.toContain("Object.prototype.__protocol__;");
  expect(result.text).not.toContain("Object.prototype.values;");
});

test.serial("generateExterns runtime-aware mode captures helper-lowered dependency fields without noise", async () => {
  const fixture = await createRuntimeExternFixture();

  const result = await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    projectRoot: fixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: fixture.srcDir,
  });

  expect(result.mode).toBe("runtime-aware");
  expect(result.text).toContain("Object.prototype.counts;");
  expect(result.text).toContain("Object.prototype.label;");
  expect(result.text).not.toContain("Object.prototype.reset;");
  expect(result.text).not.toContain("Object.prototype.from;");
  expect(result.text).not.toContain("Object.prototype.bump;");
  expect(result.text).not.toContain("Object.prototype.addEventListener;");
  expect(result.text).not.toContain("Object.prototype.apply;");
  expect(result.text).not.toContain("Object.prototype.length;");
});

test.serial("generateExterns runtime-aware mode keeps string-defined members used from app code", async () => {
  const fixture = await createRuntimeExternFixture();
  await fixture.write(
    "src/index.ts",
    [
      'import { Counter } from "runtime-pkg";',
      "const counter = Counter.from();",
      "counter.reset();",
      'export const current = counter.bump("demo");',
      "",
    ].join("\n"),
  );

  const result = await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    projectRoot: fixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: fixture.srcDir,
  });

  expect(result.text).toContain("Object.prototype.reset;");
  expect(result.text).toContain("Object.prototype.from;");
});

test.serial("externs CLI writes generated output with bun-compatible tests", async () => {
  const fixture = await createExternFixture();
  const outputFile = path.join(
    fixture.projectRoot,
    "closure-externs",
    "contract.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./main.ts",
    "--project-root",
    fixture.projectRoot,
    "--src-dir",
    fixture.srcDir,
    "--module",
    "contract-pkg",
    "--output-file",
    outputFile,
  ]);

  const externsOutput = await fs.readFile(outputFile, "utf8");
  expect(externsOutput).toContain("/** @externs */");
  expect(externsOutput).toContain("Object.prototype.addController;");
  expect(externsOutput).toContain("Object.prototype.updateComplete;");
  expect(externsOutput).not.toContain("Object.prototype.togglePlay;");
  expect(externsOutput).not.toContain("Object.prototype.attribute;");
});

test.serial("externs CLI runtime-aware mode accepts runtime-entry files", async () => {
  const fixture = await createRuntimeExternFixture();
  const outputFile = path.join(
    fixture.projectRoot,
    "closure-externs",
    "runtime.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./index.ts",
    "--project-root",
    fixture.projectRoot,
    "--src-dir",
    fixture.srcDir,
    "--runtime-entry",
    "./node_modules/runtime-pkg/index.js",
    "--mode",
    "runtime-aware",
    "--module",
    "runtime-pkg",
    "--output-file",
    outputFile,
  ]);

  const externsOutput = await fs.readFile(outputFile, "utf8");
  expect(externsOutput).toContain("Object.prototype.counts;");
  expect(externsOutput).toContain("Object.prototype.label;");
  expect(externsOutput).not.toContain("Object.prototype.addEventListener;");
});

test.serial("build uses explicit runtime-aware dependency externs for helper-lowered fields", async () => {
  const fixture = await createRuntimeExternFixture();
  const externsFile = path.join(
    fixture.projectRoot,
    "closure-externs",
    "runtime.generated.js",
  );

  await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    outputFile: externsFile,
    projectRoot: fixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: fixture.srcDir,
  });

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    externs: ["./closure-externs/runtime.generated.js"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  expect(result.exitCode).toBe(0);
  const output = await fixture.read("dist/index.js");
  expect(output).not.toMatch(/runtime-pkg/);

  const builtModule = await import(
    `${pathToFileURL(path.join(fixture.outDir, "index.js")).href}?runtime=${Date.now()}`
  );
  expect(builtModule.first).toBe("demo:1");
  expect(builtModule.second).toBe("demo:2");
});

test.serial("build does not auto-generate runtime-aware dependency externs by default", async () => {
  const fixture = await createRuntimeExternFixture();
  const cacheDir = path.join(fixture.projectRoot, ".cache");

  const result = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    compilationLevel: "ADVANCED",
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(result.exitCode).toBe(0);

  const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
  const externFiles = await findFilesNamed(
    path.join(projectCacheDir, "native-emit"),
    "runtime-dependency-externs.js",
  );
  expect(externFiles).toHaveLength(0);
});
