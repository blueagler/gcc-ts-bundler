import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { build, cleanCache } from "../../dist/index.mjs";
import {
  createFixture,
  findFilesNamed,
  getProjectCacheDir,
} from "../helpers.mjs";

const BUILD_TIMEOUT = 120_000;

function buildOptions(fixture, cacheDir, overrides = {}) {
  return {
    cache: cacheDir ? { dir: cacheDir, mode: "persistent" } : { mode: "off" },
    entries: ["./index.ts"],
    outDir: fixture.outDir,
    packages: "off",
    projectRoot: fixture.projectRoot,
    srcDir: fixture.srcDir,
    ...overrides,
  };
}

function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

test.serial(
  "metadata preparation failures preserve previously published output",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export const value = "PREVIOUS";\n');
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);
    const previous = await fixture.read("dist/index.js");
    await fixture.write("src/index.ts", 'export const value = "NEXT";\n');
    const original = nodeFs.promises.writeFile;
    const spy = spyOn(nodeFs.promises, "writeFile").mockImplementation(
      async (file, ...args) => {
        if (
          String(file).includes(".staging-") &&
          path.basename(String(file)).startsWith(".meta.json.")
        ) {
          throw new Error("final metadata write failed");
        }
        return original(file, ...args);
      },
    );
    let result;
    try {
      result = await build(options);
    } finally {
      spy.mockRestore();
    }
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.map(({ message }) => message).join("\n"),
    ).toContain("final metadata write failed");
    expect(await fixture.read("dist/index.js")).toBe(previous);
  },
);

test.serial(
  "fresh resolution notices a newly added higher-priority source",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export { value } from "./value";\n');
    await fixture.write("src/value.js", 'export const value = "JAVASCRIPT";\n');
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);
    expect(await fixture.read("dist/index.js")).toContain("JAVASCRIPT");
    await fixture.write("src/value.ts", 'export const value = "TYPESCRIPT";\n');
    const changed = await build(options);
    expect(changed.ok).toBe(true);
    expect(changed.cacheHit).toBe(false);
    expect(await fixture.read("dist/index.js")).toContain("TYPESCRIPT");
  },
);

test.serial(
  "new and nearer explicit-external declarations invalidate opaque final hits",
  { timeout: BUILD_TIMEOUT },
  async () => {
    for (const scenario of ["appearing", "nearer"]) {
      const fixture = await createFixture();
      const cacheDir = path.join(fixture.projectRoot, ".cache");
      const manifest = JSON.stringify({
        name: "cache-edge-dep",
        type: "module",
        exports: "./index.js",
      });
      const goodDeclaration = "export declare const value: number;\n";
      const badDeclaration = "export declare const value: string;\n";
      await fixture.write("package.json", '{"type":"module"}\n');
      await fixture.write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "ESNext",
            moduleResolution: "Bundler",
            target: "ESNext",
            types: [],
          },
          include: ["src"],
        }),
      );
      await fixture.write(
        "src/index.ts",
        'import { value } from "cache-edge-dep";\nexport const result: number = value;\n',
      );
      await fixture.write("node_modules/cache-edge-dep/package.json", manifest);
      await fixture.write(
        "node_modules/cache-edge-dep/index.js",
        "export const value = 41;\n",
      );
      if (scenario === "nearer") {
        await fixture.write(
          "node_modules/cache-edge-dep/index.d.ts",
          goodDeclaration,
        );
      }
      const options = buildOptions(fixture, cacheDir, {
        chunks: { mode: "off", outputType: "esm" },
        diagnostics: { preflight: "errors-only" },
        externals: ["cache-edge-dep"],
        packages: "esm-only",
      });
      expect((await build(options)).ok).toBe(true);
      expect((await build(options)).cacheHit).toBe(true);
      await fixture.write("node_modules/cache-edge-dep/package.json", manifest);
      expect((await build(options)).cacheHit).toBe(true);

      const packageDir =
        scenario === "nearer"
          ? "src/node_modules/cache-edge-dep"
          : "node_modules/cache-edge-dep";
      if (scenario === "nearer") {
        await fixture.write(`${packageDir}/package.json`, manifest);
      }
      await fixture.write(`${packageDir}/index.d.ts`, badDeclaration);
      const previousOutput = await fixture.read("dist/index.js");
      const invalidated = await build(options);
      expect(invalidated.ok).toBe(false);
      expect(
        invalidated.diagnostics.some(
          ({ file, line }) =>
            file === path.join(fixture.srcDir, "index.ts") && line === 2,
        ),
      ).toBe(true);
      expect(await fixture.read("dist/index.js")).toBe(previousOutput);

      await fixture.write(`${packageDir}/index.d.ts`, goodDeclaration);
      const repaired = await build(options);
      expect(repaired.ok).toBe(true);
      expect(repaired.cacheHit).toBe(false);
      expect((await build(options)).cacheHit).toBe(true);
      await fixture.write(`${packageDir}/index.d.ts`, goodDeclaration);
      expect((await build(options)).cacheHit).toBe(true);

      await fixture.write(`${packageDir}/index.d.ts`, badDeclaration);
      expect((await build(options)).ok).toBe(false);
      await fixture.write(`${packageDir}/index.d.ts`, goodDeclaration);
      await fixture.write(`${packageDir}/alternate.d.ts`, badDeclaration);
      await fixture.write(
        `${packageDir}/package.json`,
        JSON.stringify({
          name: "cache-edge-dep",
          type: "module",
          exports: {
            ".": { types: "./alternate.d.ts", default: "./index.js" },
          },
        }),
      );
      const changedPackage = await build(options);
      expect(changedPackage.ok).toBe(false);
      expect(
        changedPackage.diagnostics.some(
          ({ file, line }) =>
            file === path.join(fixture.srcDir, "index.ts") && line === 2,
        ),
      ).toBe(true);
    }
  },
);

