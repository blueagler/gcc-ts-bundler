import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

declare const __gcc_current_module_url: string;

let bundleRequire: NodeRequire | null = null;
let packageRoot: string | null = null;

function getCurrentModuleUrl() {
  return typeof __gcc_current_module_url === "string"
    ? __gcc_current_module_url
    : import.meta.url;
}

function getBundleFilePath() {
  return fileURLToPath(getCurrentModuleUrl());
}

export function createBundleRequire(): NodeRequire {
  bundleRequire ??= createRequire(getCurrentModuleUrl());
  return bundleRequire;
}

export function createCurrentWorkingDirectoryRequire(): NodeRequire {
  return createRequire(path.join(process.cwd(), "package.json"));
}

export function getPackageRootFromBundle(): string {
  if (packageRoot) {
    return packageRoot;
  }

  let currentDir = path.dirname(getBundleFilePath());
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `Unable to locate package.json from bundled module path ${getBundleFilePath()}`,
      );
    }

    currentDir = parentDir;
  }
}
