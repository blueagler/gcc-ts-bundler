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
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(packageRoot, "native");
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const TARGETS = {
  "darwin-arm64": {
    arch: "arm64",
    packageName: "gcc-ts-bundler-darwin-arm64",
    platform: "darwin",
    targetTriple: "aarch64-apple-darwin",
  },
  "darwin-x64": {
    arch: "x64",
    packageName: "gcc-ts-bundler-darwin-x64",
    platform: "darwin",
    targetTriple: "x86_64-apple-darwin",
  },
  "linux-arm64-gnu": {
    arch: "arm64",
    libc: "gnu",
    packageName: "gcc-ts-bundler-linux-arm64-gnu",
    platform: "linux",
    targetTriple: "aarch64-unknown-linux-gnu",
  },
  "linux-arm64-musl": {
    arch: "arm64",
    libc: "musl",
    packageName: "gcc-ts-bundler-linux-arm64-musl",
    platform: "linux",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "linux-x64-gnu": {
    arch: "x64",
    libc: "gnu",
    packageName: "gcc-ts-bundler-linux-x64-gnu",
    platform: "linux",
    targetTriple: "x86_64-unknown-linux-gnu",
  },
  "linux-x64-musl": {
    arch: "x64",
    libc: "musl",
    packageName: "gcc-ts-bundler-linux-x64-musl",
    platform: "linux",
    targetTriple: "x86_64-unknown-linux-musl",
  },
  "win32-arm64-msvc": {
    arch: "arm64",
    packageName: "gcc-ts-bundler-win32-arm64-msvc",
    platform: "win32",
    targetTriple: "aarch64-pc-windows-msvc",
  },
  "win32-x64-msvc": {
    arch: "x64",
    packageName: "gcc-ts-bundler-win32-x64-msvc",
    platform: "win32",
    targetTriple: "x86_64-pc-windows-msvc",
  },
};

const args = parseArgs(process.argv.slice(2));
const hostTarget = resolveSingleBuildTarget({});
const targets = resolveBuildTargets(args);
const sharedSkipRootCopy =
  args["skip-root-copy"] === true || targets.length > 1;

ensureCargoSubcommands(targets);

for (const target of targets) {
  buildNativeTarget({
    skipRootCopy: sharedSkipRootCopy || !isHostTarget(target),
    target,
  });
}

function buildNativeTarget({
  skipRootCopy,
  target,
}) {
  ensureRustTargetInstalled(target);

  const cargoCommand = target.cargoCommand ?? inferCargoCommand(target);
  const cargoArgs = buildCargoArgs({
    cargoCommand,
    targetTriple: target.targetTriple,
  });

  const cargoResult = spawnSync("cargo", cargoArgs, {
    cwd: packageRoot,
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

function writeNativePackage(
  target,
  builtLibraryPath,
) {
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
        license: packageJson.license,
        os: [target.platform],
        cpu: [target.arch],
        ...(target.libc ? { libc: [target.libc] } : {}),
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

function ensureRustTargetInstalled(target) {
  if (!target.targetTriple || isRustTargetInstalled(target.targetTriple)) {
    return;
  }

  const result = spawnSync(
    "rustup",
    ["target", "add", target.targetTriple],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
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

function isRustTargetInstalled(targetTriple) {
  const result = spawnSync("rustup", ["target", "list", "--installed"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    return false;
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .includes(targetTriple);
}

function ensureCargoSubcommands(targets) {
  const requiredCommands = new Set(
    targets
      .map((target) => target.cargoCommand ?? inferCargoCommand(target))
      .filter(Boolean),
  );

  for (const cargoCommand of requiredCommands) {
    if (hasCargoSubcommand(cargoCommand)) {
      continue;
    }

    if (cargoCommand === "zigbuild") {
      installCargoTool("cargo-zigbuild");
      ensureExternalCommand(
        "zig",
        "zig is required for cross-compiling Linux targets. Install zig and rerun the build.",
      );
      continue;
    }

    if (cargoCommand === "xwin") {
      installCargoTool("cargo-xwin");
      continue;
    }

    throw new Error(`Unsupported cargo subcommand ${cargoCommand}`);
  }
}

function hasCargoSubcommand(cargoCommand) {
  const result = spawnSync("cargo", [cargoCommand, "--version"], {
    cwd: packageRoot,
    stdio: "ignore",
  });
  return (result.status ?? 1) === 0;
}

function installCargoTool(crateName) {
  const result = spawnSync("cargo", ["install", crateName, "--locked"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function ensureExternalCommand(command, message) {
  const versionArgs = command === "zig" ? ["version"] : ["--version"];
  const result = spawnSync(command, versionArgs, {
    cwd: packageRoot,
    stdio: "ignore",
  });
  if ((result.status ?? 1) === 0) {
    return;
  }

  throw new Error(message);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const flag = current.slice(2);
    const [key, inlineValue] = flag.split("=", 2);
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = nextValue;
    index += 1;
  }

  return parsed;
}

function resolveBuildTargets(options) {
  const explicitTargetKeys = parseListArg(options.targets);
  if (explicitTargetKeys.length > 0) {
    return explicitTargetKeys.map((targetKey) =>
      resolveSingleBuildTarget({ ...options, targetKey }),
    );
  }

  const platformFilters = new Set(parseListArg(options.platforms));
  if (options.all === true || platformFilters.size > 0) {
    return Object.keys(TARGETS)
      .filter((targetKey) => {
        if (platformFilters.size === 0) {
          return true;
        }
        return platformFilters.has(TARGETS[targetKey].platform);
      })
      .map((targetKey) => resolveSingleBuildTarget({ ...options, targetKey }));
  }

  return [resolveSingleBuildTarget(options)];
}

function resolveSingleBuildTarget(options) {
  if (typeof options.targetKey === "string") {
    const metadata = TARGETS[options.targetKey];
    if (!metadata) {
      throw new Error(`Unsupported native target ${options.targetKey}`);
    }
    return {
      arch: metadata.arch,
      cargoCommand:
        typeof options["cargo-command"] === "string"
          ? options["cargo-command"]
          : undefined,
      libc: metadata.libc ?? null,
      packageName:
        typeof options["package-name"] === "string"
          ? options["package-name"]
          : metadata.packageName,
      platform: metadata.platform,
      targetTriple:
        typeof options.target === "string" ? options.target : metadata.targetTriple,
    };
  }

  const platform =
    typeof options.platform === "string" ? options.platform : process.platform;
  const arch = typeof options.arch === "string" ? options.arch : process.arch;
  const libc =
    platform === "linux"
      ? typeof options.libc === "string"
        ? options.libc
        : detectLinuxLibc()
      : null;
  const targetKey =
    platform === "linux"
      ? `${platform}-${arch}-${libc}`
      : platform === "win32"
        ? `${platform}-${arch}-msvc`
        : `${platform}-${arch}`;
  const metadata = TARGETS[targetKey];
  if (!metadata) {
    throw new Error(`Unsupported native target ${targetKey}`);
  }

  return {
    arch,
    cargoCommand:
      typeof options["cargo-command"] === "string"
        ? options["cargo-command"]
        : undefined,
    libc,
    packageName:
      typeof options["package-name"] === "string"
        ? options["package-name"]
        : metadata.packageName,
    platform,
    targetTriple:
      typeof options.target === "string" ? options.target : metadata.targetTriple,
  };
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

function parseListArg(value) {
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function detectLinuxLibc() {
  if (process.platform !== "linux") {
    return null;
  }

  if (process.report?.getReport?.().header?.glibcVersionRuntime) {
    return "gnu";
  }

  try {
    const output = spawnSync("ldd", ["--version"], {
      encoding: "utf8",
    });
    return output.stdout.includes("musl") || output.stderr.includes("musl")
      ? "musl"
      : "gnu";
  } catch {
    return "musl";
  }
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
