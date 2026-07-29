import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { build, cleanCache } from "../dist/index.mjs";
import { createFixture, getProjectCacheDir } from "./helpers.mjs";

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
    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const latestPath = path.join(projectCacheDir, "resolve", "latest.json");
    const firstLatest = JSON.parse(await fs.readFile(latestPath, "utf8"));

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
    const secondLatest = JSON.parse(await fs.readFile(latestPath, "utf8"));
    expect(secondLatest.nativeEmitKey).not.toBe(firstLatest.nativeEmitKey);
    expect(secondLatest.finalKey).not.toBe(firstLatest.finalKey);
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
    const latest = JSON.parse(
      await fs.readFile(
        path.join(projectCacheDir, "resolve", "latest.json"),
        "utf8",
      ),
    );
    const fastPath = path.join(projectCacheDir, "final-fast.json");
    const finalMetaPath = path.join(
      projectCacheDir,
      "final",
      latest.finalKey,
      "meta.json",
    );
    await Promise.all([
      fs.writeFile(fastPath, '{"finalKey":'),
      fs.writeFile(finalMetaPath, '{"outputFiles":'),
      fs.rm(fixture.outDir, { force: true, recursive: true }),
    ]);

    const rebuilt = await build(options);
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.cacheHit).toBe(false);
    expect(JSON.parse(await fs.readFile(fastPath, "utf8"))).toBeTruthy();
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
    const latestPath = path.join(projectCacheDir, "resolve", "latest.json");
    const latest = JSON.parse(await fs.readFile(latestPath, "utf8"));
    const nativeMetaPath = path.join(
      projectCacheDir,
      "native-emit",
      latest.nativeEmitKey,
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
      fs.rm(path.join(projectCacheDir, "final-fast.json"), { force: true }),
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

    const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
    const latest = JSON.parse(
      await fs.readFile(
        path.join(projectCacheDir, "resolve", "latest.json"),
        "utf8",
      ),
    );
    const nativeMetadata = JSON.parse(
      await fs.readFile(
        path.join(
          projectCacheDir,
          "native-emit",
          latest.nativeEmitKey,
          "meta.json",
        ),
        "utf8",
      ),
    );
    expect(
      Object.keys(nativeMetadata.typeMetadataDependencies).some((filePath) =>
        filePath.endsWith(`${path.sep}src${path.sep}types.ts`),
      ),
    ).toBe(true);
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
