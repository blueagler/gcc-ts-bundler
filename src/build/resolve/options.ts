import path from "path";

import {
  CACHE_MODES,
  CHUNK_MODES,
  COMPILATION_LEVELS,
  DEFAULT_BUILD_OPTIONS,
  DIAGNOSTICS_PREFLIGHT_MODES,
  LANGUAGE_OUTPUTS,
  PACKAGE_MODES,
} from "../../api/types";
import type { BuildEntryOption, BuildOptions } from "../../api/types";
import type { ResolvedBuildOptions } from "../types";
import { requireChoice } from "../../shared/validation";

export function normalizeBuildOptions(
  options: BuildOptions,
): ResolvedBuildOptions {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(
    projectRoot,
    options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"),
  );
  const outDir = path.resolve(
    projectRoot,
    options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"),
  );
  const chunkPublicPath = normalizeChunkPublicPath(
    options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath,
  );
  const chunkManifestFile = path.basename(
    options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile,
  );

  return {
    cache: {
      dir: options.cache?.dir
        ? path.resolve(projectRoot, options.cache.dir)
        : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: requireChoice(
        options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode,
        CACHE_MODES,
        "cache.mode",
      ),
    },
    chunks: {
      baseChunkName:
        options.chunks?.baseChunkName ??
        DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      manifestFile: chunkManifestFile,
      mode: requireChoice(
        options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
        CHUNK_MODES,
        "chunks.mode",
      ),
      publicPath: chunkPublicPath,
    },
    compat: {
      classMapCalls: [...(options.compat?.classMapCalls ?? [])].map(
        (call) => ({ argIndex: call.argIndex, callee: call.callee }),
      ),
    },
    compilationLevel: requireChoice(
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
      COMPILATION_LEVELS,
      "compilationLevel",
    ),
    diagnostics: {
      fatalWarnings:
        options.diagnostics?.fatalWarnings ??
        DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight: requireChoice(
        options.diagnostics?.preflight ??
          DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
        DIAGNOSTICS_PREFLIGHT_MODES,
        "diagnostics.preflight",
      ),
      verbose:
        options.diagnostics?.verbose ??
        DEFAULT_BUILD_OPTIONS.diagnostics.verbose,
    },
    entries: options.entries.map((entry) => normalizeEntry(entry, srcDir)),
    externs: [...(options.externs ?? [])].map((filePath) =>
      path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath),
    ),
    js: [...(options.js ?? [])].map((filePath) =>
      path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath),
    ),
    languageOut: requireChoice(
      options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
      LANGUAGE_OUTPUTS,
      "languageOut",
    ),
    outDir,
    packages: requireChoice(
      options.packages ?? DEFAULT_BUILD_OPTIONS.packages,
      PACKAGE_MODES,
      "packages",
    ),
    projectRoot,
    srcDir,
  };
}

function normalizeEntry(entry: BuildEntryOption, srcDir: string) {
  const file = typeof entry === "string" ? entry : entry.file;
  const name = typeof entry === "string" ? null : (entry.name ?? null);
  return {
    file: path.isAbsolute(file) ? file : path.resolve(srcDir, file),
    name,
  };
}

function normalizeChunkPublicPath(publicPath: string) {
  if (publicPath.length === 0) {
    return "./";
  }
  return publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
}