test.serial(
  "inherited compiler config changes invalidate final artifacts",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export const value = "CONFIG";\n');
    await fixture.write(
      "tsconfig.json",
      '{"extends":"./base.json","include":["src"]}',
    );
    await fixture.write(
      "base.json",
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ESNext","strictNullChecks":false}}',
    );
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);
    expect((await build(options)).cacheHit).toBe(true);
    await fixture.write(
      "base.json",
      '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","target":"ESNext","strictNullChecks":true}}',
    );
    const changed = await build(options);
    expect(changed.ok).toBe(true);
    expect(changed.cacheHit).toBe(false);
    expect(await fixture.read("dist/index.js")).toContain("CONFIG");
  },
);

test.serial(
  "restoration leaves canonical cached artifacts immutable and replaces stale output",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export const value = "IMMUTABLE";\n');
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);
    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const [metadataPath] = await findFilesNamed(
      path.join(projectCacheDir, "final"),
      "meta.json",
    );
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const files = metadata.artifacts.map(({ name }) =>
      path.join(path.dirname(metadataPath), "outputs", name),
    );
    const before = await Promise.all(
      files.map((file) => fs.readFile(file, "utf8")),
    );
    const expected = await fixture.read("dist/index.js");
    await fixture.write("dist/index.js", "TAMPERED");
    await fixture.write("dist/unrelated-stale.js", "STALE");
    const original = nodeFs.promises.mkdtemp;
    const spy = spyOn(nodeFs.promises, "mkdtemp").mockImplementation(
      async (prefix, ...args) => {
        if (
          path
            .resolve(String(prefix))
            .startsWith(`${projectCacheDir}${path.sep}`)
        ) {
          throw Object.assign(
            new Error("Cache staging writes are disallowed"),
            { code: "EACCES" },
          );
        }
        return original(prefix, ...args);
      },
    );
    let restored;
    try {
      restored = await build(options);
    } finally {
      spy.mockRestore();
    }
    expect(restored.ok).toBe(true);
    expect(restored.cacheHit).toBe(true);
    expect(await fixture.read("dist/index.js")).toBe(expected);
    await expect(
      fs.access(path.join(fixture.outDir, "unrelated-stale.js")),
    ).rejects.toThrow();
    expect(
      await Promise.all(files.map((file) => fs.readFile(file, "utf8"))),
    ).toEqual(before);
  },
);

