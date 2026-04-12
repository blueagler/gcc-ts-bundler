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

test.serial("generateExterns runtime-aware mode captures public runtime protocols without noise", async () => {
  const runtimeFixture = await createRuntimeExternFixture();
  await runtimeFixture.write(
    "src/index.ts",
    [
      'import { Counter } from "runtime-pkg";',
      "const counter = Counter.from();",
      "counter.reset();",
      'export const current = counter.bump("demo");',
      "",
    ].join("\n"),
  );

  const runtimeResult = await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    projectRoot: runtimeFixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: runtimeFixture.srcDir,
  });

  expect(runtimeResult.mode).toBe("runtime-aware");
  expect(runtimeResult.text).toContain("Object.prototype.counts;");
  expect(runtimeResult.text).toContain("Object.prototype.current;");
  expect(runtimeResult.text).toContain("Object.prototype.previous;");
  expect(runtimeResult.text).toContain("Object.prototype.is_fork;");
  expect(runtimeResult.text).toContain("Object.prototype.id;");
  expect(runtimeResult.text).toContain("Object.prototype.label;");
  expect(runtimeResult.text).toContain("Object.prototype.reset;");
  expect(runtimeResult.text).toContain("Object.prototype.from;");
  expect(runtimeResult.text).not.toContain("Object.prototype.bump;");
  expect(runtimeResult.text).not.toContain("Object.prototype.addEventListener;");
  expect(runtimeResult.text).not.toContain("Object.prototype.apply;");
  expect(runtimeResult.text).not.toContain("Object.prototype.length;");

  const protocolFixture = await createFixture();
  await protocolFixture.write(
    "src/runtime.js",
    [
      "const helpers = {",
      "  prop(props, key) {",
      "    return props[key];",
      "  },",
      "  rest_props(props, keys) {",
      "    return keys.length ? props : {};",
      "  },",
      "};",
      "export function view(props) {",
      '  return helpers.prop(props, "variant") ?? helpers.rest_props(props, ["$$slots", "$$events", "$$legacy", "size"]);',
      "}",
      "",
    ].join("\n"),
  );

  const protocolResult = await generateExterns({
    mode: "runtime-aware",
    modules: ["demo-runtime"],
    projectRoot: protocolFixture.projectRoot,
    runtimeEntryFiles: ["./runtime.js"],
    srcDir: protocolFixture.srcDir,
  });

  expect(protocolResult.text).toContain("Object.prototype.$$slots;");
  expect(protocolResult.text).toContain("Object.prototype.$$events;");
  expect(protocolResult.text).toContain("Object.prototype.$$legacy;");
  expect(protocolResult.text).toContain("Object.prototype.variant;");
  expect(protocolResult.text).toContain("Object.prototype.size;");
  expect(protocolResult.text).not.toContain("Object.prototype.prop;");
  expect(protocolResult.text).not.toContain("Object.prototype.rest_props;");
});

test.serial("externs CLI emits boundary-aware and runtime-aware outputs", async () => {
  const boundaryFixture = await createExternFixture();
  const boundaryOutputFile = path.join(
    boundaryFixture.projectRoot,
    "closure-externs",
    "contract.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./main.ts",
    "--project-root",
    boundaryFixture.projectRoot,
    "--src-dir",
    boundaryFixture.srcDir,
    "--module",
    "contract-pkg",
    "--output-file",
    boundaryOutputFile,
  ]);

  const boundaryOutput = await fs.readFile(boundaryOutputFile, "utf8");
  expect(boundaryOutput).toContain("/** @externs */");
  expect(boundaryOutput).toContain("Object.prototype.addController;");
  expect(boundaryOutput).toContain("Object.prototype.updateComplete;");
  expect(boundaryOutput).not.toContain("Object.prototype.togglePlay;");
  expect(boundaryOutput).not.toContain("Object.prototype.attribute;");

  const runtimeFixture = await createRuntimeExternFixture();
  const runtimeOutputFile = path.join(
    runtimeFixture.projectRoot,
    "closure-externs",
    "runtime.generated.js",
  );

  await execFileAsync(process.execPath, [
    path.join(process.cwd(), "bin", "gcc-ts-bundler.cjs"),
    "externs",
    "--entry",
    "./index.ts",
    "--project-root",
    runtimeFixture.projectRoot,
    "--src-dir",
    runtimeFixture.srcDir,
    "--runtime-entry",
    "./node_modules/runtime-pkg/index.js",
    "--mode",
    "runtime-aware",
    "--module",
    "runtime-pkg",
    "--output-file",
    runtimeOutputFile,
  ]);

  const runtimeOutput = await fs.readFile(runtimeOutputFile, "utf8");
  expect(runtimeOutput).toContain("Object.prototype.counts;");
  expect(runtimeOutput).toContain("Object.prototype.label;");
  expect(runtimeOutput).not.toContain("Object.prototype.addEventListener;");
});

