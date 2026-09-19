import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "bun:test";

import { build } from "../../dist/index.mjs";
import { compilePreparedClosureJobs } from "../../src/build/closure/compile-jobs/index.ts";
import { collectExpiredEntries } from "../../src/build/closure/platform-externs/parser/slice.ts";
import { createFixture, execFileAsync } from "../helpers.mjs";

const BUILD_TIMEOUT = 120_000;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function compilerJob(input, output, extra = {}) {
  return {
    assumeFunctionWrapper: false,
    compilationLevel: "ADVANCED",
    externs: [],
    js: [input],
    jsOutputFile: output,
    languageIn: "ECMASCRIPT_NEXT",
    languageOut: "ECMASCRIPT_NEXT",
    rewritePolyfills: false,
    warningLevel: "QUIET",
    hasTypeMetadata: false,
    typeMetadataCounts: {
      annotationCount: 0,
      memberAnnotationCount: 0,
      typeDeclarationCount: 0,
      enumDeclarationCount: 0,
      unresolvedTypeReferenceCount: 0,
    },
    ...extra,
  };
}

async function compile(fixture, job, target) {
  return compilePreparedClosureJobs({
    closureCompilerEnvironment: { options: {}, typeInferenceDisabled: false },
    platformExterns: "minimal",
    target,
    packageRoot,
    projectRoot: fixture.projectRoot,
    projectCacheDir: path.join(fixture.projectRoot, "cache"),
    prepared: { compileJobs: [job], generatedAssets: [], postprocessActions: [], publishedOutputs: [] },
    usesPersistentCache: false,
  });
}

test.serial("terminal compiler diagnostics reach the public failure result", { timeout: BUILD_TIMEOUT }, async () => {
  const fixture = await createFixture();
  await fixture.write("src/index.ts", "export const value = 1;\n");
  const previous = process.env.GCC_CLOSURE_EXTRA_FLAGS;
  process.env.GCC_CLOSURE_EXTRA_FLAGS = "--definitely_not_a_real_flag";
  try {
    const result = await build({
      cache: { mode: "off" },
      entries: ["./index.ts"],
      packages: "off",
      projectRoot: fixture.projectRoot,
      srcDir: fixture.srcDir,
      outDir: fixture.outDir,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.message).join("\n")).toContain("definitely_not_a_real_flag");
  } finally {
    if (previous === undefined) delete process.env.GCC_CLOSURE_EXTRA_FLAGS;
    else process.env.GCC_CLOSURE_EXTRA_FLAGS = previous;
  }
});

test.serial("Node jobs cannot recover an undefined browser global by changing environments", { timeout: BUILD_TIMEOUT }, async () => {
  const fixture = await createFixture();
  await fixture.write("input.js", 'window.alert("not a Node global");\n');
  const [result] = await compile(fixture, compilerJob(
    path.join(fixture.projectRoot, "input.js"),
    path.join(fixture.projectRoot, "output.js"),
  ), "node");
  expect(result.exitCode).not.toBe(0);
  expect(result.diagnostics.join("\n")).toContain("JSC_UNDEFINED_VARIABLE");
  expect(result.diagnostics.join("\n")).toContain("window");
});

test.serial("browser recovery retains authored externs and discards the failed attempt's diagnostics", { timeout: BUILD_TIMEOUT }, async () => {
  const fixture = await createFixture();
  await fixture.write("input.js", "APP.value = window.innerWidth;\n");
  await fixture.write("platform-externs.authored.js", "/** @externs */\nvar APP = {};\nAPP.value;\n");
  await fixture.write("slice.js", "/** @externs */\n");
  const slice = path.join(fixture.projectRoot, "slice.js");
  const output = path.join(fixture.projectRoot, "output.js");
  const [result] = await compile(fixture, compilerJob(
    path.join(fixture.projectRoot, "input.js"), output,
    { env: "CUSTOM", browserExternSlice: slice, externs: [path.join(fixture.projectRoot, "platform-externs.authored.js"), slice] },
  ), "browser");
  expect(result.exitCode).toBe(0);
  expect(result.diagnostics).toEqual([]);
  expect(await fs.readFile(output, "utf8")).toContain("APP.value");
});

test("expiry awaits deletion in each independent root and preserves live entries", async () => {
  const fixture = await createFixture();
  const roots = ["shared", "project-a", "project-b"].map((name) => path.join(fixture.projectRoot, name));
  const old = new Date(Date.now() - 60_000);
  for (const root of roots) {
    const directory = path.join(root, "platform-externs");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "slice.old.json.gz"), "old");
    await fs.writeFile(path.join(directory, "units.live.json.gz"), "live");
    await fs.utimes(path.join(directory, "slice.old.json.gz"), old, old);
  }
  for (const root of roots) {
    expect(await collectExpiredEntries(root, 30_000)).toBe(1);
    expect(await fs.readdir(path.join(root, "platform-externs"))).toEqual(["units.live.json.gz"]);
  }
});

test.serial("resident failure waits for delayed child termination before returning fallback capability", { timeout: BUILD_TIMEOUT }, async () => {
  if (process.platform === "win32") return;
  const fixture = await createFixture();
  const worker = path.join(fixture.projectRoot, "worker.mjs");
  const marker = path.join(fixture.projectRoot, "closed");
  await fs.writeFile(worker, `#!${process.execPath}\nimport fs from "node:fs";
process.stdout.write(JSON.stringify({ ready: true }) + "\\0");
let calls = 0;
process.stdin.on("data", (chunk) => {
  if (!chunk.includes(0)) return;
  calls++;
  if (calls < 3) process.stdout.write(JSON.stringify({ exitCode: 0, stdout: String(process.pid), stderr: "" }) + "\\0");
  else process.stdout.write("malformed\\0");
});
process.once("SIGTERM", () => {
  setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, "closed"); process.exit(0); }, 80);
});
`);
  await fs.chmod(worker, 0o700);
  const probeUrl = pathToFileURL(path.join(packageRoot, "src/build/closure/driver/probe.ts")).href;
  const residentUrl = pathToFileURL(path.join(packageRoot, "src/build/closure/driver/resident.ts")).href;
  const runner = path.join(fixture.projectRoot, "runner.mjs");
  await fs.writeFile(runner, `import { mock } from "bun:test";
import fs from "node:fs";
mock.module(${JSON.stringify(probeUrl)}, () => ({ probeClosureDriver: async () => ({ ok: true, kind: "jar-worker", javaPath: ${JSON.stringify(worker)}, jarPath: "unused", classesDir: "unused" }) }));
const { runResidentClosureJob } = await import(${JSON.stringify(residentUrl)});
const first = await runResidentClosureJob([]);
const second = await runResidentClosureJob([]);
const failed = await runResidentClosureJob([]);
console.log(JSON.stringify({ reused: first.stdout === second.stdout, fallback: failed === undefined, closed: fs.existsSync(${JSON.stringify(marker)}) }));
`);
  const { stdout } = await execFileAsync(process.execPath, [runner], { timeout: 10_000 });
  expect(JSON.parse(stdout.trim())).toEqual({ reused: true, fallback: true, closed: true });
});
