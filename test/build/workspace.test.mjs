import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as typeWorldContext from "../../src/externs/context.ts";
import { expect, spyOn, test } from "bun:test";

import { build } from "../../src/index.ts";

import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
} from "../../src/build/resolve/workspace.ts";
import { createFixture } from "../helpers.mjs";

test.serial("failed resolution cleans acquired off and temporary workspaces", async () => {
  for (const mode of ["off", "temp"]) {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", "export const value = 1;\n");
    await fs.unlink(path.join(fixture.projectRoot, "tsconfig.json"));
    const roots = [];
    const original = nodeFs.promises.mkdtemp;
    const spy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(async (...args) => {
      const root = await original(...args);
      roots.push(root);
      return root;
    });
    let result;
    try {
      result = await build({
        entries: ["./index.ts"], cache: { mode }, packages: "off",
        projectRoot: fixture.projectRoot, srcDir: fixture.srcDir, outDir: fixture.outDir,
      });
    } finally { spy.mockRestore(); }
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(({ message }) => message).join("\n")).toMatch(/tsconfig/i);
    expect(roots.length).toBe(1);
    await expect(fs.access(roots[0])).rejects.toThrow();
  }
});

test.serial("workspace acquisition unwinds when its first child cannot be created", async () => {
  const { createCacheStore } = await import("../../src/shared/cache-store.ts");
  const fixture = await createFixture();
  for (const mode of ["off", "temp"]) {
    let root;
    const originalMkdtemp = nodeFs.promises.mkdtemp;
    const originalMkdir = nodeFs.promises.mkdir;
    const tempSpy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(async (...args) => {
      root = await originalMkdtemp(...args);
      return root;
    });
    const mkdirSpy = spyOn(nodeFs.promises, "mkdir").mockImplementation(async (dir, ...args) => {
      if (root && dir === path.join(root, "workspace")) throw new Error("workspace child failed");
      return originalMkdir(dir, ...args);
    });
    try {
      await expect(createCacheStore({ cacheDir: undefined, mode, projectRoot: fixture.projectRoot })).rejects.toThrow("workspace child failed");
    } finally { mkdirSpy.mockRestore(); tempSpy.mockRestore(); }
    await expect(fs.access(root)).rejects.toThrow();
  }
});

test.serial("partial staging acquisition removes every acquired tree", async () => {
  const { createInvocationStaging } = await import("../../src/build/cache/final/staging.ts");
  const fixture = await createFixture();
  const roots = [];
  const original = nodeFs.promises.mkdtemp;
  const spy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(async (...args) => {
    if (roots.length === 1) throw new Error("second staging acquisition failed");
    const root = await original(...args);
    roots.push(root);
    return root;
  });
  try {
    await expect(createInvocationStaging(fixture.outDir, path.join(fixture.projectRoot, ".cache", "final"))).rejects.toThrow("second staging acquisition failed");
  } finally { spy.mockRestore(); }
  await expect(fs.access(roots[0])).rejects.toThrow();
});

test.serial("cleanup failure retains the primary build diagnostic", async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", "export const value = 1;\n");
  await fs.unlink(path.join(fixture.projectRoot, "tsconfig.json"));
  let root;
  const originalMkdtemp = nodeFs.promises.mkdtemp;
  const originalRm = nodeFs.promises.rm;
  const tempSpy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(async (...args) => {
    root = await originalMkdtemp(...args);
    return root;
  });
  const rmSpy = spyOn(nodeFs.promises, "rm").mockImplementation(async (dir, ...args) => {
    if (dir === root) throw new Error("workspace disposal failed");
    return originalRm(dir, ...args);
  });
  let result;
  try {
    result = await build({
      entries: ["./index.ts"], cache: { mode: "temp" }, packages: "off",
      projectRoot: fixture.projectRoot, srcDir: fixture.srcDir, outDir: fixture.outDir,
    });
  } finally {
    rmSpy.mockRestore(); tempSpy.mockRestore();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0].message).toMatch(/tsconfig/i);
  expect(result.diagnostics.map(({ message }) => message)).toContain("workspace disposal failed");
});

test.serial("staging cleanup attempts all trees after one disposal fails", async () => {
  const { createInvocationStaging, cleanupInvocationStaging } = await import("../../src/build/cache/final/staging.ts");
  const fixture = await createFixture();
  const staging = await createInvocationStaging(fixture.outDir, path.join(fixture.projectRoot, ".cache", "final"));
  const original = nodeFs.promises.rm;
  const spy = spyOn(nodeFs.promises, "rm").mockImplementation(async (dir, ...args) => {
    if (dir === staging.outDir) throw new Error("output disposal failed");
    return original(dir, ...args);
  });
  try {
    const failure = await cleanupInvocationStaging(staging).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toContain("output disposal failed");
    await expect(fs.access(staging.finalCacheDir)).rejects.toThrow();
  } finally {
    spy.mockRestore();
    await fs.rm(staging.outDir, { force: true, recursive: true });
  }
});