test.serial(
  "failed restoration cleans leftover output staging and external temps",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/helper.ts", "export const helper = 1;\n");
    await fixture.write(
      "src/index.ts",
      'import { helper } from "./helper";\nexport const value = helper;\n',
    );
    const destPath = path.join(fixture.projectRoot, "bin", "cli.mjs");
    const options = buildOptions(fixture, cacheDir, {
      chunks: { mode: "off", outputType: "esm" },
      compilationLevel: "SIMPLE",
      entries: [
        { file: "./index.ts", name: "index.js", outFile: "bin/cli.mjs" },
      ],
    });
    expect((await build(options)).ok).toBe(true);
    await fixture.write("dist/index.js", "TAMPERED");
    await fs.writeFile(destPath, "STALE-RELOCATED");
    const leftover = [];
    let leftoverOutputStaging;
    const originalRename = nodeFs.promises.rename;
    const originalRm = nodeFs.promises.rm;
    const renameSpy = spyOn(nodeFs.promises, "rename").mockImplementation(
      async (from, to) => {
        if (
          leftoverOutputStaging === undefined &&
          path.resolve(String(to)) === path.resolve(fixture.outDir)
        ) {
          leftoverOutputStaging = String(from);
          throw new Error("output tree commit failed");
        }
        return originalRename(from, to);
      },
    );
    const rmSpy = spyOn(nodeFs.promises, "rm").mockImplementation(
      async (target, ...args) => {
        leftover.push(String(target));
        return originalRm(target, ...args);
      },
    );
    let result;
    try {
      result = await build(options);
    } finally {
      renameSpy.mockRestore();
      rmSpy.mockRestore();
    }
    expect(result.ok).toBe(false);
    const messages = result.diagnostics
      .map(({ message }) => message)
      .join("\n");
    expect(messages).toContain("output tree commit failed");
    expect(await fixture.read("dist/index.js")).toBe("TAMPERED");
    expect(await fs.readFile(destPath, "utf8")).toBe("STALE-RELOCATED");
    const leftoverTemps = leftover.filter(
      (file) =>
        path.basename(file).includes(".cli.mjs.") && file.endsWith(".tmp"),
    );
    expect(leftoverTemps.length).toBeGreaterThan(0);
    for (const file of leftoverTemps)
      await expect(fs.access(file)).rejects.toThrow();
    expect(leftoverOutputStaging).toBeDefined();
    await expect(fs.access(leftoverOutputStaging)).rejects.toThrow();
  },
);

test.serial(
  "unsafe outFile destinations leave source and config bytes untouched",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", "export const value = 42;\n");
    await fixture.write("extra.js", "/** @externs */\nvar extra;\n");
    await fixture.write(
      "base.json",
      '{"compilerOptions":{"target":"ESNext","module":"ESNext","moduleResolution":"Bundler"}}',
    );
    await fixture.write(
      "tsconfig.json",
      '{"extends":"./base.json","include":["src"]}',
    );
    const protectedPaths = [
      "src/index.ts",
      "tsconfig.json",
      "base.json",
      "extra.js",
    ];
    const before = await Promise.all(
      protectedPaths.map((file) => fixture.read(file)),
    );
    for (const outFile of protectedPaths) {
      const result = await build(
        buildOptions(fixture, null, {
          chunks: { mode: "off", outputType: "esm" },
          entries: [{ file: "./index.ts", outFile }],
          externs: [path.join(fixture.projectRoot, "extra.js")],
        }),
      );
      expect(result.ok).toBe(false);
      expect(
        result.diagnostics.map(({ message }) => message).join("\n"),
      ).toMatch(/Unsafe outFile/);
      expect(
        await Promise.all(protectedPaths.map((file) => fixture.read(file))),
      ).toEqual(before);
    }
    if (process.platform !== "win32") {
      await fs.symlink(
        path.join(fixture.projectRoot, "base.json"),
        path.join(fixture.projectRoot, "alias.js"),
      );
      const result = await build(
        buildOptions(fixture, null, {
          chunks: { mode: "off", outputType: "esm" },
          entries: [{ file: "./index.ts", outFile: "alias.js" }],
        }),
      );
      expect(result.ok).toBe(false);
      expect(await fixture.read("base.json")).toBe(before[2]);
    }
  },
);

test.serial(
  "rejects canonical destructive output boundaries before touching inputs",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", "export const value = 42;\n");
    await fixture.write("src/sentinel.txt", "KEEP\n");

    const sourceOverlap = await build(
      buildOptions(fixture, null, { outDir: fixture.srcDir }),
    );
    expect(sourceOverlap.ok).toBe(false);
    expect(sourceOverlap.diagnostics[0]?.message).toMatch(/Unsafe outDir/);
    expect(await fixture.read("src/index.ts")).toContain("value = 42");
    expect(await fixture.read("src/sentinel.txt")).toBe("KEEP\n");

    const cacheOverlap = await build(
      buildOptions(fixture, path.join(fixture.outDir, "cache")),
    );
    expect(cacheOverlap.ok).toBe(false);
    expect(cacheOverlap.diagnostics[0]?.message).toMatch(/cache workspace/);

    if (process.platform !== "win32") {
      const linkedOutDir = path.join(fixture.projectRoot, "linked-output");
      await fs.symlink(fixture.srcDir, linkedOutDir, "dir");
      const canonicalOverlap = await build(
        buildOptions(fixture, null, { outDir: linkedOutDir }),
      );
      expect(canonicalOverlap.ok).toBe(false);
      expect(canonicalOverlap.diagnostics[0]?.message).toMatch(/Unsafe outDir/);
    }
  },
);

