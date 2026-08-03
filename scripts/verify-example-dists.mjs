import { createHash } from "node:crypto";
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
const bun = process.env.GCC_BUN_BIN ?? (await provisionReleasedBun());
const examples = [
  "jquery-vite-official",
  "lit-vite-official",
  "react-vite-official",
  "svelte-vite-official",
  "vue-vapor-vite-official",
];
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gcc-example-dists-"));

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

async function provisionReleasedBun() {
  const archiveName = bunArchiveName();
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
  if (releasedBunMatches(binaryPath)) {
    return binaryPath;
  }

  await mkdir(cacheRoot, { recursive: true });
  const releaseRoot = `https://github.com/oven-sh/bun/releases/download/bun-v${requiredBunVersion}`;
  const sumsPath = path.join(cacheRoot, "SHASUMS256.txt");
  const archivePath = path.join(cacheRoot, archiveName);
  const sums = await download(`${releaseRoot}/SHASUMS256.txt`, sumsPath);
  const expectedHash = parseExpectedHash(sums, archiveName);
  let archive = await readFile(archivePath).catch(() => null);
  if (!archive || sha256(archive) !== expectedHash) {
    archive = await download(`${releaseRoot}/${archiveName}`, archivePath);
  }
  const actualHash = sha256(archive);
  if (actualHash !== expectedHash) {
    throw new Error(
      `Bun ${requiredBunVersion} archive checksum mismatch for ${archiveName}: expected ${expectedHash}, received ${actualHash}`,
    );
  }

  await rm(extractedDir, { force: true, recursive: true });
  if (process.platform === "win32") {
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${cacheRoot.replaceAll("'", "''")}' -Force`,
      ],
      root,
    );
  } else {
    run("unzip", ["-q", archivePath, "-d", cacheRoot], root);
    await chmod(binaryPath, 0o755);
  }
  if (!releasedBunMatches(binaryPath)) {
    throw new Error(
      `Provisioned Bun binary does not report required version ${requiredBunVersion}: ${binaryPath}`,
    );
  }
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

function releasedBunMatches(binaryPath) {
  try {
    return (
      run(binaryPath, ["--version"], root, { capture: true }).trim() ===
      requiredBunVersion
    );
  } catch {
    return false;
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
