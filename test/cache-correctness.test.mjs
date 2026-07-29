import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { resolveClosureCompilerEnvironment } from "../src/build/closure/compiler.ts";
import { normalizeBuildOptions } from "../src/build/resolve/options.ts";
import { getOptionsSignature } from "../src/build/resolve/signatures.ts";
import { isObjectOf, isString } from "../src/shared/validation.ts";
import { createFixture, findFilesNamed } from "./helpers.mjs";

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
        cacheKey: "metadata-a",
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
        provenance: { declarationHash: "a" },
        version: 2,
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
  "cache metadata writes atomically and malformed JSON self-heals",
  async () => {
    const fixture = await createFixture();
    const metadataPath = path.join(fixture.projectRoot, "cache", "meta.json");
    const { readJsonIfExists, writeJson } =
      await import("../src/shared/cache-store.ts");
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
    await import("../src/shared/file-state.ts");
  const snapshot = await collectFileContentSnapshot([filePath]);
  expect(await fileContentSnapshotMatches(snapshot, [filePath])).toBe(true);
  await fs.writeFile(filePath, "BBBB");
  expect(await fileContentSnapshotMatches(snapshot, [filePath])).toBe(false);
});

test.serial(
  "Closure job cache keys and validates effective behavior",
  async () => {
    const fixture = await createFixture();
    const cacheDir = path.join(fixture.projectRoot, "closure-cache");
    const outputFile = path.join(fixture.projectRoot, "out.js");
    await fs.writeFile(outputFile, "var a = 1;\n");
    const { persistCachedClosureJob, tryRestoreCachedClosureJob } =
      await import("../src/build/closure/cache.ts");
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
