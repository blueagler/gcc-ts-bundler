import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createBundleRequire,
  getPackageRootFromBundle,
} from "../shared/bundle-location";
import { getErrorMessage, isRecord } from "../shared/validation";

const require = createBundleRequire();

const SUPPORTED_TARGETS = new Map<string, string>([
  ["darwin-arm64", "gcc-ts-bundler-darwin-arm64"],
  ["darwin-x64", "gcc-ts-bundler-darwin-x64"],
  ["linux-arm64-gnu", "gcc-ts-bundler-linux-arm64-gnu"],
  ["linux-arm64-musl", "gcc-ts-bundler-linux-arm64-musl"],
  ["linux-x64-gnu", "gcc-ts-bundler-linux-x64-gnu"],
  ["linux-x64-musl", "gcc-ts-bundler-linux-x64-musl"],
  ["win32-arm64-msvc", "gcc-ts-bundler-win32-arm64-msvc"],
  ["win32-x64-msvc", "gcc-ts-bundler-win32-x64-msvc"],
]);

function detectLinuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport();
  if (
    isRecord(report) &&
    isRecord(report.header) &&
    typeof report.header.glibcVersionRuntime === "string"
  ) {
    return "gnu";
  }

  try {
    const output = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.includes("musl") ? "musl" : "gnu";
  } catch {
    return "musl";
  }
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

function loadNativeBinding(): unknown {
  const targetKey = getTargetKey();
  const packageName = SUPPORTED_TARGETS.get(targetKey);

  const localFallbackPath = path.join(
    getPackageRootFromBundle(),
    "native",
    "index.node",
  );
  if (fs.existsSync(localFallbackPath)) {
    const binding: unknown = require(localFallbackPath);
    return binding;
  }

  const loadErrors: string[] = [];

  if (packageName) {
    try {
      const binding: unknown = require(packageName);
      return binding;
    } catch (error) {
      loadErrors.push(`${packageName}: ${getErrorMessage(error)}`);
    }
  }

  const supportedTargets = [...SUPPORTED_TARGETS.keys()].join(", ");
  const details =
    loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(
    `No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`,
  );
}

export default loadNativeBinding();
