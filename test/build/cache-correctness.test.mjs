import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { resolveClosureCompilerEnvironment } from "../../src/build/closure/compiler.ts";
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
  "every published entry participates in the package signature",
  async () => {
    // A Vite-plugin or preset change alters emitted bytes without touching
    // dist/index.mjs. Hashing only that entry let a warm persistent cache
    // replay output produced by the previous build of the plugin.
    const fixture = await createFixture();
    const packageRoot = path.join(fixture.projectRoot, "package-root");
    const entries = [
      "dist/index.mjs",
      "dist/vite/index.mjs",
      "dist/presets/react.mjs",
      "dist/presets/svelte.mjs",
      "dist/presets/vue.mjs",
    ];
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"signature-probe"}\n',
      "utf8",
    );
    for (const entry of entries) {
      const entryPath = path.join(packageRoot, entry);
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, "export const value = 0;\n", "utf8");
    }

    const signatures = new Set([await getPackageSignature(packageRoot)]);
    for (const entry of entries) {
      await fs.writeFile(
        path.join(packageRoot, entry),
        `export const value = ${JSON.stringify(entry)};\n`,
        "utf8",
      );
      signatures.add(await getPackageSignature(packageRoot));
    }
    expect(signatures.size).toBe(entries.length + 1);
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
      getOptionsSignature(normalizeBuildOptions(layout(projectRoot, overrides)));
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
    const { applyStableRenamingMaps } = await import(
      "../../src/build/closure/compile-jobs/cache.ts"
    );
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
    const { persistCachedClosureJob, tryRestoreCachedClosureJob } =
      await import("../../src/build/closure/cache.ts");
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
    await persistCachedClosureJob({
      artifactFiles: [outputFile],
      cacheDir,
      compilerVersion: "test",
      job: prettyJob,
    });
    expect(
      await tryRestoreCachedClosureJob({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job: baseJob,
      }),
    ).toBe(false);
    expect(
      await tryRestoreCachedClosureJob({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job: prettyJob,
      }),
    ).toBe(true);
    expect(
      await tryRestoreCachedClosureJob({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job: {
          ...prettyJob,
          typeMetadataCounts: {
            ...prettyJob.typeMetadataCounts,
            annotationCount: 2,
          },
        },
      }),
    ).toBe(false);

    const [metadataPath] = await findFilesNamed(cacheDir, "meta.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const [cachedArtifact] = Object.keys(metadata.artifacts);
    const cachedText = await fs.readFile(cachedArtifact, "utf8");
    await fs.writeFile(
      cachedArtifact,
      "X".repeat(Buffer.byteLength(cachedText)),
    );
    expect(
      await tryRestoreCachedClosureJob({
        artifactFiles: [outputFile],
        cacheDir,
        compilerVersion: "test",
        job: prettyJob,
      }),
    ).toBe(false);
  },
);
test.serial(
  "tracked file identity ignores mtime when content is unchanged",
  async () => {
    const fixture = await createFixture();
    const filePath = path.join(fixture.projectRoot, "src", "index.ts");
    const contents = "export const value = 1;\n";
    await fixture.write("src/index.ts", contents);
    const { collectTrackedFiles, trackedFilesMatch } = await import(
      "../../src/shared/file-state.ts"
    );
    const snapshot = await collectTrackedFiles([filePath]);
    expect(await trackedFilesMatch(snapshot)).toBe(true);
    await fixture.write("src/index.ts", contents);
    expect(await trackedFilesMatch(snapshot)).toBe(true);
    await fixture.write("src/index.ts", "export const value = 2;\n");
    expect(await trackedFilesMatch(snapshot)).toBe(false);
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

test.serial(
  "options signature ignores out-of-tree staging directories",
  () => {
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
    expect(
      layout("/tmp/stage-aaa/dist", ["/tmp/stage-aaa/externs.js"]),
    ).toBe(layout("/tmp/stage-bbb/dist", ["/tmp/stage-bbb/externs.js"]));
    expect(layout("/tmp/signature-project/dist")).not.toBe(
      layout("/tmp/signature-project/build"),
    );
  },
);
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
