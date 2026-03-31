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
  await fixture.write("node_modules/demo-pkg/index.cjs", "module.exports = 1;\n");

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
  assert.match(String(result.diagnostics[0].messageText), /CommonJS/);
});
