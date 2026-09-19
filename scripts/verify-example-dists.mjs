import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bun = "bun";
const examples = [
  "jquery-vite-official",
  "lit-vite-official",
  "react-vite-official",
  "svelte-vite-official",
  "vue-vapor-vite-official",
];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-example-dists-"));
// Lit is the authored-dominant canary: committed plugin output must beat
// committed stock Vite output (dist-pure/) by this much JavaScript gzip.
// jQuery and app-shaped examples report savings without a performance floor.
const exampleGzipFloorPct = {
  "lit-vite-official": 8,
};

try {
  const version = run(bun, ["--version"], root, { capture: true }).trim();
  console.log(`Verifying example distributions with system Bun ${version}.`);

  if (process.env.GCC_VERIFY_EXISTING_PACKAGE !== "1") {
    run(bun, ["run", "build"], root);
  }
  // The examples intentionally declare link:gcc-ts-bundler. Register only this
  // package; dependency resolution remains entirely from each frozen lockfile.
  run(bun, ["link"], root);

  for (const example of examples) {
    const source = path.join(root, "examples", example);
    const fixture = path.join(temporaryRoot, example);
    await cp(source, fixture, {
      filter(sourcePath) {
        return ![
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
  await assertExampleSizeFloors();
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function assertExampleSizeFloors() {
  for (const example of examples) {
    const exampleRoot = path.join(root, "examples", example);
    const plugin = await gzipJsBytes(path.join(exampleRoot, "dist"));
    const stock = await gzipJsBytes(path.join(exampleRoot, "dist-pure"));
    const winPct = ((stock - plugin) / stock) * 100;
    const floor = exampleGzipFloorPct[example];
    console.log(
      `${example}: js gzip ${plugin} vs stock ${stock} (win ${winPct.toFixed(1)}%${floor === undefined ? "" : `, floor ${floor}%`})`,
    );
    if (floor !== undefined && winPct < floor) {
      throw new Error(
        `${example} gzip win ${winPct.toFixed(1)}% fell below the ${floor}% floor; the authored-dominant thesis gate failed`,
      );
    }
  }
}

async function gzipJsBytes(rootDir) {
  const files = await listFiles(rootDir);
  let total = 0;
  for (const filePath of files) {
    if (!filePath.endsWith(".js")) continue;
    total += gzipSync(await readFile(filePath), { level: 9 }).length;
  }
  return total;
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
