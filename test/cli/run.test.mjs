import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

import {
  createFixture,
  execFileAsync,
  getProjectCacheDir,
} from "../helpers.mjs";

const cliPath = fileURLToPath(
  new URL("../../src/cli/main.ts", import.meta.url),
);

async function runCliProcess(args) {
  try {
    const result = await execFileAsync(process.execPath, [
      "--bun",
      cliPath,
      ...args,
    ]);
    return { code: 0, ...result };
  } catch (error) {
    if (typeof error.code !== "number" || error.signal) {
      throw error;
    }
    return { code: error.code, stderr: error.stderr, stdout: error.stdout };
  }
}

test("malformed commands and parser errors produce one diagnostic and exit 1", async () => {
  for (const args of [
    ["buid"],
    ["build", "--unknown-flag"],
    ["externs", "--module"],
  ]) {
    const result = await runCliProcess(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toContain("gcc-ts-bundler:");
  }
});

test("extern generation failures reach the same controlled CLI boundary", async () => {
  const fixture = await createFixture();
  await fixture.write(
    "src/index.ts",
    'import { value } from "missing-fixture-dependency";\nconsole.log(value);\n',
  );
  const result = await runCliProcess([
    "externs",
    "--project-root",
    fixture.projectRoot,
    "--entry",
    path.join(fixture.srcDir, "index.ts"),
    "--module",
    "missing-fixture-dependency",
  ]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("missing-fixture-dependency");
});

test("clean-cache rejects irrelevant flags before deletion and scopes valid deletion", async () => {
  const fixture = await createFixture();
  const cacheDir = path.join(fixture.projectRoot, "custom-cache");
  const projectCacheDir = getProjectCacheDir(cacheDir, fixture.projectRoot);
  const marker = path.join(projectCacheDir, "retained.txt");
  const siblingMarker = path.join(
    getProjectCacheDir(
      cacheDir,
      path.join(fixture.projectRoot, "other-project"),
    ),
    "retained.txt",
  );
  await fs.mkdir(projectCacheDir, { recursive: true });
  await fs.writeFile(marker, "project cache");
  await fs.mkdir(path.dirname(siblingMarker), { recursive: true });
  await fs.writeFile(siblingMarker, "other project cache");
  const args = [
    "clean-cache",
    "--project-root",
    fixture.projectRoot,
    "--cache-dir",
    "custom-cache",
  ];

  for (const irrelevant of [
    ["--entry", "./main.ts"],
    ["--cache-mode", "off"],
    ["--out-dir", "dist"],
  ]) {
    const rejected = await runCliProcess([...args, ...irrelevant]);
    expect(rejected.code).toBe(1);
    expect(await fs.readFile(marker, "utf8")).toBe("project cache");
  }

  expect((await runCliProcess([...args, "--help"])).code).toBe(0);
  expect(await fs.readFile(marker, "utf8")).toBe("project cache");
  const cleaned = await runCliProcess(args);
  expect(cleaned).toEqual({ code: 0, stderr: "", stdout: "" });
  await expect(fs.stat(projectCacheDir)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await fs.readFile(siblingMarker, "utf8")).toBe("other project cache");
});

test("cache operation errors are reported without an unhandled rejection", async () => {
  const fixture = await createFixture();
  await fixture.write("not-a-directory", "retained");
  const result = await runCliProcess([
    "clean-cache",
    "--project-root",
    fixture.projectRoot,
    "--cache-dir",
    "not-a-directory",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr.trim().split("\n")).toHaveLength(1);
  expect(result.stderr).toContain("gcc-ts-bundler:");
  expect(await fixture.read("not-a-directory")).toBe("retained");
});

test.serial(
  "implicit and explicit build both publish runnable output",
  { timeout: 60_000 },
  async () => {
    const fixture = await createFixture();
    await fixture.write("src/index.ts", 'console.log("cli-build-ok");\n');
    const args = [
      "--project-root",
      fixture.projectRoot,
      "--entry",
      "./index.ts",
      "--cache-mode",
      "off",
    ];
    for (const command of [[], ["build"]]) {
      const result = await runCliProcess([...command, ...args]);
      expect(result.code).toBe(0);
      const executed = await execFileAsync(process.execPath, [
        path.join(fixture.outDir, "index.js"),
      ]);
      expect(executed.stdout.trim()).toBe("cli-build-ok");
      await fs.rm(fixture.outDir, { recursive: true });
    }
  },
);

test("build failures return exit 1 with their diagnostic", async () => {
  const fixture = await createFixture();
  const result = await runCliProcess([
    "build",
    "--project-root",
    fixture.projectRoot,
    "--entry",
    "./missing-entry.ts",
    "--cache-mode",
    "off",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("missing-entry.ts");
  expect(result.stderr).not.toMatch(/\n\s+at /);
});
