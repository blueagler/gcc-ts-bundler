import crypto from "crypto";
import fs from "fs";
import path from "path";

import { hashContent, hashJson } from "../../shared/hash";
import { getPackageRootFromBundle } from "../../shared/bundle-location";
import { normalizeRelativePath } from "../../shared/files";
import type { ResolvedBuildOptions } from "../types";
import {
  resolveClosureCompilerEnvironment,
  type ClosureCompilerEnvironment,
} from "../closure/compiler";

export async function hashTsConfig(configPath: string): Promise<string> {
  return hashContent(await fs.promises.readFile(configPath, "utf-8"));
}

export async function hashExternalInputs(filePaths: string[]): Promise<string> {
  const hashes = await Promise.all(
    filePaths.map(async (filePath) =>
      hashContent(await fs.promises.readFile(filePath, "utf-8")),
    ),
  );
  return hashJson(hashes);
}

/** Published JavaScript entries, relative to the package root. Kept in sync
 * with the `exports` map in `package.json`. */
const PUBLISHED_ENTRY_FILES = [
  "dist/index.mjs",
  "dist/vite/index.mjs",
  "dist/presets/react.mjs",
  "dist/presets/svelte.mjs",
  "dist/presets/vue.mjs",
] as const;

export async function getPackageSignature(
  packageRoot = getPackageRootFromBundle(),
) {
  // Every published entry, not just the core one: a Vite-plugin or preset
  // change alters emitted bytes without touching `dist/index.mjs`, and hashing
  // only that let a warm cache replay output from the previous build of the
  // plugin.
  const [packageJsonSignature, nativeSignature, ...entrySignatures] =
    await Promise.all([
      hashFile(path.join(packageRoot, "package.json")),
      hashOptionalFile(path.join(packageRoot, "native", "index.node")),
      ...PUBLISHED_ENTRY_FILES.map((relativePath) =>
        hashOptionalFile(path.join(packageRoot, relativePath)),
      ),
    ]);
  return hashJson({
    entrySignatures,
    nativeSignature,
    packageJsonSignature,
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
    finalMinify: options.finalMinify,
    diagnostics: options.diagnostics,
    hideWarningsFor: options.hideWarningsFor ?? null,
    entries: options.entries.map((entry) => ({
      name: entry.name,
      // `outFile` is a publish destination, and `publishOffModeEntryOutFiles`
      // rewrites the copied file's relative imports from where it lands
      // versus `outDir`, so that relationship does change emitted bytes. The
      // absolute prefix does not. A relative `outFile` resolves against
      // `projectRoot` exactly as publishing resolves it, so the key never
      // depends on `process.cwd()`.
      ...(entry.outFile === undefined
        ? {}
        : {
            outFile: toKeyedRelativePath(
              options.outDir,
              path.isAbsolute(entry.outFile)
                ? path.resolve(entry.outFile)
                : path.resolve(options.projectRoot, entry.outFile),
            ),
          }),
      relativePath: toKeyedRelativePath(options.srcDir, entry.file),
    })),
    externals: options.externals,
    // Externs, `js` and `typedExterns` key only which files participate and in
    // what order Closure sees them: their contents are hashed separately by
    // `hashExternalInputs` in `src/build/resolve/index.ts`, so the absolute
    // location contributes no correctness, only directory sensitivity. The
    // relative forms are what get sorted, so relocating the project can never
    // reorder the list.
    externs: options.externs
      .map((filePath) => toKeyedProjectPath(options.projectRoot, filePath))
      .sort(),
    js: options.js
      .map((filePath) => toKeyedProjectPath(options.projectRoot, filePath))
      .sort(),
    languageOut: options.languageOut,
    // The absolute parent cannot change a single output byte; the
    // project-relative output directory can, since it is what the published
    // `outFile` copies measure their rewritten relative imports against.
    outDir: toKeyedProjectPath(options.projectRoot, options.outDir),
    packages: options.packages,
    platformExterns: options.platformExterns,
    preserveModules: options.preserveModules.map((filePath) =>
      toKeyedProjectPath(options.projectRoot, filePath),
    ),
    // `projectRoot` itself is deliberately absent: every other path here is
    // keyed relative to it, so hashing the absolute value would only
    // reintroduce the directory sensitivity that relativizing removes.
    // The plan mirrors this, so a different host layout is a different build
    // even when every source byte is unchanged.
    rollupChunks: hashJson(options.rollupChunks),
    srcDir: toKeyedProjectPath(options.projectRoot, options.srcDir),
    target: options.target,
    typeMetadata: hashJson(options.typeMetadata ?? null),
    typedExterns: options.typedExterns
      .map((filePath) => toKeyedProjectPath(options.projectRoot, filePath))
      .sort(),
  });
}
/**
 * Location-independent key form of an absolute path: relative to `fromDir`,
 * with POSIX separators so the same layout hashes identically on Windows.
 */
function toKeyedRelativePath(fromDir: string, filePath: string) {
  return normalizeRelativePath(path.relative(fromDir, filePath));
}

/**
 * Like `toKeyedRelativePath`, but paths that leave `fromDir` collapse to a
 * single placeholder. Their contents are hashed separately; embedding the
 * escaped relative path would make a temp staging directory a cache key.
 */
function toKeyedProjectPath(fromDir: string, filePath: string) {
  const relativePath = path.relative(fromDir, filePath);
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return "..";
  }
  return normalizeRelativePath(relativePath);
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
