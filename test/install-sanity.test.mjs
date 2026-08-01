import { expect, onTestFinished, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("example installs never materialize a recursive gcc-ts-bundler copy", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "check-install-sanity.mjs")],
    { encoding: "utf8" },
  );
  expect(output).toContain("Install sanity check passed.");
});

test("TypeScript launcher rejects a same-version package with the wrong name", async () => {
  const result = await runTypeScriptLauncher({
    bin: { tsc: "./bin/tsc" },
    name: "typescript-lookalike",
    version: "7.0.2",
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Expected official typescript package");
});

test("TypeScript launcher rejects a same-version alternate bin target", async () => {
  const result = await runTypeScriptLauncher({
    bin: { tsc: "../../fake-tsc.mjs" },
    name: "typescript",
    version: "7.0.2",
  });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("must expose only tsc at ./bin/tsc");
});

async function runTypeScriptLauncher(packageJson) {
  const fixtureRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "gcc-typescript-launcher-"),
  );
  onTestFinished(() => fs.rm(fixtureRoot, { force: true, recursive: true }));
  const scriptDir = path.join(fixtureRoot, "scripts");
  const typescriptDir = path.join(fixtureRoot, "node_modules", "typescript");
  await fs.mkdir(path.join(typescriptDir, "bin"), { recursive: true });
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "scripts", "run-typescript.mjs"),
    path.join(scriptDir, "run-typescript.mjs"),
  );
  await fs.writeFile(
    path.join(typescriptDir, "package.json"),
    JSON.stringify(packageJson),
  );
  await fs.writeFile(
    path.join(typescriptDir, "bin", "tsc"),
    "process.exitCode = 0;\n",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "fake-tsc.mjs"),
    "process.exitCode = 0;\n",
  );

  return spawnSync(
    process.execPath,
    [path.join(scriptDir, "run-typescript.mjs"), "--version"],
    { encoding: "utf8" },
  );
}
