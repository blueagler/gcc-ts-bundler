import fs from "fs";
import path from "path";

import {
  createBundleRequire,
  getPackageRootFromBundle,
} from "../internal/bundle-location";

const require = createBundleRequire();

const SUPPORTED_TARGETS = {
  "darwin-arm64": "gcc-ts-bundler-darwin-arm64",
  "darwin-x64": "gcc-ts-bundler-darwin-x64",
  "linux-arm64-gnu": "gcc-ts-bundler-linux-arm64-gnu",
  "linux-arm64-musl": "gcc-ts-bundler-linux-arm64-musl",
  "linux-x64-gnu": "gcc-ts-bundler-linux-x64-gnu",
  "linux-x64-musl": "gcc-ts-bundler-linux-x64-musl",
  "win32-arm64-msvc": "gcc-ts-bundler-win32-arm64-msvc",
  "win32-x64-msvc": "gcc-ts-bundler-win32-x64-msvc",
} as const;

function detectLinuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  if (report?.header?.glibcVersionRuntime) {
    return "gnu";
  }

  try {
    const { execFileSync } =
      require("node:child_process") as typeof import("node:child_process");
    const output = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.includes("musl") ? "musl" : "gnu";
  } catch {
    // Fall through to musl, which is the safer fallback for unknown Linux libc.
  }

  return "musl";
}

function getTargetKey() {
  if (process.platform === "linux") {
    return `${process.platform}-${process.arch}-${detectLinuxLibc()}`;
  }

  if (process.platform === "win32") {
    return `${process.platform}-${process.arch}-msvc`;
  }

  return `${process.platform}-${process.arch}`;
}

function loadNativeBinding() {
  const targetKey = getTargetKey();
  const packageName =
    SUPPORTED_TARGETS[targetKey as keyof typeof SUPPORTED_TARGETS];

  const localFallbackPath = path.join(
    getPackageRootFromBundle(),
    "native",
    "index.node",
  );
  if (fs.existsSync(localFallbackPath)) {
    return require(localFallbackPath);
  }

  const loadErrors: string[] = [];

  if (packageName) {
    try {
      return require(packageName);
    } catch (error) {
      loadErrors.push(
        `${packageName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const supportedTargets = Object.keys(SUPPORTED_TARGETS).join(", ");
  const details =
    loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(
    `No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`,
  );
}

export default loadNativeBinding();
