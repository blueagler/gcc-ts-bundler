import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCommand } from "./command.mjs";
import {
  hostNativeTarget,
  nativeTargets,
  validateNativePackage,
} from "./native-targets.mjs";
import { packPackage } from "./npm-command.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function assertPreparedArtifact(artifact) {
  const digest = createHash("sha256")
    .update(await readFile(artifact.path))
    .digest("hex");
  if (digest !== artifact.sha256)
    throw new Error(`Prepared package changed after packing: ${artifact.path}`);
}

export async function prepareRelease({ allNative = false } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  if (
    process.env.GITHUB_EVENT_NAME === "release" &&
    process.env.GITHUB_REF_NAME !== `v${manifest.version}`
  ) {
    throw new Error(`Release tag must be v${manifest.version}`);
  }
  const host = hostNativeTarget();
  const targets = allNative ? Object.values(nativeTargets) : [host];
  // Reject incomplete/coherently mis-versioned release input before building.
  for (const target of targets) {
    if (
      manifest.optionalDependencies?.[target.packageName] !== manifest.version
    )
      throw new Error(
        `Coordinated release requires ${target.packageName}@${manifest.version}`,
      );
    if (allNative)
      validateNativePackage(
        JSON.parse(
          await readFile(
            path.join(root, "npm", target.packageName, "package.json"),
            "utf8",
          ),
        ),
        target,
        manifest,
      );
  }
  await runCommand(process.execPath, ["./scripts/check-install-sanity.mjs"], {
    cwd: root,
  });
  await runCommand(
    "cargo",
    ["fmt", "--manifest-path", "native/Cargo.toml", "--", "--check"],
    { cwd: root },
  );
  await runCommand(
    "cargo",
    [
      "clippy",
      "--manifest-path",
      "native/Cargo.toml",
      "--all-targets",
      "--all-features",
      "--",
      "-D",
      "warnings",
    ],
    { cwd: root },
  );
  await runCommand(
    process.execPath,
    [
      "./scripts/build-self.mjs",
      ...(allNative
        ? ["--native-package", path.join(root, "npm", host.packageName)]
        : []),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        GCC_SELFBUILD_STAGES: "2",
        GCC_SELFBUILD_CACHE: "off",
      },
    },
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "gcc-release-"));
  try {
    // Selfbuild has finished all checkout writes. Each job now reads immutable
    // input and owns a unique archive and (for natives) extraction directory.
    const packingTargets = [null, ...targets];
    const packed = [];
    for (let offset = 0; offset < packingTargets.length; offset += 2) {
      const results = await Promise.allSettled(
        packingTargets.slice(offset, offset + 2).map(async (target) => {
          if (!target)
            return record(await packPackage(root, directory), manifest.name);
          const nativeDirectory = path.join(root, "npm", target.packageName);
          validateNativePackage(
            JSON.parse(
              await readFile(path.join(nativeDirectory, "package.json"), "utf8"),
            ),
            target,
            manifest,
          );
          const artifact = await record(
            await packPackage(nativeDirectory, directory),
            target.packageName,
          );
          const extracted = path.join(directory, target.key);
          await mkdir(extracted);
          await runCommand(
            "tar",
            ["-xzf", artifact.path, "-C", extracted, "--strip-components=1"],
            { cwd: root },
          );
          validateNativePackage(
            JSON.parse(
              await readFile(path.join(extracted, "package.json"), "utf8"),
            ),
            target,
            manifest,
          );
          const addon = await lstat(path.join(extracted, "index.node"));
          if (!addon.isFile() || addon.size === 0)
            throw new Error(`Missing packed native addon for ${target.key}`);
          return artifact;
        }),
      );
      // Drain the entire bounded batch before failure can remove its files.
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of results) packed.push(result.value);
    }
    const [rootArtifact, ...artifacts] = packed;
    // Publication order follows the target manifest, never completion order.
    artifacts.push(rootArtifact);
    const hostArtifact = artifacts.find(
      (artifact) => artifact.name === host.packageName,
    );
    await runCommand(
      process.execPath,
      [
        "./scripts/verify-package.mjs",
        "--archive",
        rootArtifact.path,
        "--native-archive",
        hostArtifact.path,
      ],
      { cwd: root },
    );
    for (const artifact of artifacts) await assertPreparedArtifact(artifact);
    return { directory, artifacts };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function record(archivePath, name) {
  const sha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  await chmod(archivePath, 0o444);
  return { name, path: archivePath, sha256 };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--all-native"))
    throw new Error("Usage: prepare-release.mjs [--all-native]");
  const prepared = await prepareRelease({
    allNative: args[0] === "--all-native",
  });
  console.log(`Verified release artifacts: ${prepared.directory}`);
}
