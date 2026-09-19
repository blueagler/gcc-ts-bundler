import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

import { generatePlatformExternsText } from "../../src/build/closure/platform-externs/generate.ts";
import {
  loadPlatformExternArchive,
  readPlatformExternArchive,
  resolvePlatformExternCompilerJarPath,
} from "../../src/build/closure/platform-externs/archive.ts";
import { getPlatformExternIndex } from "../../src/build/closure/platform-externs/index.ts";
import { getDefaultPersistentCacheRoot } from "../../src/shared/cache-store.ts";
import { platformExternParserDigest } from "../../src/build/closure/platform-externs/index.ts";

/**
 * A token unique to this file's process, stamped into every identity this file
 * fabricates. It is what makes the shared-cache assertion below able to say
 * "this entry is *mine*" rather than "an entry appeared", which is the
 * difference between a real regression and a flake.
 */
const FILE_TOKEN = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// All fixture cache roots live under one owned temporary tree. Most cases
// reuse its root; memo-isolation cases create distinct children.
const FILE_CACHE_ROOT = await fs.mkdtemp(
  path.join(os.tmpdir(), `gcc-extern-cache-${FILE_TOKEN}-`),
);
const testCacheRoot = { cacheRoot: FILE_CACHE_ROOT };

async function makeDistinctCacheRoot() {
  return {
    cacheRoot: await fs.mkdtemp(path.join(FILE_CACHE_ROOT, "alt-")),
  };
}

const SHARED_CACHE_DIR = path.join(
  getDefaultPersistentCacheRoot(),
  "platform-externs",
);

async function listSharedCacheEntries() {
  try {
    return (await fs.readdir(SHARED_CACHE_DIR)).sort();
  } catch {
    return [];
  }
}

afterAll(async () => {
  const ownedSharedEntries = (await listSharedCacheEntries()).filter((entry) =>
    entry.includes(FILE_TOKEN),
  );
  await Promise.all([
    fs.rm(FILE_CACHE_ROOT, { force: true, recursive: true }),
    ...ownedSharedEntries.map((entry) =>
      fs.rm(path.join(SHARED_CACHE_DIR, entry), { force: true, recursive: true }),
    ),
  ]);
});

test("indexes typed declarations, owners, heritage, and overrides", async () => {
  const archive = await loadPlatformExternArchive(testCacheRoot);
  expect(archive).not.toBeNull();
  const index = await getPlatformExternIndex(archive, testCacheRoot);

  const canvas = index.unitsByName.get("HTMLCanvasElement")?.[0];
  expect(canvas?.text).toContain("@constructor");
  expect(canvas?.heritage).toContain("HTMLElement");

  const addEventListener = index.unitsByProperty
    .get("addEventListener")
    ?.find((unit) => unit.owner === "Node");
  expect(addEventListener?.override).toBe(true);
  expect(addEventListener?.names).toContain("Node.prototype.addEventListener");

  const streamValues = index.unitsByProperty
    .get("values")
    ?.find((unit) => unit.owner === "ReadableStream");
  expect(streamValues?.dependencies).not.toContain("VALUE");
});

