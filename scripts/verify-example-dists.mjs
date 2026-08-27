import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredBunVersion = "1.3.14";
// In-repo trust anchor for every Bun archive this script is allowed to provision.
// The release's own SHASUMS256.txt travels with the archive it claims to
// authenticate over the same channel at the same moment, so it can only ever be
// a secondary cross-check -- never the trust decision.
// Provenance for bun-v1.3.14: each archive was downloaded and hashed locally,
// then matched against both the release SHASUMS256.txt and the GitHub REST API
// server-side asset digest metadata. All three agreed.
// Bumping requiredBunVersion REQUIRES replacing every digest below.
const pinnedBunArchiveDigests = {
  "bun-darwin-aarch64.zip":
    "d8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620",
  "bun-darwin-x64.zip":
    "4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633",
  "bun-linux-aarch64.zip":
    "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
  "bun-linux-x64.zip":
    "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
  "bun-windows-aarch64.zip":
    "89841f5a57f2348b67ec0839b718f4bf4ea7d07c371c9ba4b77b6c790f918953",
  "bun-windows-x64.zip":
    "0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922",
};
const bun = process.env.GCC_BUN_BIN ?? (await provisionReleasedBun());
const examples = [
  "jquery-vite-official",
  "lit-vite-official",
  "react-vite-official",
  "svelte-vite-official",
  "vue-vapor-vite-official",
];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-example-dists-"));
// The product thesis is authored-dominant wins ("Lit is the canary. The
// library is the prize."). These floors are kill criteria: committed plugin
// output must beat the committed stock Vite output (dist-pure/) by at least
// this much JavaScript gzip. App-shaped examples are reported, not gated.
const exampleGzipFloorPct = {
  "jquery-vite-official": 10,
  "lit-vite-official": 8,
};

try {
  const version = run(bun, ["--version"], root, { capture: true }).trim();
  if (version !== requiredBunVersion) {
    throw new Error(
      `verify:examples requires released Bun ${requiredBunVersion}; received ${version}`,
    );
  }

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

async function provisionReleasedBun() {
  const archiveName = bunArchiveName();
  const pinnedHash = pinnedArchiveDigest(archiveName);
  const cacheRoot = path.join(
    process.env.GCC_TOOL_CACHE_DIR ??
      process.env.XDG_CACHE_HOME ??
      path.join(os.homedir(), ".cache"),
    "gcc-ts-bundler",
    "tools",
    `bun-${requiredBunVersion}`,
  );
  const binaryName = process.platform === "win32" ? "bun.exe" : "bun";
  const extractedDir = path.join(cacheRoot, archiveName.replace(/\.zip$/u, ""));
  const binaryPath = path.join(extractedDir, binaryName);
  await mkdir(cacheRoot, { recursive: true });
  const releaseRoot = `https://github.com/oven-sh/bun/releases/download/bun-v${requiredBunVersion}`;
  const archivePath = path.join(cacheRoot, archiveName);

  let archive = await readFile(archivePath).catch(() => null);
  if (!archive || sha256(archive) !== pinnedHash) {
    if (archive) {
      await rm(archivePath, { force: true });
    }
    archive = await download(`${releaseRoot}/${archiveName}`, archivePath);
    const downloadedHash = sha256(archive);
    if (downloadedHash !== pinnedHash) {
      await rm(archivePath, { force: true });
      throw new Error(
        `Bun ${requiredBunVersion} archive checksum mismatch for ${archiveName}: expected ${pinnedHash}, received ${downloadedHash}`,
      );
    }
    await crossCheckPublishedSums(
      releaseRoot,
      path.join(cacheRoot, "SHASUMS256.txt"),
      archiveName,
      pinnedHash,
    );
  }

  const extractRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-bun-extract-"));
  try {
    if (process.platform === "win32") {
      run(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractRoot.replaceAll("'", "''")}' -Force`,
        ],
        root,
      );
    } else {
      run("unzip", ["-q", archivePath, "-d", extractRoot], root);
    }
    const stagedDir = path.join(extractRoot, archiveName.replace(/\.zip$/u, ""));
    await rm(extractedDir, { force: true, recursive: true });
    await cp(stagedDir, extractedDir, { recursive: true });
  } finally {
    await rm(extractRoot, { force: true, recursive: true });
  }
  if (process.platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }
  assertReleasedBunVersion(binaryPath);
  return binaryPath;
}

function bunArchiveName() {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : null;
  const architecture =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x64"
        : null;
  if (!platform || !architecture) {
    throw new Error(
      `No pinned Bun ${requiredBunVersion} archive for ${process.platform}-${process.arch}`,
    );
  }
  return `bun-${platform}-${architecture}.zip`;
}

function pinnedArchiveDigest(archiveName) {
  const digest = pinnedBunArchiveDigests[archiveName];
  if (!digest) {
    throw new Error(
      `No pinned SHA-256 for Bun ${requiredBunVersion} archive ${archiveName}; add its digest to pinnedBunArchiveDigests`,
    );
  }
  return digest;
}

function assertReleasedBunVersion(binaryPath) {
  const version = run(binaryPath, ["--version"], root, { capture: true }).trim();
  if (version !== requiredBunVersion) {
    throw new Error(
      `Provisioned Bun binary does not report required version ${requiredBunVersion}: ${binaryPath} reported ${version}`,
    );
  }
}

async function crossCheckPublishedSums(
  releaseRoot,
  sumsPath,
  archiveName,
  pinnedHash,
) {
  let sums;
  try {
    sums = await download(`${releaseRoot}/SHASUMS256.txt`, sumsPath);
  } catch {
    return;
  }
  const publishedHash = parseExpectedHash(sums, archiveName);
  if (publishedHash !== pinnedHash) {
    throw new Error(
      `Bun ${requiredBunVersion} published SHASUMS256.txt for ${archiveName} is ${publishedHash}, which disagrees with the in-repo pin ${pinnedHash}`,
    );
  }
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, contents);
  return contents;
}

function parseExpectedHash(sums, archiveName) {
  const line = sums
    .toString("utf8")
    .split(/\r?\n/u)
    .find((candidate) => candidate.trim().endsWith(archiveName));
  const hash = line?.trim().split(/\s+/u)[0];
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash)) {
    throw new Error(`Bun release checksums contain no SHA-256 for ${archiveName}`);
  }
  return hash;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
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
