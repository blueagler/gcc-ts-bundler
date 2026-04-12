import path from "path";

import {
  BuildOptions,
  ChunkLoader,
  ChunkLoaderInput,
  DEFAULT_BUILD_OPTIONS,
} from "../../api/types";
import { NormalizedBuildOptions } from "../../internal/types";

export const UNSUPPORTED_FETCH_LOADER_ERROR =
  'gcc-ts-bundler does not support chunks.loader="fetch". Use "script" instead.';

export function normalizeBuildOptions(
  options: BuildOptions,
): NormalizedBuildOptions {
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
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode,
    },
    chunks: {
      baseChunkName:
        options.chunks?.baseChunkName ??
        DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      loader: normalizeChunkLoader(
        options.chunks?.loader ?? DEFAULT_BUILD_OPTIONS.chunks.loader,
      ),
      manifestFile: chunkManifestFile,
      mode: options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
      publicPath: chunkPublicPath,
    },
    compilationLevel:
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings:
        options.diagnostics?.fatalWarnings ??
        DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight:
        options.diagnostics?.preflight ??
        DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose:
        options.diagnostics?.verbose ??
        DEFAULT_BUILD_OPTIONS.diagnostics.verbose,
    },
    entries: options.entries.map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(srcDir, entry),
    ),
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
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    outputNames: [...(options.outputNames ?? [])],
    packages: {
      mode: options.packages?.mode ?? DEFAULT_BUILD_OPTIONS.packages.mode,
    },
    projectRoot,
    srcDir,
  };
}

function normalizeChunkPublicPath(publicPath: string) {
  if (publicPath.length === 0) {
    return "./";
  }
  return publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
}

export function normalizeChunkLoader(
  loader: ChunkLoaderInput | "fetch",
): ChunkLoader {
  if (loader === "fetch") {
    throw new Error(UNSUPPORTED_FETCH_LOADER_ERROR);
  }
  return "script";
}
