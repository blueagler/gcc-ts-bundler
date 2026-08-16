import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  createBundleRequire,
  createCurrentWorkingDirectoryRequire,
  getPackageRootFromBundle,
} from "../shared/bundle-location";
import {
  getErrorMessage,
  isRecord,
  isString,
  type RuntimeValue,
} from "../shared/validation";

export interface NativeAddonCandidate {
  [key: string]: RuntimeValue;
}

const NATIVE_ADDON_LOAD_FAILED = Symbol("native-addon-load-failed");
const INVALID_NATIVE_ADDON_MESSAGE =
  "Loaded native addon has an invalid API surface.";

const require = createBundleRequire();

function parseNativeAddonCandidate<Value>(
  value: Value,
): Value & NativeAddonCandidate {
  if (!isRecord(value)) {
    throw new TypeError(INVALID_NATIVE_ADDON_MESSAGE);
  }
  return value;
}

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
  const reportHeader = isRecord(report) ? report["header"] : undefined;
  if (isRecord(reportHeader) && isString(reportHeader["glibcVersionRuntime"])) {
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

export function loadNativeBinding(): NativeAddonCandidate {
  const targetKey = getTargetKey();
  const packageName = SUPPORTED_TARGETS.get(targetKey);
  const loadErrors: string[] = [];

  let localBinding: unknown = NATIVE_ADDON_LOAD_FAILED;
  try {
    const localFallbackPath = path.join(
      getPackageRootFromBundle(),
      "native",
      "index.node",
    );
    if (fs.existsSync(localFallbackPath)) {
      localBinding = require(localFallbackPath);
    }
  } catch (error) {
    loadErrors.push(`local development addon: ${getErrorMessage(error)}`);
  }
  if (localBinding !== NATIVE_ADDON_LOAD_FAILED) {
    return parseNativeAddonCandidate(localBinding);
  }

  if (packageName) {
    const packageRequires: Array<
      [string, (packageName: string) => RuntimeValue]
    > = [
      ["bundle", require],
      ["current working directory", createCurrentWorkingDirectoryRequire()],
    ];
    for (const [anchor, packageRequire] of packageRequires) {
      let packageBinding: unknown = NATIVE_ADDON_LOAD_FAILED;
      try {
        packageBinding = packageRequire(packageName);
      } catch (error) {
        loadErrors.push(
          `${packageName} from ${anchor}: ${getErrorMessage(error)}`,
        );
      }
      if (packageBinding !== NATIVE_ADDON_LOAD_FAILED) {
        return parseNativeAddonCandidate(packageBinding);
      }
    }
  }

  const supportedTargets = [...SUPPORTED_TARGETS.keys()].join(", ");
  const details =
    loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(
    `No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`,
  );
}
