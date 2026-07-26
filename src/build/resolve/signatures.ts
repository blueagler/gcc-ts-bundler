import fs from "fs";
import path from "path";

import { hashContent, hashJson } from "../../shared/hash";
import { getPackageRootFromBundle } from "../../shared/bundle-location";
import type { ResolvedBuildOptions } from "../types";

export async function hashTsConfig(configPath: string): Promise<string> {
  return hashContent(await fs.promises.readFile(configPath, "utf-8"));
}

export async function hashExternalInputs(filePaths: string[]): Promise<string> {
  const entries = await Promise.all(
    [...filePaths]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        filePath,
        hash: hashContent(await fs.promises.readFile(filePath, "utf-8")),
      })),
  );
  return hashJson(entries);
}

export function getPackageRoot() {
  return getPackageRootFromBundle();
}

let packageSignaturePromises: Map<string, Promise<string>> | undefined;

export async function getPackageSignature(packageRoot = getPackageRoot()) {
  const cache = (packageSignaturePromises ??= new Map<
    string,
    Promise<string>
  >());
  let packageSignaturePromise = cache.get(packageRoot);
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await fs.promises.stat(
        path.join(packageRoot, "package.json"),
      );
      const runtimeSignature = await readRuntimeSignature(packageRoot);
      const nativeSignature = await readNativeSignature(packageRoot);
      return hashContent(
        JSON.stringify({
          nativeSignature,
          packageJson: {
            mtimeMs: packageJsonStat.mtimeMs,
            size: packageJsonStat.size,
          },
          runtimeSignature,
        }),
      );
    })();
    cache.set(packageRoot, packageSignaturePromise);
  }

  return packageSignaturePromise;
}

export function getOptionsSignature(options: ResolvedBuildOptions) {
  return hashJson({
    compat: options.compat,
    compilationLevel: options.compilationLevel,
    chunks: options.chunks,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => ({
      name: entry.name,
      relativePath: path.relative(options.srcDir, entry.file),
    })),
    externs: [...options.externs].sort(),
    js: [...options.js].sort(),
    languageOut: options.languageOut,
    outDir: options.outDir,
    packages: options.packages,
    projectRoot: options.projectRoot,
    srcDir: options.srcDir,
  });
}

async function readRuntimeSignature(packageRoot: string) {
  try {
    const stat = await fs.promises.stat(
      path.join(packageRoot, "dist", "index.mjs"),
    );
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch {
    return "";
  }
}

async function readNativeSignature(packageRoot: string) {
  try {
    const stat = await fs.promises.stat(
      path.join(packageRoot, "native", "index.node"),
    );
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  } catch {
    return "";
  }
}