test.serial(
  "failed Closure builds preserve the last published output",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", 'export const value = "GOOD";\n');
    const options = buildOptions(fixture, null);
    expect((await build(options)).ok).toBe(true);
    const published = await fixture.read("dist/index.js");

    await fixture.write("src/index.ts", 'export const value = "NEW";\n');
    const restoreEnv = setEnv(
      "GCC_CLOSURE_EXTRA_FLAGS",
      "--definitely_not_a_real_flag",
    );
    try {
      const failed = await build(options);
      expect(failed.ok).toBe(false);
    } finally {
      restoreEnv();
    }
    expect(await fixture.read("dist/index.js")).toBe(published);
  },
);

test.serial(
  "safe nested manifest paths survive publication and cache restore",
  { timeout: BUILD_TIMEOUT },
  async () => {
    for (const mode of ["bundler-runtime", "split"]) {
      const fixture = await createFixture();
      const cacheDir = path.join(fixture.projectRoot, ".cache");
      await fixture.write(
        "src/index.ts",
        [
          'const loadFeature = () => import("./feature");',
          "globalThis.__nestedManifestLoader = loadFeature;",
          "",
        ].join("\n"),
      );
      await fixture.write("src/feature.ts", 'export const value = "LAZY";\n');
      const manifestFile = "meta/chunks/chunk-map.json";
      const options = buildOptions(fixture, cacheDir, {
        chunks: { manifestFile, mode },
      });

      const first = await build(options);
      expect(first.ok).toBe(true);
      expect(
        first.outputFiles.map((filePath) =>
          path.relative(fixture.outDir, filePath).replace(/\\/g, "/"),
        ),
      ).toContain(manifestFile);
      expect(
        JSON.parse(await fixture.read(`dist/${manifestFile}`)),
      ).toBeTruthy();

      await fs.rm(fixture.outDir, { force: true, recursive: true });
      const restored = await build(options);
      expect(restored.ok).toBe(true);
      expect(restored.cacheHit).toBe(true);
      expect(
        JSON.parse(await fixture.read(`dist/${manifestFile}`)),
      ).toBeTruthy();
    }
  },
);

test.serial(
  "compat changes invalidate native and final cache restores",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write(
      "src/index.ts",
      [
        "function consume(value: Record<string, number>) { return value; }",
        "export const result = Object.keys(consume({ dangerous: 1 }))[0];",
        "",
      ].join("\n"),
    );
    const options = buildOptions(fixture, cacheDir);
    const first = await build(options);
    expect(first.ok).toBe(true);

    const second = await build({
      ...options,
      compat: {
        classMapCalls: [
          { argIndex: 0, callee: "consume", keyPattern: "^dangerous$" },
        ],
      },
    });
    expect(second.ok).toBe(true);
    expect(second.cacheHit).toBe(false);
  },
);

test.serial(
  "same-size source and published-output tampering cannot produce a positive hit",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const sourcePath = path.join(fixture.srcDir, "index.ts");
    const fixedTime = new Date("2025-01-01T00:00:00.000Z");
    await fixture.write("src/index.ts", 'export const value = "AAAA";\n');
    await fs.utimes(sourcePath, fixedTime, fixedTime);
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);

    const outputPath = path.join(fixture.outDir, "index.js");
    const goodOutput = await fs.readFile(outputPath, "utf8");
    await fs.writeFile(outputPath, "X".repeat(Buffer.byteLength(goodOutput)));
    const repairedOutput = await build(options);
    expect(repairedOutput.ok).toBe(true);
    expect(repairedOutput.cacheHit).toBe(true);
    expect(await fs.readFile(outputPath, "utf8")).toBe(goodOutput);

    await fs.writeFile(sourcePath, 'export const value = "BBBB";\n');
    await fs.utimes(sourcePath, fixedTime, fixedTime);
    await fs.rm(fixture.outDir, { force: true, recursive: true });
    const rebuilt = await build(options);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.cacheHit).toBe(false);
    expect(await fs.readFile(outputPath, "utf8")).toContain("BBBB");
  },
);