test.serial("failed builds release the cache lock after reporting staging cleanup errors", { timeout: 120_000 }, async () => {
  const { getProjectCacheDir } = await import("../helpers.mjs");
  const fixture = await createFixture();
  await fixture.write("src/index.ts", "export const value = 1;\n");
  const cacheDir = path.join(fixture.projectRoot, ".cache");
  const roots = [];
  const originalMkdtemp = nodeFs.promises.mkdtemp;
  const originalRm = nodeFs.promises.rm;
  const previousFlags = process.env.GCC_CLOSURE_EXTRA_FLAGS;
  const tempSpy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(async (...args) => {
    const root = await originalMkdtemp(...args);
    roots.push(root);
    return root;
  });
  const outDirStagingPrefix = `.${path.basename(fixture.outDir)}.staging-`;
  const rmSpy = spyOn(nodeFs.promises, "rm").mockImplementation(async (dir, ...args) => {
    if (roots.includes(dir) && String(dir).includes(outDirStagingPrefix)) throw new Error("output staging disposal failed");
    return originalRm(dir, ...args);
  });
  let result;
  try {
    process.env.GCC_CLOSURE_EXTRA_FLAGS = "--definitely_not_a_real_flag";
    result = await build({
      entries: ["./index.ts"], cache: { mode: "persistent", dir: cacheDir }, packages: "off",
      projectRoot: fixture.projectRoot, srcDir: fixture.srcDir, outDir: fixture.outDir,
    });
  } finally {
    if (previousFlags === undefined) delete process.env.GCC_CLOSURE_EXTRA_FLAGS;
    else process.env.GCC_CLOSURE_EXTRA_FLAGS = previousFlags;
    rmSpy.mockRestore(); tempSpy.mockRestore();
  }
  try {
    expect(result.ok).toBe(false);
    const messages = result.diagnostics.map(({ message }) => message).join("\n");
    expect(messages).toContain("definitely_not_a_real_flag");
    expect(messages).toContain("output staging disposal failed");
    await expect(fs.access(`${getProjectCacheDir(cacheDir, fixture.projectRoot)}.lock`)).rejects.toThrow();
    for (const root of roots.filter((dir) => !dir.includes(outDirStagingPrefix))) {
      await expect(fs.access(root)).rejects.toThrow();
    }
  } finally {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
});

test.serial("browser sidecar builds protect transitive tsconfig declarations without a TypeWorld", async () => {
  const fixture = await createFixture();
  const hiddenDir = path.join(fixture.projectRoot, "types", "hidden");
  const sentinel = "export type Hidden = \"keep\";\n";
  await fixture.write("src/index.ts", "export const value = 1;\n");
  await fixture.write(
    "ambient-root.d.ts",
    'import type { Hidden } from "./types/hidden";\ndeclare const hidden: Hidden;\n',
  );
  await fixture.write("types/hidden/package.json", '{"types":"dep.d.ts"}\n');
  await fixture.write("types/hidden/dep.d.ts", sentinel);
  await fixture.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        target: "ESNext",
      },
      files: ["src/index.ts", "ambient-root.d.ts"],
    }),
  );
  const spy = spyOn(typeWorldContext, "createTypeWorld");
  let result;
  try {
    result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      outDir: hiddenDir,
      packages: "off",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      target: "browser",
      typeMetadata: {
        dependencies: [path.join(fixture.srcDir, "index.ts")],
        diagnostics: [],
        extractedCounts: {
          annotationCount: 0,
          enumDeclarationCount: 0,
          memberAnnotationCount: 0,
          typeDeclarationCount: 0,
          unresolvedTypeReferenceCount: 0,
        },
        files: [],
      },
    });
  } finally {
    spy.mockRestore();
  }
  expect(result.ok).toBe(false);
  expect(result.diagnostics.map(({ message }) => message).join("\n")).toMatch(/Unsafe outDir/);
  expect(await fixture.read("types/hidden/dep.d.ts")).toBe(sentinel);
  expect(spy).not.toHaveBeenCalled();
});

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
    const options = {
      cache: { mode: "persistent", dir: path.join(fixture.projectRoot, ".cache") },
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
    };
    const result = await build(options);

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

    await fs.rm(fixture.outDir, { force: true, recursive: true });
    const restored = await build(options);
    expect(restored.ok).toBe(true);
    expect(restored.cacheHit).toBe(true);
    expect(restored.outputFiles).toContain(destPath);
    expect(restored.outputFiles).not.toContain(path.join(fixture.outDir, "cli.js"));
    expect(await fs.readFile(destPath, "utf8")).toBe(published);
    await expect(fs.access(path.join(fixture.outDir, "cli.js"))).rejects.toThrow();
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
