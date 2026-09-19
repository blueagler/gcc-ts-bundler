import { expect, onTestFinished, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeTargets } from "../../scripts/native-targets.mjs";

async function fixture(mode = "success") {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "gcc-release-contract-"),
  );
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "tools"));
  await fs.writeFile(
    path.join(root, "tools/cargo"),
    `#!${process.execPath}\nprocess.exitCode = ["fmt", "clippy"].includes(process.argv[2]) ? (${JSON.stringify(mode)} === "rust-hygiene-failure" ? 19 : 0) : 88;\n`,
    { mode: 0o755 },
  );
  for (const script of [
    "prepare-release.mjs",
    "publish-npm.mjs",
    "command.mjs",
    "npm-command.mjs",
    "native-targets.mjs",
    "prepublish-guard.mjs",
  ]) {
    await fs.copyFile(
      new URL(`../../scripts/${script}`, import.meta.url),
      path.join(root, "scripts", script),
    );
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "gcc-ts-bundler",
      version: "1.2.3",
      type: "module",
      files: ["dist"],
      scripts: {
        prepack: "exit 91",
        prepare: "exit 91",
        postpack: "exit 91",
      },
      optionalDependencies: Object.fromEntries(
        Object.values(nativeTargets).map((target) => [
          target.packageName,
          "1.2.3",
        ]),
      ),
    }),
  );
  for (const target of Object.values(nativeTargets)) {
    const directory = path.join(root, "npm", target.packageName);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: target.packageName,
        version: "1.2.3",
        os: [target.platform],
        cpu: [target.arch],
        ...(target.libc
          ? { libc: [target.libc === "gnu" ? "glibc" : target.libc] }
          : {}),
        main: "index.node",
        files: ["index.node"],
        scripts: {
          prepack: "exit 91",
          prepare: "exit 91",
          postpack: "exit 91",
        },
      }),
    );
    await fs.writeFile(
      path.join(directory, "index.node"),
      `fixture native payload ${target.key}`,
    );
  }
  await fs.writeFile(
    path.join(root, "scripts/check-install-sanity.mjs"),
    `process.exitCode = ${mode === "hygiene-failure" ? 17 : 0};\n`,
  );
  await fs.writeFile(
    path.join(root, "scripts/build-self.mjs"),
    `
import fs from "node:fs/promises";
import assert from "node:assert/strict";
assert.equal(process.env.GCC_SELFBUILD_STAGES, "2");
assert.equal(process.env.GCC_SELFBUILD_CACHE, "off");
const count = Number(await fs.readFile("build-count", "utf8").catch(() => "0")) + 1;
await fs.writeFile("build-count", String(count));
await fs.mkdir("dist", { recursive: true });
await fs.writeFile("dist/index.mjs", "prepared build " + count);
`,
  );
  await fs.writeFile(
    path.join(root, "scripts/verify-package.mjs"),
    `
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const archive = process.argv[3];
assert.equal(execFileSync("tar", ["-xOf", archive, "package/dist/index.mjs"], { encoding: "utf8" }), "prepared build 1");
if (${JSON.stringify(mode)} === "verification-failure") process.exit(23);
await fs.writeFile("verified.json", JSON.stringify({ archive, sha256: createHash("sha256").update(await fs.readFile(archive)).digest("hex") }));
// Mutating the working tree after verification must not change the published payload.
await fs.writeFile("dist/index.mjs", "unverified working tree mutation");
if (${JSON.stringify(mode)} === "archive-mutation") {
  await fs.chmod(archive, 0o644);
  await fs.appendFile(archive, "tampered");
}
`,
  );
  const npm = path.join(root, "npm-cli.js");
  await fs.writeFile(
    npm,
    `
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
if (args[0] === "publish") {
  const archive = args[1];
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
  const receipt = { name: manifest.name, archive, sha256: createHash("sha256").update(await fs.readFile(archive)).digest("hex") };
  const file = path.join(root, args.includes("--dry-run") ? "dry-runs.jsonl" : "uploads.jsonl");
  await fs.appendFile(file, JSON.stringify(receipt) + "\\n");
} else throw new Error("Unexpected npm operation " + args[0]);
`,
  );
  return {
    root,
    run: (...args) =>
      spawnSync(
        process.execPath,
        [path.join(root, "scripts/publish-npm.mjs"), ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${path.join(root, "tools")}${path.delimiter}${process.env.PATH ?? ""}`,
            npm_execpath: npm,
            GITHUB_EVENT_NAME: "",
            GITHUB_REF_NAME: "",
            GCC_SELFBUILD_STAGES: "1",
            GCC_SELFBUILD_CACHE: "persistent",
          },
        },
      ),
  };
}

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

test("release publishes the exact verified archive without rebuilding or repacking the mutated tree", async () => {
  const { root, run } = await fixture();
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  const verified = JSON.parse(
    await fs.readFile(path.join(root, "verified.json"), "utf8"),
  );
  const uploads = (await fs.readFile(path.join(root, "uploads.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(uploads.map((entry) => entry.name).sort()).toEqual(
    [
      ...Object.values(nativeTargets).map((target) => target.packageName),
      "gcc-ts-bundler",
    ].sort(),
  );
  expect(uploads.at(-1).name).toBe("gcc-ts-bundler");
  expect(uploads.at(-1).archive).toBe(verified.archive);
  expect(uploads.at(-1).sha256).toBe(verified.sha256);
  expect(await fs.readFile(path.join(root, "build-count"), "utf8")).toBe("1");
  expect(await fs.readFile(path.join(root, "dist/index.mjs"), "utf8")).toBe(
    "unverified working tree mutation",
  );
  expect(await exists(path.dirname(verified.archive))).toBe(false);
});

for (const mode of [
  "hygiene-failure",
  "rust-hygiene-failure",
  "verification-failure",
  "archive-mutation",
]) {
  test(`${mode} prevents all platform and root publication`, async () => {
    const { root, run } = await fixture(mode);
    expect(run().status).not.toBe(0);
    expect(await exists(path.join(root, "uploads.jsonl"))).toBe(false);
    if (mode.endsWith("hygiene-failure"))
      expect(await exists(path.join(root, "build-count"))).toBe(false);
  });
}

test("dry run still prepares and verifies every package but never uploads", async () => {
  const { root, run } = await fixture();
  const result = run("--dry-run");
  expect(result.status, result.stderr).toBe(0);
  expect(await exists(path.join(root, "uploads.jsonl"))).toBe(false);
  const verified = JSON.parse(
    await fs.readFile(path.join(root, "verified.json"), "utf8"),
  );
  const dryRuns = (await fs.readFile(path.join(root, "dry-runs.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(dryRuns.at(-1).sha256).toBe(verified.sha256);
});

test("invalid publisher arguments and direct publication cannot bypass preparation", async () => {
  const { root, run } = await fixture();
  expect(run("--ignore-scripts").status).not.toBe(0);
  expect(await exists(path.join(root, "build-count"))).toBe(false);
  const guard = spawnSync(process.execPath, [
    path.join(root, "scripts/prepublish-guard.mjs"),
  ]);
  expect(guard.status).not.toBe(0);
  expect(await exists(path.join(root, "uploads.jsonl"))).toBe(false);
});