test("emits a deterministic typed dependency-closed browser slice", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  const support = path.join(directory, "package.json");
  try {
    await fs.writeFile(
      input,
      "const canvas = new HTMLCanvasElement();\ncanvas.captureStream();\n",
    );
    await fs.writeFile(
      support,
      JSON.stringify({ browser: "./input.js", name: "platform-test" }),
    );
    const cache = testCacheRoot;
    const first = await generatePlatformExternsText([input], [], cache);
    const second = await generatePlatformExternsText([input, support], [], cache);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first).toContain("function HTMLCanvasElement()");
    expect(first).toContain("@extends {HTMLElement}");
    expect(first).toContain("HTMLCanvasElement.prototype.captureStream");
    expect(first).toContain("@return {!MediaStream}");
    expect(first).toContain("function MediaStream(");
    expect(first).not.toContain("Object.prototype.captureStream");
    expect(first).not.toContain("function IDBDatabase()");
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("caches indexes by compiler jar hash", async () => {
  const archive = await loadPlatformExternArchive(testCacheRoot);
  expect(archive).not.toBeNull();

  const first = await getPlatformExternIndex(archive, testCacheRoot);
  const sameHash = await getPlatformExternIndex(
    { entries: archive.entries, jarHash: archive.jarHash },
    testCacheRoot,
  );
  const changedHash = await getPlatformExternIndex(
    {
      entries: archive.entries,
      jarHash: `${archive.jarHash}-changed-${FILE_TOKEN}`,
    },
    testCacheRoot,
  );

  expect(sameHash).toBe(first);
  expect(changedHash).not.toBe(first);

  // Two roots are two caches: the memo must not hand one root's entry to the
  // other, or test isolation would be cosmetic.
  const otherRoot = await getPlatformExternIndex(
    archive,
    await makeDistinctCacheRoot(),
  );
  expect(otherRoot).not.toBe(first);
});

// Attribute writes to this fixture's token, never to unrelated machine-cache
// entries that another test, process, or previous invocation may have created.
test("test runs never write the machine-shared extern cache", async () => {
  const archive = await loadPlatformExternArchive(testCacheRoot);
  expect(archive).not.toBeNull();
  const jarHash = `${archive.jarHash}-changed-${FILE_TOKEN}`;
  await getPlatformExternIndex(
    { entries: archive.entries, jarHash },
    testCacheRoot,
  );
  await generatePlatformExternsText([], [], testCacheRoot);

  const written = await fs.readdir(
    path.join(FILE_CACHE_ROOT, "platform-externs"),
  );
  expect(written).toContain(
    `units.${platformExternParserDigest()}.${jarHash}.json.gz`,
  );
  const sharedEntries = await listSharedCacheEntries();
  expect(sharedEntries.filter((entry) => entry.includes(FILE_TOKEN))).toEqual([]);
});

/**
 * Cache identity has to follow the parser, not a constant somebody remembers
 * to bump: a stale payload yields a wrong slice whose failure mode is an
 * invisible full-externs recompile.
 */
test("cache identity is derived from the parser, and entries land in the given root", async () => {
  const archive = await loadPlatformExternArchive(testCacheRoot);
  expect(archive).not.toBeNull();

  const digest = platformExternParserDigest();
  expect(digest).toMatch(/^[0-9a-f]{16}$/u);
  expect(platformExternParserDigest()).toBe(digest);

  await getPlatformExternIndex(archive, testCacheRoot);
  const written = await fs.readdir(
    path.join(testCacheRoot.cacheRoot, "platform-externs"),
  );
  expect(written).toContain(`units.${digest}.${archive.jarHash}.json.gz`);
  // The manual version constant is gone from the file name entirely.
  expect(written.some((entry) => entry.startsWith("units.v"))).toBe(false);
});

/**
 * The memo used to be a single process-wide promise, so it captured whichever
 * root reached it first and silently discarded every later one — passing a
 * cache root was no guarantee of using it, and isolation depended on call
 * order. Keyed by root, two roots are two archives.
 */
test("the archive memo honours each cache root instead of the first caller's", async () => {
  const first = await makeDistinctCacheRoot();
  const second = await makeDistinctCacheRoot();

  expect(await loadPlatformExternArchive(first)).not.toBeNull();
  expect(await loadPlatformExternArchive(second)).not.toBeNull();

  // Each root records the jar identity for itself. Under the old memo the
  // second root stayed empty, because the first caller's promise was reused.
  for (const root of [first, second]) {
    expect(await fs.readdir(path.join(root.cacheRoot, "platform-externs"))).toContain(
      "archive-id.json",
    );
  }
});

test("rejects corrupt compiler archives for safe full-extern fallback", () => {
  expect(readPlatformExternArchive(Buffer.from("not a zip"))).toBeNull();
});

test("the generated slice passes Closure type validation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  const externs = path.join(directory, "platform.externs.js");
  const output = path.join(directory, "output.js");
  try {
    await fs.writeFile(
      input,
      [
        "const url = new URL('https://example.com');",
        "fetch(url).then((response) => response.text());",
        "const worker = new Worker(url);",
        "window.addEventListener('message', (event) => console.log(event.data), false);",
        "void worker;",
        "",
      ].join("\n"),
    );
    const text = await generatePlatformExternsText(
      [input],
      [],
      testCacheRoot,
    );
    expect(text).not.toBeNull();
    await fs.writeFile(externs, text);

    const compilerJar = resolvePlatformExternCompilerJarPath();
    expect(compilerJar).not.toBeNull();
    if (!compilerJar) throw new Error("Closure compiler jar is unavailable");
    const process = Bun.spawn([
      "java",
      "-jar",
      compilerJar,
      "--compilation_level",
      "ADVANCED",
      "--env",
      "CUSTOM",
      "--warning_level",
      "VERBOSE",
      "--jscomp_error",
      "checkTypes",
      "--externs",
      externs,
      "--js",
      input,
      "--js_output_file",
      output,
    ]);
    const stderr = await new Response(process.stderr).text();
    expect(await process.exited, stderr).toBe(0);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}, 30_000);

/**
 * Regression lock for a silent miscompile: `platformExterns: "minimal"` used to
 * rename `window.setTimeout`.
 *
 * Closure's browser externs declare the timer/frame functions as *bare globals*
 * (`function setTimeout(…){}`), not as `Window.prototype` members, so they live
 * in `globalNames` and are absent from `propertyNames`. The seed collector
 * matched a property access only against `propertyNames`, so `window.setTimeout(…)`
 * seeded nothing, the declaration never entered the slice, and Closure renamed
 * it — breaking every `window.<globalFn>()` call in any program.
 *
 * Both seeding paths are covered here because they are separate branches in
 * `collectPlatformExternSeeds`: property access (`window.setTimeout`) and
 * string element access (`window["requestAnimationFrame"]`).
 */
test("bare Window data properties get global aliases", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  try {
    await fs.writeFile(
      input,
      "void pageXOffset; void pageYOffset; void open;\n",
    );
    const text = await generatePlatformExternsText(
      [input],
      [],
      testCacheRoot,
    );
    expect(text).not.toBeNull();
    expect(text).toContain("Window.prototype.pageXOffset;");
    expect(text).toContain("Window.prototype.pageYOffset;");
    expect(text).toContain("var pageXOffset;");
    expect(text).toContain("var pageYOffset;");
    expect(text).not.toContain("var open;");
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("bare-global names seed through property and element access", async () => {
  const archive = await loadPlatformExternArchive(testCacheRoot);
  expect(archive).not.toBeNull();
  const index = await getPlatformExternIndex(archive, testCacheRoot);

  // The classification that made the bug possible. If Closure ever moves these
  // onto `Window.prototype`, this test stops proving anything and should be
  // revisited rather than deleted.
  for (const name of ["setTimeout", "requestAnimationFrame"]) {
    expect(index.globalNames.has(name)).toBe(true);
    expect(index.propertyNames.has(name)).toBe(false);
  }
  // Control: declared BOTH ways, so it was always reachable through the
  // property path alone and never exercised the regression.
  expect(index.globalNames.has("getComputedStyle")).toBe(true);
  expect(index.propertyNames.has("getComputedStyle")).toBe(true);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  try {
    await fs.writeFile(
      input,
      [
        // property access -> bare global
        "window.setTimeout(function () {}, 0);",
        // string element access -> bare global
        "window['requestAnimationFrame'](function () {});",
        // both-forms control
        "window.getComputedStyle(document.body).display;",
        "",
      ].join("\n"),
    );

    const text = await generatePlatformExternsText(
      [input],
      [],
      testCacheRoot,
    );
    expect(text).not.toBeNull();

    expect(text).toContain("function setTimeout(");
    expect(text).toContain("function requestAnimationFrame(");
    expect(text).toContain("function getComputedStyle(");

    // The slice must still be a slice: a sibling bare global the program never
    // mentions stays out, so these assertions cannot pass by including
    // everything.
    expect(text).not.toContain("function setInterval(");
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

/**
 * TypeScript's JSDoc parser recurses per type token. `transpileModule` (the
 * old path) overflowed the stack on a comment this deep and the whole
 * platform-extern slice fell back to full browser externs. The seed scan
 * only walks identifiers and property names, so JSDoc parsing is off; this
 * input must still produce a slice.
 */
test("parses dense JSDoc comments that overflow transpileModule", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  try {
    const nested = `{${"{a:".repeat(5000)}number${"}".repeat(5000)}}`;
    await fs.writeFile(
      input,
      `/** @type ${nested} */\nconst canvas = new HTMLCanvasElement();\ncanvas.captureStream();\n`,
    );
    const text = await generatePlatformExternsText([input], [], testCacheRoot);
    expect(text).not.toBeNull();
    expect(text).toContain("function HTMLCanvasElement()");
    expect(text).toContain("HTMLCanvasElement.prototype.captureStream");
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("unparseable program files still fail closed to a null slice", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-platform-"));
  const input = path.join(directory, "input.js");
  try {
    await fs.writeFile(
      input,
      `var x = ${"(".repeat(5000)}1${")".repeat(5000)};\n`,
    );
    expect(await generatePlatformExternsText([input], [], testCacheRoot)).toBe(
      null,
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