test.serial(
  "malformed final cache metadata self-heals as a miss",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", "export const value = 42;\n");
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const [finalMetaPath] = await findFilesNamed(
      path.join(projectCacheDir, "final"),
      "meta.json",
    );
    await Promise.all([
      fs.writeFile(finalMetaPath, '{"artifacts":'),
      fs.rm(fixture.outDir, { force: true, recursive: true }),
    ]);

    const rebuilt = await build(options);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.cacheHit).toBe(false);
    expect(JSON.parse(await fs.readFile(finalMetaPath, "utf8"))).toBeTruthy();
  },
);

test.serial(
  "native emit cache artifacts are validated by digest",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", 'export const value = "ORIGINAL";\n');
    const options = buildOptions(fixture, cacheDir);
    expect((await build(options)).ok).toBe(true);

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const [nativeMetaPath] = await findFilesNamed(
      path.join(projectCacheDir, "native-emit"),
      "meta.json",
    );
    const nativeMeta = JSON.parse(await fs.readFile(nativeMetaPath, "utf8"));
    const emittedFile = nativeMeta.emittedFiles.find((filePath) =>
      filePath.endsWith(`${path.sep}index.js`),
    );
    expect(emittedFile).toBeTruthy();
    const emittedText = await fs.readFile(emittedFile, "utf8");
    await fs.writeFile(emittedFile, "X".repeat(Buffer.byteLength(emittedText)));
    await Promise.all([
      fs.rm(path.join(projectCacheDir, "final"), {
        force: true,
        recursive: true,
      }),
      fs.rm(fixture.outDir, { force: true, recursive: true }),
    ]);

    const rebuilt = await build(options);
    expect(rebuilt.ok).toBe(true);
    expect(await fixture.read("dist/index.js")).toContain("ORIGINAL");
  },
);

test.serial(
  "type-only dependency edits invalidate standalone final and native caches",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const typeFile = path.join(fixture.srcDir, "types.ts");
    await fixture.write(
      "src/index.ts",
      [
        'import type { Config } from "./types";',
        "export function read(config: Config): string {",
        "  return config.label;",
        "}",
        "",
      ].join("\n"),
    );
    await fixture.write(
      "src/types.ts",
      "export interface Config { label: string; optional?: string }\n",
    );
    const options = buildOptions(fixture, cacheDir);

    expect((await build(options)).ok).toBe(true);
    const warm = await build(options);
    expect(warm.ok).toBe(true);
    expect(warm.cacheHit).toBe(true);

    await fs.writeFile(
      typeFile,
      "export interface Config { label: string; optional?: number }\n",
    );
    const rebuilt = await build(options);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.cacheHit).toBe(false);

    const warmAgain = await build(options);
    expect(warmAgain.ok).toBe(true);
    expect(warmAgain.cacheHit).toBe(true);
  },
);

test.serial(
  "cold concurrent builds serialize shared cache mutation",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    await fixture.write("src/index.ts", "export const value = 42;\n");
    const options = buildOptions(fixture, cacheDir);
    const results = await Promise.all([
      build(options),
      build(options),
      build(options),
      build(options),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await fixture.read("dist/index.js")).toContain("42");
    expect(
      await fs
        .stat(`${getProjectCacheDir(cacheDir, fixture.projectRoot)}.lock`)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  },
);

test.serial(
  "cleanCache resolves relative cacheDir from projectRoot",
  { timeout: BUILD_TIMEOUT },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", "export const value = 42;\n");
    const relativeCacheDir = "cache-rel";
    const options = buildOptions(fixture, relativeCacheDir);
    expect((await build(options)).ok).toBe(true);
    const cacheRoot = path.join(fixture.projectRoot, relativeCacheDir);
    const projectCacheDir = getProjectCacheDir(cacheRoot, fixture.projectRoot);
    expect((await fs.stat(projectCacheDir)).isDirectory()).toBe(true);

    const callerDir = path.join(fixture.projectRoot, "caller");
    await fs.mkdir(callerDir);
    const previousCwd = process.cwd();
    process.chdir(callerDir);
    try {
      await cleanCache({
        cacheDir: relativeCacheDir,
        projectRoot: fixture.projectRoot,
      });
    } finally {
      process.chdir(previousCwd);
    }
    expect(
      await fs
        .stat(projectCacheDir)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  },
);
