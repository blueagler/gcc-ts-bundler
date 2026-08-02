import crypto from "crypto";
import fs from "fs";
import path from "path";

import { hashContent, hashJson } from "../../shared/hash";
import { getPackageRootFromBundle } from "../../shared/bundle-location";
import type { ResolvedBuildOptions } from "../types";
import {
  resolveClosureCompilerEnvironment,
  type ClosureCompilerEnvironment,
} from "../closure/compiler";

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

export async function getPackageSignature(packageRoot = getPackageRoot()) {
  const [packageJsonSignature, runtimeSignature, nativeSignature] =
    await Promise.all([
      hashFile(path.join(packageRoot, "package.json")),
      hashOptionalFile(path.join(packageRoot, "dist", "index.mjs")),
      hashOptionalFile(path.join(packageRoot, "native", "index.node")),
    ]);
  return hashJson({
    nativeSignature,
    packageJsonSignature,
    runtimeSignature,
  });
}

export function getOptionsSignature(
  options: ResolvedBuildOptions,
  compilerEnvironment: ClosureCompilerEnvironment = resolveClosureCompilerEnvironment(),
) {
  return hashJson({
    compilerEnvironment,
    compat: options.compat,
    compilationLevel: options.compilationLevel,
    chunks: options.chunks,
    // Decides whether the runtime preamble carries the CSS loader, so two
    // otherwise identical builds produce different bytes.
    cssRuntime: options.cssRuntime,
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
    platformExterns: options.platformExterns,
    projectRoot: options.projectRoot,
    srcDir: options.srcDir,
    target: options.target,
    typeMetadata: hashJson(options.typeMetadata ?? null),
    typedExterns: [...options.typedExterns].sort(),
  });
}

async function hashOptionalFile(filePath: string) {
  try {
    return await hashFile(filePath);
  } catch {
    return "";
  }
}

async function hashFile(filePath: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.promises.readFile(filePath))
    .digest("hex");
}
