import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(packageRoot, "native");
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
const TARGETS = {
  "darwin-arm64": {
    packageName: "gcc-ts-bundler-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
  },
  "darwin-x64": {
    packageName: "gcc-ts-bundler-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
  },
  "linux-arm64-gnu": {
    packageName: "gcc-ts-bundler-linux-arm64-gnu",
    targetTriple: "aarch64-unknown-linux-gnu",
  },
  "linux-arm64-musl": {
    packageName: "gcc-ts-bundler-linux-arm64-musl",
    targetTriple: "aarch64-unknown-linux-musl",
  },
  "linux-x64-gnu": {
    packageName: "gcc-ts-bundler-linux-x64-gnu",
    targetTriple: "x86_64-unknown-linux-gnu",
  },
  "linux-x64-musl": {
    packageName: "gcc-ts-bundler-linux-x64-musl",
    targetTriple: "x86_64-unknown-linux-musl",
  },
  "win32-arm64-msvc": {
    packageName: "gcc-ts-bundler-win32-arm64-msvc",
    targetTriple: "aarch64-pc-windows-msvc",
  },
  "win32-x64-msvc": {
    packageName: "gcc-ts-bundler-win32-x64-msvc",
    targetTriple: "x86_64-pc-windows-msvc",
  },
};
const args = parseArgs(process.argv.slice(2));

const target = resolveBuildTarget(args);
const cargoCommand = args["cargo-command"] ?? inferCargoCommand(target);
const cargoArgs = [
  ...(cargoCommand ? [cargoCommand] : []),
  "build",
  "--manifest-path",
  path.join(nativeRoot, "Cargo.toml"),
  "--release",
  ...(target.targetTriple ? ["--target", target.targetTriple] : []),
];

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

if (!args["skip-root-copy"]) {
  const outputDir = path.join(packageRoot, "native");
  mkdirSync(outputDir, { recursive: true });
  copyFileSync(builtLibraryPath, path.join(outputDir, "index.node"));
}

const packageDir = path.join(packageRoot, "npm", target.packageName);
rmSync(packageDir, { force: true, recursive: true });
mkdirSync(packageDir, { recursive: true });
copyFileSync(builtLibraryPath, path.join(packageDir, "index.node"));
writeFileSync(
  path.join(packageDir, "package.json"),
  JSON.stringify(
    {
      name: target.packageName,
      version: packageJson.version,
      os: [target.platform],
      cpu: [target.arch],
      ...(target.libc ? { libc: [target.libc] } : {}),
      files: ["index.node"],
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

function resolveBuildTarget(options) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const libc = platform === "linux" ? options.libc ?? detectLinuxLibc() : null;
  const targetKey =
    platform === "linux"
      ? `${platform}-${arch}-${libc}`
      : platform === "win32"
        ? `${platform}-${arch}-msvc`
        : `${platform}-${arch}`;

  const metadata =
    TARGETS[targetKey];
  if (!metadata) {
    throw new Error(`Unsupported native target ${targetKey}`);
  }

  return {
    arch,
    libc,
    packageName: options["package-name"] ?? metadata.packageName,
    platform,
    targetTriple: options.target ?? metadata.targetTriple,
  };
}

function inferCargoCommand(target) {
  return target.targetTriple?.includes("musl") ? "zigbuild" : "";
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