test.serial("build uses explicit runtime-aware externs to preserve runtime and protocol contracts", async () => {
  const runtimeFixture = await createRuntimeExternFixture();
  const runtimeExternsFile = path.join(
    runtimeFixture.projectRoot,
    "closure-externs",
    "runtime.generated.js",
  );

  await generateExterns({
    appEntryFiles: ["./index.ts"],
    mode: "runtime-aware",
    modules: ["runtime-pkg"],
    outputFile: runtimeExternsFile,
    projectRoot: runtimeFixture.projectRoot,
    runtimeEntryFiles: ["./node_modules/runtime-pkg/index.js"],
    srcDir: runtimeFixture.srcDir,
  });

  const runtimeResult = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    externs: ["./closure-externs/runtime.generated.js"],
    outDir: runtimeFixture.outDir,
    projectRoot: runtimeFixture.projectRoot,
    srcDir: runtimeFixture.srcDir,
  });

  expect(runtimeResult.exitCode).toBe(0);
  const runtimeOutput = await runtimeFixture.read("dist/index.js");
  expect(runtimeOutput).not.toMatch(/runtime-pkg/);

  const builtModule = await import(
    `${pathToFileURL(path.join(runtimeFixture.outDir, "index.js")).href}?runtime=${Date.now()}`
  );
  expect(builtModule.first).toBe("demo:1");
  expect(builtModule.second).toBe("demo:2");

  const protocolFixture = await createFixture();
  const protocolExternsFile = path.join(
    protocolFixture.projectRoot,
    "closure-externs",
    "protocol.generated.js",
  );
  await protocolFixture.write(
    "src/helpers.js",
    [
      "export function prop(props, key) {",
      "  return props[key];",
      "}",
      "export function rest_props(props, keys) {",
      "  const next = {};",
      "  for (const key in props) {",
      "    if (keys.includes(key)) {",
      "      continue;",
      "    }",
      "    next[key] = props[key];",
      "  }",
      "  return next;",
      "}",
      "export function render(props) {",
      '  const variant = prop(props, "variant");',
      '  const extra = rest_props(props, ["$$slots", "$$events", "$$legacy", "variant"]);',
      "  return { extra, variant };",
      "}",
      "",
    ].join("\n"),
  );
  await protocolFixture.write(
    "src/main.js",
    [
      'import { render } from "./helpers.js";',
      "const result = render({",
      '  $$slots: { default: true },',
      '  class: "m3-container",',
      '  variant: "filled",',
      "});",
      'globalThis["__protocolHasObjectValue"] = Object.values(result.extra).some((value) => value && typeof value === "object");',
      'globalThis["__protocolVariant"] = result.variant;',
      "",
    ].join("\n"),
  );

  await generateExterns({
    mode: "runtime-aware",
    modules: ["demo-runtime"],
    outputFile: protocolExternsFile,
    projectRoot: protocolFixture.projectRoot,
    runtimeEntryFiles: ["./helpers.js"],
    srcDir: protocolFixture.srcDir,
  });

  const protocolResult = await build({
    cache: { mode: "off" },
    entries: ["./main.js"],
    externs: ["./closure-externs/protocol.generated.js"],
    outDir: protocolFixture.outDir,
    projectRoot: protocolFixture.projectRoot,
    srcDir: protocolFixture.srcDir,
  });

  expect(protocolResult.exitCode).toBe(0);
  await import(
    `${pathToFileURL(path.join(protocolFixture.outDir, "main.js")).href}?protocol=${Date.now()}`
  );
  expect(globalThis.__protocolHasObjectValue).toBe(false);
  expect(globalThis.__protocolVariant).toBe("filled");
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
