import { expect, onTestFinished, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-install-sanity-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(
    new URL("../../scripts/check-install-sanity.mjs", import.meta.url),
    path.join(root, "scripts/check-install-sanity.mjs"),
  );
  const example = path.join(root, "examples", "app");
  await fs.mkdir(example, { recursive: true });
  const run = () =>
    spawnSync(
      process.execPath,
      [path.join(root, "scripts/check-install-sanity.mjs")],
      { encoding: "utf8" },
    );
  return { root, example, run };
}

test("install guard rejects file references before recursive materialization", async () => {
  const { example, run } = await fixture();
  await fs.writeFile(
    path.join(example, "package.json"),
    JSON.stringify({ dependencies: { "gcc-ts-bundler": "file:../.." } }),
  );
  expect(run().status).not.toBe(0);
});

test("install guard rejects a materialized repository but permits an untraversed link", async () => {
  const { root, example, run } = await fixture();
  const installed = path.join(example, "node_modules/gcc-ts-bundler");
  await fs.writeFile(
    path.join(example, "package.json"),
    JSON.stringify({ dependencies: { "gcc-ts-bundler": "link:../.." } }),
  );
  await fs.mkdir(path.join(installed, "examples"), { recursive: true });
  expect(run().status).not.toBe(0);
  await fs.rm(installed, { recursive: true });
  await fs.symlink(
    root,
    installed,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(run().status).toBe(0);
});
