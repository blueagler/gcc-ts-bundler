import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { build } from "../dist/index.mjs";

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-ts-bundler-test-"));
  t.after(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    outDir: path.join(root, "dist"),
    projectRoot: root,
    srcDir: path.join(root, "src"),
    async read(relativePath) {
      return fs.readFile(path.join(root, relativePath), "utf8");
    },
    async write(relativePath, contents) {
      const filePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    },
  };
}

test("builds an ESM package from node_modules in ADVANCED mode", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport default value + 1;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","exports":{"browser":"./browser.js","import":"./import.js"}}\n',
  );
  await fixture.write("node_modules/demo-pkg/browser.js", "export const value = 41;\n");
  await fixture.write("node_modules/demo-pkg/import.js", "export const value = 99;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.outputFiles.length, 1);
  const output = await fixture.read("dist/index.js");
  assert.doesNotMatch(output, /demo-pkg/);
});

test("builds a CommonJS package entrypoint from node_modules", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import { answer } from "demo-pkg";\nexport default answer;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    [
      "exports.answer = 42;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.match(output, /42/);
});

test("rewrites namespace imports from CommonJS packages to runtime-safe interop", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import * as demo from "demo-pkg";\nexport default demo.answer;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    "exports.answer = 42;\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.match(output, /42/);
});

test("emits a shared chunk when multiple entries use the same package", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/a.ts",
    'import { shared } from "demo-pkg";\nexport const a = shared + 1;\n',
  );
  await fixture.write(
    "src/b.ts",
    'import { shared } from "demo-pkg";\nexport const b = shared + 2;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","module":"./index.js"}\n',
  );
  await fixture.write("node_modules/demo-pkg/index.js", "export const shared = 40;\n");

  const result = await build({
    cache: { mode: "off" },
    entries: ["./a.ts", "./b.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.outputFiles
      .map((filePath) => path.basename(filePath))
      .sort((left, right) => left.localeCompare(right)),
    ["a.js", "b.js", "shared.js"],
  );
});

test("folds process.env.NODE_ENV to the production CommonJS branch", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport const result = value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.js"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.js",
    [
      'if (process.env.NODE_ENV === "production") {',
      '  module.exports = require("./prod.cjs");',
      "} else {",
      '  module.exports = require("./dev.cjs");',
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/demo-pkg/prod.cjs",
    'exports.value = "PROD_BRANCH";\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/dev.cjs",
    'exports.value = "DEV_BRANCH";\n',
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.match(output, /PROD_BRANCH/);
  assert.doesNotMatch(output, /DEV_BRANCH/);
  assert.doesNotMatch(output, /\.cjs/);
});

test("full preflight accepts JS dependencies from node_modules", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import { value } from "demo-pkg";\nexport const answer = value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","module":"./index.js"}\n',
  );
  await fixture.write("node_modules/demo-pkg/index.js", "export const value = 7;\n");

  const result = await build({
    cache: { mode: "off" },
    diagnostics: { preflight: "full" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
});

test("builds mixed ESM and CommonJS package graphs", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import { result } from "demo-pkg";\nexport default result;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    [
      'const dep = require("./dep.js");',
      "exports.result = dep.value + 1;",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "node_modules/demo-pkg/dep.js",
    "export const value = 4;\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.doesNotMatch(output, /require\(/);
  assert.doesNotMatch(output, /module\.exports/);
});

test("builds decorated TypeScript sources", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/decorators.ts",
    [
      "export function increment(_value: unknown, _context: ClassAccessorDecoratorContext) {",
      "  return {",
      "    init(value: number) {",
      "      return value + 1;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  await fixture.write(
    "src/index.ts",
    [
      'import { increment } from "./decorators.js";',
      "",
      "class Counter {",
      "  @increment accessor value = 1;",
      "}",
      "",
      "export const total = new Counter().value;",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.doesNotMatch(output, /@increment/);
});

test("exported entry bundles do not retain GCC wrapper exports", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    [
      "export class MotionHero {",
      "  static tag = 'motion-hero';",
      "}",
      "",
    ].join("\n"),
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 0);
  const output = await fixture.read("dist/index.js");
  assert.match(output, /export/);
  assert.doesNotMatch(output, /globalThis\.GCC/);
  assert.doesNotMatch(output, /__gcc_export_/);
});

test("unsupported CommonJS packages surface actionable diagnostics", async (t) => {
  const fixture = await createFixture(t);
  await fixture.write(
    "src/index.ts",
    'import value from "demo-pkg";\nexport default value;\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/package.json",
    '{"name":"demo-pkg","main":"./index.cjs"}\n',
  );
  await fixture.write(
    "node_modules/demo-pkg/index.cjs",
    "module.exports = require(name);\n",
  );

  const result = await build({
    cache: { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.emitSkipped, true);
  assert.ok(result.diagnostics.length > 0);
  assert.match(String(result.diagnostics[0].messageText), /Unsupported CommonJS/);
});
