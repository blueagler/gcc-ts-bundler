import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { hostNativeTarget, parseNativeTargets } from "./native-targets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(packageRoot, "native");
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const MUSL_ZIGBUILD_RUSTFLAG = "-C target-feature=-crt-static";
const MUSL_ZIGBUILD_RUSTFLAG_PATTERN =
  /(?:^|\s)(?:-C\s+target-feature=-crt-static|-Ctarget-feature=-crt-static|--codegen\s+target-feature=-crt-static|--codegen=target-feature=-crt-static)(?=\s|$)/gu;
let hostTarget;

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

function main() {
  const { targets, skipRootCopy: sharedSkipRootCopy } = parseNativeTargets(
    process.argv.slice(2),
  );
  hostTarget = hostNativeTarget();
  ensureCargoSubcommands(targets);
  const installedTargets = readInstalledRustTargets();
  for (const target of targets) {
    if (target.targetTriple && !installedTargets.has(target.targetTriple)) {
      throw new Error(
        `Rust target ${target.targetTriple} is not installed; run rustup target add ${target.targetTriple} before building`,
      );
    }
  }

  // Cargo builds share the workspace target directory and remain serial.
  for (const target of targets) {
    buildNativeTarget({
      skipRootCopy: sharedSkipRootCopy || !isHostTarget(target),
      target,
    });
  }
}

function buildNativeTarget({ skipRootCopy, target }) {

  const cargoCommand = target.cargoCommand ?? inferCargoCommand(target);
  const cargoArgs = buildCargoArgs({
    cargoCommand,
    targetTriple: target.targetTriple,
  });

  const cargoResult = spawnSync("cargo", cargoArgs, {
    cwd: packageRoot,
    env: buildCargoEnvironment({
      cargoCommand,
      libc: target.libc,
    }),
    stdio: "inherit",
  });
  if ((cargoResult.status ?? 1) !== 0) {
    process.exit(cargoResult.status ?? 1);
  }

  const builtLibraryPath = path.join(
    nativeRoot,
    "target",
    ...(target.targetTriple ? [target.targetTriple] : []),
    "release",
    platformFileName(target.platform),
  );
  if (!existsSync(builtLibraryPath)) {
    throw new Error(`Native library not found at ${builtLibraryPath}`);
  }

  if (!skipRootCopy) {
    const outputDir = path.join(packageRoot, "native");
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(builtLibraryPath, path.join(outputDir, "index.node"));
  }

  writeNativePackage(target, builtLibraryPath);
}

function writeNativePackage(target, builtLibraryPath) {
  const packageDir = path.join(packageRoot, "npm", target.packageName);
  rmSync(packageDir, { force: true, recursive: true });
  mkdirSync(packageDir, { recursive: true });
  copyFileSync(builtLibraryPath, path.join(packageDir, "index.node"));
  copyFileSync(
    path.join(packageRoot, "LICENSE"),
    path.join(packageDir, "LICENSE"),
  );
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: target.packageName,
        version: packageJson.version,
        repository: packageJson.repository,
        license: packageJson.license,
        os: [target.platform],
        cpu: [target.arch],
        ...(target.libc
          ? { libc: [target.libc === "gnu" ? "glibc" : target.libc] }
          : {}),
        files: ["index.node", "LICENSE"],
        main: "index.node",
        publishConfig: {
          access: "public",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    path.join(packageDir, "README.md"),
    `${target.packageName}\n`,
    "utf8",
  );
}

export function buildCargoEnvironment({
  cargoCommand,
  environment = process.env,
  libc,
}) {
  if (cargoCommand !== "zigbuild" || libc !== "musl") {
    return environment;
  }

  const rustFlags = environment.RUSTFLAGS?.replace(
    MUSL_ZIGBUILD_RUSTFLAG_PATTERN,
    "",
  ).trim();
  return {
    ...environment,
    RUSTFLAGS: [rustFlags, MUSL_ZIGBUILD_RUSTFLAG].filter(Boolean).join(" "),
  };
}

function buildCargoArgs({ cargoCommand, targetTriple }) {
  const baseArgs = [
    "--manifest-path",
    path.join(nativeRoot, "Cargo.toml"),
    "--release",
    ...(targetTriple ? ["--target", targetTriple] : []),
  ];

  if (cargoCommand === "zigbuild") {
    return ["zigbuild", ...baseArgs];
  }
  if (cargoCommand === "xwin") {
    return ["xwin", "build", ...baseArgs];
  }

  return ["build", ...baseArgs];
}

function readInstalledRustTargets() {
  const result = spawnSync("rustup", ["target", "list", "--installed"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    return new Set();
  }
  return new Set(result.stdout.split(/\r?\n/u).map((line) => line.trim()));
}

function ensureCargoSubcommands(targets) {
  const requiredCommands = new Set(
    targets
      .map((target) => target.cargoCommand ?? inferCargoCommand(target))
      .filter((command) => command && command !== "build"),
  );

  for (const cargoCommand of requiredCommands) {
    if (hasCargoSubcommand(cargoCommand)) {
      continue;
    }

    throw new Error(
      `cargo ${cargoCommand} is not installed; provision it explicitly before building`,
    );
  }
}

function hasCargoSubcommand(cargoCommand) {
  const result = spawnSync("cargo", [cargoCommand, "--version"], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  return (result.status ?? 1) === 0;
}

function inferCargoCommand(target) {
  if (!target.targetTriple || isHostTarget(target)) {
    return "";
  }
  if (target.platform === "win32") {
    return "xwin";
  }
  if (target.platform === "linux" || target.targetTriple.includes("musl")) {
    return "zigbuild";
  }
  return "";
}

function isHostTarget(target) {
  return (
    target.platform === hostTarget.platform &&
    target.arch === hostTarget.arch &&
    target.libc === hostTarget.libc
  );
}

function platformFileName(platform) {
  const libraryBaseName = "gcc_ts_bundler_native";
  if (platform === "win32") {
    return `${libraryBaseName}.dll`;
  }
  if (platform === "darwin") {
    return `lib${libraryBaseName}.dylib`;
  }

  return `lib${libraryBaseName}.so`;
}
