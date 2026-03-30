import { copyFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const nativeRoot = path.join(packageRoot, "native");

const result = spawnSync(
  "cargo",
  ["build", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--release"],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const libraryBaseName = "gcc_ts_bundler_native";
const platformFileName =
  process.platform === "win32"
    ? `${libraryBaseName}.dll`
    : process.platform === "darwin"
      ? `lib${libraryBaseName}.dylib`
      : `lib${libraryBaseName}.so`;
const builtLibraryPath = path.join(
  nativeRoot,
  "target",
  "release",
  platformFileName,
);

if (!existsSync(builtLibraryPath)) {
  throw new Error(`Native library not found at ${builtLibraryPath}`);
}

const outputDir = path.join(packageRoot, "native");
mkdirSync(outputDir, { recursive: true });
copyFileSync(builtLibraryPath, path.join(outputDir, "index.node"));
