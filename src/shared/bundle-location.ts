import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

declare const __gcc_current_module_url: string;

let bundleRequire: NodeRequire | null = null;
let packageRoot: string | null = null;

function getBundleFilePath() {
  return fileURLToPath(__gcc_current_module_url);
}

export function createBundleRequire(): NodeRequire {
  bundleRequire ??= createRequire(__gcc_current_module_url);
  return bundleRequire;
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
