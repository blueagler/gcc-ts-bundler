import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";
import * as closureCompilerPackage from "google-closure-compiler";

import {
  configureClosureCompilerOptions,
  resolveClosureCompilerEnvironment,
} from "../../src/build/closure/compiler.ts";
import { normalizeBuildOptions } from "../../src/build/resolve/options.ts";
import {
  getOptionsSignature,
  getPackageSignature,
  hashExternalInputs,
} from "../../src/build/resolve/signatures.ts";
import { isObjectOf, isString } from "../../src/shared/validation.ts";
import { createFixture, findFilesNamed } from "../helpers.mjs";

globalThis.__gcc_current_module_url = import.meta.url;

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
  "inherited compiler options refresh without touching the root config",
  async () => {
    const { loadCompilerOptions } =
      await import("../../src/build/resolve/compiler-options.ts");
    const fixture = await createFixture();
    await fixture.write("src/index.ts", "export const value = 1;\n");
    await fixture.write(
      "tsconfig.json",
      '{"extends":"./base.json","include":["src"]}',
    );
    await fixture.write(
      "base.json",
      '{"compilerOptions":{"strictNullChecks":false}}',
    );
    const configPath = path.join(fixture.projectRoot, "tsconfig.json");
    expect((await loadCompilerOptions(configPath)).strictNullChecks).toBe(
      false,
    );
    await fixture.write(
      "base.json",
      '{"compilerOptions":{"strictNullChecks":true}}',
    );
    expect((await loadCompilerOptions(configPath)).strictNullChecks).toBe(true);
  },
);

test.serial(
  "explicit JS roots retain fresh inherited ambient inputs and config errors",
  async () => {
    const { loadTsConfigDeclarationFiles, parseTsConfig } =
      await import("../../src/build/resolve/compiler-options.ts");
    const fixture = await createFixture();
    await fixture.write("captured/main.js", "export const value = 1;\n");
    await fixture.write("tsconfig.json", '{"extends":"./config/base.json"}');
    await fixture.write(
      "config/base.json",
      '{"compilerOptions":{"strictNullChecks":true},"include":["../types/**/*.d.ts"]}',
    );
    const configPath = path.join(fixture.projectRoot, "tsconfig.json");
    const entry = path.join(fixture.projectRoot, "captured/main.js");
    const initial = parseTsConfig(configPath, [entry]);
    expect(initial.parsed.fileNames).toContain(entry);
    expect(await loadTsConfigDeclarationFiles(configPath, initial)).toEqual([]);

    await fixture.write(
      "types/ambient.d.ts",
      "declare const ambientValue: number;\n",
    );
    const refreshed = parseTsConfig(configPath, [entry]);
    expect(await loadTsConfigDeclarationFiles(configPath, refreshed)).toEqual([
      path.join(fixture.projectRoot, "types/ambient.d.ts"),
    ]);

    await fixture.write(
      "config/base.json",
      '{"compilerOptions":{"target":"invalid"},"include":["../types/**/*.d.ts"]}',
    );
    expect(() => parseTsConfig(configPath, [entry])).toThrow(/target/);
  },
);

test.serial(
  "failed lock owner initialization unwinds only its own acquisition",
  async () => {
    const { acquireProjectCacheLock } =
      await import("../../src/shared/cache-store.ts");
    const fixture = await createFixture();
    const projectCacheDir = path.join(fixture.projectRoot, "cache");
    const lockPath = `${projectCacheDir}.lock`;
    const original = nodeFs.promises.writeFile;
    const spy = spyOn(nodeFs.promises, "writeFile").mockImplementation(
      async (file, ...args) => {
        if (file === path.join(lockPath, "owner.json"))
          throw new Error("owner write failed");
        return original(file, ...args);
      },
    );
    try {
      await expect(acquireProjectCacheLock(projectCacheDir)).rejects.toThrow(
        "owner write failed",
      );
    } finally {
      spy.mockRestore();
    }
    await expect(fs.access(lockPath)).rejects.toThrow();
    const release = await acquireProjectCacheLock(projectCacheDir);
    await release();
  },
);

