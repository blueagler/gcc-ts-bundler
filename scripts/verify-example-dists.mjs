import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bun = process.env.GCC_BUN_BIN ?? "bun";
const requiredBunVersion = "1.3.14";
const examples = ["lit-vite-official", "react-vite-official"];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-example-dists-"));

try {
  const version = run(bun, ["--version"], root, { capture: true }).trim();
  if (version !== requiredBunVersion) {
    throw new Error(
      `verify:examples requires released Bun ${requiredBunVersion}; received ${version}`,
    );
  }

  run(bun, ["run", "build"], root);
  // The examples intentionally declare link:gcc-ts-bundler. Register only this
  // package; dependency resolution remains entirely from each frozen lockfile.
  run(bun, ["link"], root);

  for (const example of examples) {
    const source = path.join(root, "examples", example);
    const fixture = path.join(temporaryRoot, example);
    await cp(source, fixture, {
      filter(sourcePath) {
        return ![
          ".gcc-ts-bundler-vite",
          "dist",
          "dist-pure",
          "node_modules",
        ].includes(path.basename(sourcePath));
      },
      recursive: true,
    });
    run(bun, ["install", "--frozen-lockfile"], fixture);
    run(bun, ["run", "build"], fixture);

    const expected = await checksums(path.join(source, "dist"));
    const actual = await checksums(path.join(fixture, "dist"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `${example} fresh output differs from tracked dist:\n` +
          `${JSON.stringify({ actual, expected }, null, 2)}`,
      );
    }
    console.log(`Verified ${example} fresh dist byte-for-byte.`);
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function checksums(rootDir) {
  const files = await listFiles(rootDir);
  return await Promise.all(
    files.map(async (filePath) => {
      const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
      return [
        relativePath,
        createHash("sha256").update(await readFile(filePath)).digest("hex"),
      ];
    }),
  );
}

async function listFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      return entry.isDirectory() ? await listFiles(entryPath) : [entryPath];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout ?? "";
}
