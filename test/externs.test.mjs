import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build, generateExterns } from "../dist/index.mjs";
import {
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
  expect(result.text).toContain("Object.prototype.hostConnected;");
  expect(result.text).toContain("Object.prototype.hostDisconnected;");
  expect(result.text).toContain("Object.prototype.togglePlay;");
  expect(result.text).toContain("Object.prototype.isAnimating;");
  expect(result.text).toContain("Object.prototype.link;");
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
  expect(result.text).toContain("Object.prototype.bump;");
  expect(result.text).toContain("Object.prototype.counts;");
  expect(result.text).toContain("Object.prototype.label;");
  expect(result.text).toContain("Object.prototype.reset;");
  expect(result.text).toContain("Object.prototype.from;");
  expect(result.text).not.toContain("Object.prototype.addEventListener;");
  expect(result.text).not.toContain("Object.prototype.apply;");
  expect(result.text).not.toContain("Object.prototype.length;");
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
  expect(externsOutput).toContain("Object.prototype.togglePlay;");
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

test.serial("build auto-generates runtime-aware dependency externs for helper-lowered fields", async () => {
  const fixture = await createRuntimeExternFixture();

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
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

test.serial("reuses cached runtime-aware dependency externs across final build variants", async () => {
  const fixture = await createRuntimeExternFixture();
  const cacheDir = path.join(fixture.projectRoot, ".cache");

  const firstResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    compilationLevel: "ADVANCED",
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(firstResult.exitCode).toBe(0);

  const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
  const externFiles = await findFilesNamed(
    path.join(projectCacheDir, "native-emit"),
    "runtime-dependency-externs.js",
  );
  expect(externFiles).toHaveLength(1);
  const firstStat = await fs.stat(externFiles[0]);

  await new Promise((resolve) => setTimeout(resolve, 25));

  const secondResult = await build({
    cache: { dir: cacheDir, mode: "persistent" },
    compilationLevel: "SIMPLE",
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });
  expect(secondResult.exitCode).toBe(0);

  const secondStat = await fs.stat(externFiles[0]);
  expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
});