test.serial(
  "a failed lock mkdir never removes another invocation's lock",
  async () => {
    const { acquireProjectCacheLock } =
      await import("../../src/shared/cache-store.ts");
    const fixture = await createFixture();
    const projectCacheDir = path.join(fixture.projectRoot, "cache");
    const release = await acquireProjectCacheLock(projectCacheDir);
    const lockPath = `${projectCacheDir}.lock`;
    const before = await fs.readFile(path.join(lockPath, "owner.json"), "utf8");
    const original = nodeFs.promises.mkdir;
    const spy = spyOn(nodeFs.promises, "mkdir").mockImplementation(
      async (dir, ...args) => {
        if (dir === lockPath)
          throw Object.assign(new Error("mkdir denied"), { code: "EACCES" });
        return original(dir, ...args);
      },
    );
    try {
      await expect(acquireProjectCacheLock(projectCacheDir)).rejects.toThrow(
        "mkdir denied",
      );
      expect(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(
        before,
      );
    } finally {
      spy.mockRestore();
      await release();
    }
    await expect(fs.access(lockPath)).rejects.toThrow();
  },
);

test.serial(
  "stale unidentified locks fail closed and preserve their contents",
  async () => {
    const { acquireProjectCacheLock } =
      await import("../../src/shared/cache-store.ts");
    const fixture = await createFixture();
    const projectCacheDir = path.join(fixture.projectRoot, "cache");
    const lockPath = `${projectCacheDir}.lock`;
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owner.json"), "broken");
    const stale = new Date("2020-01-01T00:00:00Z");
    await fs.utimes(lockPath, stale, stale);
    const failure = await acquireProjectCacheLock(projectCacheDir).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(lockPath);
    expect(failure.message).toMatch(/no build is active/);
    expect(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).toBe(
      "broken",
    );
  },
);

test.serial(
  "package identity tracks implementation bytes and JavaScript membership behind unchanged facades",
  async () => {
    const fixture = await createFixture();
    const packageRoot = path.join(fixture.projectRoot, "package-root");
    await fixture.write(
      "package-root/package.json",
      '{"name":"signature-probe"}\n',
    );
    const bootstrap = await getPackageSignature(packageRoot);

    const facade = 'export { value } from "./chunks/implementation.js";\n';
    const implementation = "export const value = 1;\n";
    await fixture.write("package-root/dist/index.mjs", facade);
    await fixture.write(
      "package-root/dist/chunks/implementation.js",
      implementation,
    );
    const original = await getPackageSignature(packageRoot);
    expect(original).not.toBe(bootstrap);

    await fixture.write(
      "package-root/dist/chunks/implementation.js",
      "export const value = 2;\n",
    );
    expect(await getPackageSignature(packageRoot)).not.toBe(original);
    expect(await fixture.read("package-root/dist/index.mjs")).toBe(facade);
    await fixture.write(
      "package-root/dist/chunks/implementation.js",
      implementation,
    );
    expect(await getPackageSignature(packageRoot)).toBe(original);

    await fixture.write(
      "package-root/dist/runtime/helper.cjs",
      "module.exports = 1;\n",
    );
    const added = await getPackageSignature(packageRoot);
    expect(added).not.toBe(original);
    await fs.rename(
      path.join(packageRoot, "dist/runtime/helper.cjs"),
      path.join(packageRoot, "dist/runtime/renamed.cjs"),
    );
    const renamed = await getPackageSignature(packageRoot);
    expect(renamed).not.toBe(added);
    await fs.unlink(path.join(packageRoot, "dist/runtime/renamed.cjs"));
    expect(await getPackageSignature(packageRoot)).toBe(original);
    expect(await fixture.read("package-root/dist/index.mjs")).toBe(facade);
  },
);

test.serial("output behavior participates in the options signature", () => {
  const base = {
    cache: { mode: "persistent" },
    entries: ["./index.ts"],
    projectRoot: "/tmp/signature-project",
    srcDir: "./src",
  };
  const signature = (overrides = {}) =>
    getOptionsSignature(normalizeBuildOptions({ ...base, ...overrides }));
  const baseSignature = signature();
  const signatures = new Set([
    baseSignature,
    signature({ chunks: { baseChunkName: "other" } }),
    signature({ compat: { pureCallees: ["pureCall"] } }),
    signature({ platformExterns: "full" }),
    signature({
      typeMetadata: {
        dependencies: ["/tmp/signature-project/types.d.ts"],
        diagnostics: [],
        extractedCounts: {
          annotationCount: 1,
          enumDeclarationCount: 0,
          memberAnnotationCount: 0,
          typeDeclarationCount: 0,
          unresolvedTypeReferenceCount: 0,
        },
        files: [],
      },
    }),
  ]);
  expect(signatures.size).toBe(5);
  expect(
    normalizeBuildOptions({
      ...base,
      chunks: { manifestFile: "meta/chunks/manifest.json" },
    }).chunks.manifestFile,
  ).toBe("meta/chunks/manifest.json");
  expect(() =>
    normalizeBuildOptions({
      ...base,
      chunks: { manifestFile: "../escape.json" },
    }),
  ).toThrow(/safe relative file path/);

  const restoreEnv = setEnv(
    "GCC_CLOSURE_EXTRA_FLAGS",
    "--formatting=PRETTY_PRINT",
  );
  try {
    expect(signature()).not.toBe(baseSignature);
  } finally {
    restoreEnv();
  }

  const restoreManaged = setEnv(
    "GCC_CLOSURE_EXTRA_FLAGS",
    "--js_output_file=/tmp/unsafe.js",
  );
  try {
    expect(() => resolveClosureCompilerEnvironment()).toThrow(
      /managed Closure flag/,
    );
  } finally {
    restoreManaged();
  }
});
test.serial(
  "threading overrides emit one scalar flag regardless of spelling",
  () => {
    const restoreDebug = setEnv("GCC_CLOSURE_DEBUG", undefined);
    const restoreFlags = setEnv("GCC_CLOSURE_EXTRA_FLAGS", undefined);
    try {
      for (const name of [
        "num_parallel_threads",
        "numParallelThreads",
        "num-parallel-threads",
      ]) {
        process.env.GCC_CLOSURE_EXTRA_FLAGS =
          "--num_parallel_threads=1 --numParallelThreads=2 " +
          `--num-parallel-threads=3 --${name}=7 --${name}=8`;
        const options = { compilationLevel: "ADVANCED" };
        configureClosureCompilerOptions(options);
        const compiler = new closureCompilerPackage.compiler(options);
        expect(compiler.commandArguments).toEqual([
          "--compilation_level=ADVANCED",
          "--num_parallel_threads=8",
        ]);
      }
    } finally {
      restoreFlags();
      restoreDebug();
    }
  },
);

test.serial(
  "options signature is independent of the absolute project root",
  () => {
    const layout = (projectRoot, overrides = {}) => ({
      cache: { mode: "persistent" },
      entries: [{ file: "./index.ts", outFile: "dist/index.js" }],
      externs: [path.join(projectRoot, "externs.js")],
      js: [path.join(projectRoot, "extra.js")],
      outDir: "./dist",
      projectRoot,
      srcDir: "./src",
      typedExterns: [path.join(projectRoot, "typed-externs.js")],
      ...overrides,
    });
    const signature = (projectRoot, overrides = {}) =>
      getOptionsSignature(
        normalizeBuildOptions(layout(projectRoot, overrides)),
      );
    const rootA = "/tmp/signature-root-a";
    const rootB = "/tmp/signature-root-b";
    const relocated = signature(rootB);
    expect(signature(rootA)).toBe(relocated);

    const signatures = new Set([
      relocated,
      signature(rootA, { outDir: "./build" }),
      signature(rootA, {
        entries: [{ file: "./index.ts", outFile: "dist/app.js" }],
      }),
      signature(rootA, { externs: [path.join(rootA, "other-externs.js")] }),
    ]);
    expect(signatures.size).toBe(4);
  },
);

test.serial(
  "typed extern scopes participate in cache keys without path spelling noise",
  async () => {
    const fixture = await createFixture();
    await fixture.write("typed.js", "/** @externs */\nvar callerContract;\n");
    const options = (typedExterns) =>
      normalizeBuildOptions({
        entries: ["a.ts", "b.ts"],
        projectRoot: fixture.projectRoot,
        srcDir: "./src",
        typedExterns,
      });
    const scoped = (entries) => options([{ path: "./typed.js", entries }]);
    const a = scoped(["./src/a.ts"]);
    const b = scoped(["./src/b.ts"]);
    const both = scoped(["./src/a.ts", "./src/b.ts"]);
    const signature = (resolved) => getOptionsSignature(resolved);
    expect(
      new Set([a, b, both, options(["./typed.js"])].map(signature)).size,
    ).toBe(4);
    expect(signature(scoped(["src/./b.ts", "src/a.ts", "src/b.ts"]))).toBe(
      signature(both),
    );
    expect(
      signature(scoped([path.join(fixture.projectRoot, "src/a.ts")])),
    ).toBe(signature(a));
    const before = await hashExternalInputs(
      a.typedExterns.map((extern) => extern.path),
    );
    await fixture.write("typed.js", "/** @externs */\nvar changedContract;\n");
    expect(
      await hashExternalInputs(a.typedExterns.map((extern) => extern.path)),
    ).not.toBe(before);
    expect(() => scoped([])).toThrow(/nonempty entries/);
    expect(() => scoped(["./src/not-configured.ts"])).toThrow(
      /not a configured build entry/,
    );
  },
);

test.serial(
  "cache metadata writes atomically and malformed JSON self-heals",
  async () => {
    const fixture = await createFixture();
    const metadataPath = path.join(fixture.projectRoot, "cache", "meta.json");
    const { readJsonIfExists, writeJson } =
      await import("../../src/shared/cache-store.ts");
    const validate = isObjectOf({ value: isString });

    await writeJson(metadataPath, { value: "ok" });
    expect(await readJsonIfExists(metadataPath, validate)).toEqual({
      value: "ok",
    });
    await fs.writeFile(metadataPath, '{"value":');
    expect(await readJsonIfExists(metadataPath, validate)).toBeNull();
    expect(
      await fs
        .stat(metadataPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  },
);

test.serial("content snapshots reject same-size tampering", async () => {
  const fixture = await createFixture();
  const filePath = path.join(fixture.projectRoot, "artifact.js");
  await fs.writeFile(filePath, "AAAA");
  const { collectFileContentSnapshot, fileContentSnapshotMatches } =
    await import("../../src/shared/file-state.ts");
  const snapshot = await collectFileContentSnapshot([filePath]);
  expect(await fileContentSnapshotMatches(snapshot, [filePath])).toBe(true);
  await fs.writeFile(filePath, "BBBB");
  expect(await fileContentSnapshotMatches(snapshot, [filePath])).toBe(false);
});

test.serial(
  "variable renaming reports are paired to the job's property report",
  async () => {
    const fixture = await createFixture();
    const { applyStableRenamingMaps } =
      await import("../../src/build/closure/compile-jobs/cache.ts");
    const cacheDir = path.join(fixture.projectRoot, "closure-jobs");
    const rawDir = path.join(fixture.projectRoot, "raw");
    const react = await applyStableRenamingMaps(
      {
        jsOutputFile: path.join(rawDir, "react.js"),
        propertyRenamingReportPath: path.join(
          rawDir,
          "react.property-renaming-report.txt",
        ),
      },
      cacheDir,
    );
    const vue = await applyStableRenamingMaps(
      {
        jsOutputFile: path.join(rawDir, "vue.js"),
        propertyRenamingReportPath: path.join(
          rawDir,
          "vue.property-renaming-report.txt",
        ),
      },
      cacheDir,
    );
    expect(react.variableRenamingReportPath).toBe(
      path.join(rawDir, "react.variable-renaming-report.txt"),
    );
    expect(vue.variableRenamingReportPath).toBe(
      path.join(rawDir, "vue.variable-renaming-report.txt"),
    );
    expect(react.variableRenamingReportPath).not.toBe(
      vue.variableRenamingReportPath,
    );
  },
);

test.serial(
  "Closure job cache keys and validates effective behavior",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "closure-cache");
    const outputFile = path.join(fixture.projectRoot, "out.js");
    await fs.writeFile(outputFile, "var a = 1;\n");
    const {
      persistCachedClosureJob,
      prepareClosureJobCache,
      tryRestoreCachedClosureJob,
    } = await import("../../src/build/closure/cache.ts");
    const baseJob = {
      assumeFunctionWrapper: true,
      compilationLevel: "ADVANCED",
      externs: [],
      hasTypeMetadata: true,
      js: [],
      jsOutputFile: outputFile,
      languageIn: "UNSTABLE",
      languageOut: "ECMASCRIPT_NEXT",
      rewritePolyfills: false,
      typeMetadataCounts: {
        annotationCount: 1,
        enumDeclarationCount: 0,
        memberAnnotationCount: 0,
        typeDeclarationCount: 0,
        unresolvedTypeReferenceCount: 0,
      },
      warningLevel: "QUIET",
    };
    const prettyJob = {
      ...baseJob,
      compilerEnvironment: { formatting: "PRETTY_PRINT" },
    };
    const prepare = (job) =>
      prepareClosureJobCache({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job,
      });
    const pretty = await prepare(prettyJob);
    await persistCachedClosureJob(pretty);
    expect(await tryRestoreCachedClosureJob(await prepare(baseJob))).toBe(
      false,
    );
    expect(await tryRestoreCachedClosureJob(pretty)).toBe(true);
    expect(
      await tryRestoreCachedClosureJob(
        await prepare({
          ...prettyJob,
          typeMetadataCounts: {
            ...prettyJob.typeMetadataCounts,
            annotationCount: 2,
          },
        }),
      ),
    ).toBe(false);

    const [metadataPath] = await findFilesNamed(cacheDir, "meta.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const [cachedArtifact] = Object.keys(metadata.artifacts);
    const cachedText = await fs.readFile(cachedArtifact, "utf8");
    await fs.writeFile(
      cachedArtifact,
      "X".repeat(Buffer.byteLength(cachedText)),
    );
    expect(await tryRestoreCachedClosureJob(pretty)).toBe(false);
  },
);

test.serial(
  "Closure job cache does not persist when inputs change after the key is prepared",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "closure-cache");
    const outputFile = path.join(fixture.projectRoot, "out.js");
    const jsFile = path.join(fixture.projectRoot, "input.js");
    await fs.writeFile(outputFile, "var a = 1;\n");
    await fs.writeFile(jsFile, "var x = 1;\n");
    const {
      persistCachedClosureJob,
      prepareClosureJobCache,
      tryRestoreCachedClosureJob,
    } = await import("../../src/build/closure/cache.ts");
    const prepared = await prepareClosureJobCache({
      artifactFiles: [outputFile],
      cacheDir,
      compilerVersion: "test",
      job: {
        assumeFunctionWrapper: true,
        compilationLevel: "ADVANCED",
        externs: [],
        hasTypeMetadata: true,
        js: [jsFile],
        jsOutputFile: outputFile,
        languageIn: "UNSTABLE",
        languageOut: "ECMASCRIPT_NEXT",
        rewritePolyfills: false,
        typeMetadataCounts: {
          annotationCount: 1,
          enumDeclarationCount: 0,
          memberAnnotationCount: 0,
          typeDeclarationCount: 0,
          unresolvedTypeReferenceCount: 0,
        },
        warningLevel: "QUIET",
      },
    });
    await fs.writeFile(jsFile, "var x = 2;\n");
    await persistCachedClosureJob(prepared);
    expect(await tryRestoreCachedClosureJob(prepared)).toBe(false);
  },
);

