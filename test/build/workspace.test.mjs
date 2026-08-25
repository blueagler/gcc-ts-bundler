import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../../src/index.ts";

import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
} from "../../src/build/resolve/workspace.ts";
import { createFixture } from "../helpers.mjs";

test("workspace symlink setup is concurrency-safe", async () => {
  const fixture = await createFixture();
  const targetPath = path.join(fixture.projectRoot, "target");
  const linkPath = path.join(fixture.projectRoot, "workspace", "src");
  await fs.mkdir(targetPath, { recursive: true });

  await Promise.all(
    Array.from({ length: 32 }, () =>
      ensureDirectorySymlink(linkPath, targetPath),
    ),
  );

  const currentTarget = await fs.readlink(linkPath);
  expect(path.resolve(path.dirname(linkPath), currentTarget)).toBe(targetPath);
});

test("workspace node_modules uses the nearest project ancestor", async () => {
  const fixture = await createFixture();
  const projectRoot = path.join(fixture.projectRoot, "packages", "app");
  const nearestNodeModules = path.join(
    fixture.projectRoot,
    "packages",
    "node_modules",
  );
  const workspaceDir = path.join(fixture.projectRoot, "workspace");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(nearestNodeModules, { recursive: true });
  await fs.mkdir(path.join(fixture.projectRoot, "node_modules"), {
    recursive: true,
  });

  await ensureWorkspaceNodeModules(workspaceDir, {
    packages: "esm-only",
    projectRoot,
  });

  const linkPath = path.join(workspaceDir, "node_modules");
  const currentTarget = await fs.readlink(linkPath);
  expect(path.resolve(path.dirname(linkPath), currentTarget)).toBe(
    nearestNodeModules,
  );
});

test.serial(
  "off-mode outFile publishes outside outDir and rewrites shared imports",
  { timeout: 60_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      [
        "let calls = 0;",
        "export function sharedValue() {",
        "  calls += 1;",
        "  return calls;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/lib.ts",
      'import { sharedValue } from "./helper";\nexport function libValue() {\n  return sharedValue();\n}\n',
    );
    await fixture.write(
      "src/cli.ts",
      'import { sharedValue } from "./helper";\nexport function run() {\n  return sharedValue();\n}\n',
    );

    const destPath = path.join(fixture.projectRoot, "bin", "cli.mjs");
    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "off", outputType: "esm" },
      compilationLevel: "SIMPLE",
      entries: [
        "./lib.ts",
        { file: "./cli.ts", name: "cli.js", outFile: "bin/cli.mjs" },
      ],
      outDir: fixture.outDir,
      packages: "off",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      target: "node",
    });

    expect(result.ok).toBe(true);
    expect(result.outputFiles).toContain(destPath);
    expect(result.outputFiles).not.toContain(path.join(fixture.outDir, "cli.js"));
    await expect(fs.access(path.join(fixture.outDir, "cli.js"))).rejects.toThrow();
    await fs.access(destPath);
    const published = await fs.readFile(destPath, "utf8");
    expect(published).toMatch(/from\s*["']\.\.\/dist\/shared\.js["']/u);
    expect(published).not.toMatch(/\b(?:from|import)\s*["']\.\/shared\.js["']/u);

    const cli = await import(
      `${pathToFileURL(destPath).href}?outFile=${Date.now()}`
    );
    expect(cli.run()).toBe(1);
    const lib = await import(
      `${pathToFileURL(path.join(fixture.outDir, "lib.js")).href}?outFile-lib=${Date.now()}`
    );
    expect(lib.libValue()).toBe(2);
  },
);

test.serial(
  "off-mode ESM strips unused bare shared chunk imports from unused leaves",
  { timeout: 60_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write(
      "src/helper.ts",
      'export function helper() {\n  return "used";\n}\n',
    );
    await fixture.write(
      "src/a.ts",
      'import { helper } from "./helper";\nexport const a = helper();\n',
    );
    await fixture.write(
      "src/b.ts",
      'import { helper } from "./helper";\nexport const b = helper();\n',
    );
    await fixture.write("src/preset.ts", "export const PRESET = 7;\n");

    const result = await build({
      cache: { mode: "off" },
      chunks: { mode: "off", outputType: "esm" },
      compilationLevel: "ADVANCED",
      entries: [
        "./a.ts",
        "./b.ts",
        { file: "./preset.ts", name: "presets/local.js" },
      ],
      outDir: fixture.outDir,
      packages: "off",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      target: "node",
    });

    expect(result.ok).toBe(true);
    expect(
      result.outputFiles
        .map((filePath) => path.relative(fixture.outDir, filePath))
        .sort(),
    ).toEqual(["a.js", "b.js", "presets/local.js", "shared.js"]);

    const preset = await fixture.read("dist/presets/local.js");
    expect(preset).not.toContain('import"../shared.js"');
    expect(preset).not.toContain("import '../shared.js'");
    expect(preset).not.toMatch(
      /\bimport\s*["'](?:[^"']*\/)?shared(?:\d+)?\.js["'];?/u,
    );

    const loaded = await import(
      `${pathToFileURL(path.join(fixture.outDir, "presets", "local.js")).href}?preset=${Date.now()}`
    );
    expect(loaded.PRESET).toBe(7);
  },
);