test.serial("external input hashes ignore absolute file paths", async () => {
  const fixture = await createFixture();
  const same = "/** @externs */\nvar probeGlobal;\n";
  await fixture.write("a.js", same);
  await fixture.write("nested/b.js", same);
  await fixture.write("c.js", "/** @externs */\nvar otherGlobal;\n");
  const hashA = await hashExternalInputs([
    path.join(fixture.projectRoot, "a.js"),
  ]);
  const hashB = await hashExternalInputs([
    path.join(fixture.projectRoot, "nested", "b.js"),
  ]);
  const hashC = await hashExternalInputs([
    path.join(fixture.projectRoot, "c.js"),
  ]);
  expect(hashA).toBe(hashB);
  expect(hashA).not.toBe(hashC);
});

test.serial("options signature ignores out-of-tree staging directories", () => {
  const layout = (outDir, externs = []) =>
    getOptionsSignature(
      normalizeBuildOptions({
        cache: { mode: "persistent" },
        entries: ["./index.ts"],
        externs,
        outDir,
        projectRoot: "/tmp/signature-project",
        srcDir: "./src",
      }),
    );
  expect(layout("/tmp/stage-aaa/dist", ["/tmp/stage-aaa/externs.js"])).toBe(
    layout("/tmp/stage-bbb/dist", ["/tmp/stage-bbb/externs.js"]),
  );
  expect(layout("/tmp/signature-project/dist")).not.toBe(
    layout("/tmp/signature-project/build"),
  );
});
test.serial(
  "persistent cache hits after identical rewrite and a fresh out-of-tree outDir",
  { timeout: 120_000 },
  async () => {
    const { build } = await import("../../src/index.ts");
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, ".cache");
    const source = 'export const value = "stable";\n';
    await fixture.write("src/index.ts", source);
    const stagingRoot = path.join(fixture.projectRoot, "..");
    const stableOutDir = path.join(
      stagingRoot,
      `${path.basename(fixture.projectRoot)}-out-stable`,
    );
    const freshOutDir = path.join(
      stagingRoot,
      `${path.basename(fixture.projectRoot)}-out-fresh`,
    );
    const options = {
      cache: { dir: cacheDir, mode: "persistent" },
      entries: ["./index.ts"],
      outDir: stableOutDir,
      packages: "off",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
    };

    // Asserted through the `cacheHit` contract and the emitted bytes rather
    // than by scraping `GCC_BUILD_TIMINGS` output: `logInternalDetail` reads
    // that variable when its module first loads, so a sibling test in this
    // file can already have fixed the value before this one sets it.
    const readOutputs = async (outDir) => {
      const names = (await fs.readdir(outDir)).sort();
      return Object.fromEntries(
        await Promise.all(
          names.map(async (name) => [
            name,
            await fs.readFile(path.join(outDir, name), "utf8"),
          ]),
        ),
      );
    };
    try {
      expect((await build(options)).ok).toBe(true);
      const cold = await readOutputs(stableOutDir);
      expect(Object.keys(cold).length).toBeGreaterThan(0);

      const warm = await build(options);
      expect(warm.ok).toBe(true);
      expect(warm.cacheHit).toBe(true);
      expect(await readOutputs(stableOutDir)).toEqual(cold);

      // Same bytes, new mtime. A cache keyed on mtime rather than content
      // treats this as a change and recompiles.
      await fixture.write("src/index.ts", source);
      const rewritten = await build(options);
      expect(rewritten.ok).toBe(true);
      expect(rewritten.cacheHit).toBe(true);
      expect(await readOutputs(stableOutDir)).toEqual(cold);

      // Relocating the output directory must not invalidate the cache, and
      // must still produce identical bytes.
      const fresh = await build({ ...options, outDir: freshOutDir });
      expect(fresh.ok).toBe(true);
      expect(fresh.cacheHit).toBe(true);
      expect(await readOutputs(freshOutDir)).toEqual(cold);
    } finally {
      await Promise.all([
        fs.rm(stableOutDir, { force: true, recursive: true }),
        fs.rm(freshOutDir, { force: true, recursive: true }),
      ]);
    }
  },
);
