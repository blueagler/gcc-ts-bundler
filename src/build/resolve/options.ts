import fs from "fs/promises";
import path from "path";

import {
  CACHE_MODES,
  CHUNK_MODES,
  CHUNK_OUTPUT_TYPES,
  COMPILATION_LEVELS,
  DEFAULT_BUILD_OPTIONS,
  DIAGNOSTICS_PREFLIGHT_MODES,
  LANGUAGE_OUTPUTS,
  PACKAGE_MODES,
  PLATFORM_EXTERNS_MODES,
  TARGET_NAMES,
} from "../../api/types";
import type {
  BuildEntryOption,
  ChunkMode,
  ChunkOutputType,
  LanguageOut,
  ResolvedChunkOutputType,
} from "../../api/types";
import type { InternalBuildOptions, ResolvedBuildOptions } from "../types";
import { hasErrorCode, requireChoice } from "../../shared/validation";

export function normalizeBuildOptions(
  options: InternalBuildOptions,
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
  const chunkManifestFile = normalizeManifestFile(
    options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile,
  );
  const chunkMode = requireChoice(
    options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
    CHUNK_MODES,
    "chunks.mode",
  );
  const chunkOutputType = requireChoice(
    options.chunks?.outputType ?? DEFAULT_BUILD_OPTIONS.chunks.outputType,
    CHUNK_OUTPUT_TYPES,
    "chunks.outputType",
  );
  const languageOut = requireChoice(
    options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    LANGUAGE_OUTPUTS,
    "languageOut",
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
      mode: chunkMode,
      outputType: chunkOutputType,
      publicPath: chunkPublicPath,
      vendorChunk: resolveVendorChunk({
        chunkMode,
        languageOut,
        outputType: chunkOutputType,
        vendorChunk: options.chunks?.vendorChunk,
      }),
    },
    compat: {
      classMapCalls: [...(options.compat?.classMapCalls ?? [])].map((call) => ({
        argIndex: call.argIndex,
        callee: call.callee,
        ...(call.calleeModulePattern === undefined
          ? {}
          : { calleeModulePattern: call.calleeModulePattern }),
        ...(call.keySource === undefined ? {} : { keySource: call.keySource }),
        ...(call.keyExcludePattern === undefined
          ? {}
          : { keyExcludePattern: call.keyExcludePattern }),
        ...(call.keyPattern === undefined
          ? {}
          : { keyPattern: call.keyPattern }),
        ...(call.stringLiteralArgIndex === undefined
          ? {}
          : { stringLiteralArgIndex: call.stringLiteralArgIndex }),
      })),
      pureCallees: [...(options.compat?.pureCallees ?? [])],
    },
    compilationLevel: requireChoice(
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
      COMPILATION_LEVELS,
      "compilationLevel",
    ),
    cssRuntime: options.cssRuntime ?? false,
    diagnostics: {
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
    languageOut,
    outDir,
    packages: requireChoice(
      options.packages ?? DEFAULT_BUILD_OPTIONS.packages,
      PACKAGE_MODES,
      "packages",
    ),
    platformExterns: requireChoice(
      options.platformExterns ?? DEFAULT_BUILD_OPTIONS.platformExterns,
      PLATFORM_EXTERNS_MODES,
      "platformExterns",
    ),
    projectRoot,
    srcDir,
    target: requireChoice(
      options.target ?? DEFAULT_BUILD_OPTIONS.target,
      TARGET_NAMES,
      "target",
    ),
    typedExterns: [...(options.typedExterns ?? [])].map((filePath) =>
      path.isAbsolute(filePath)
        ? filePath
        : path.resolve(projectRoot, filePath),
    ),
    typeMetadata: options.typeMetadata,
  };
}

/**
 * What `chunks.outputType: "auto"` resolves to once the gates below pass.
 *
 * `esm`. Measured on the Svelte example: 120,762 -> 115,049 raw and
 * 41,015 -> 40,262 gzip purely from dropping the per-chunk IIFE wrapper and
 * the `$gcc.` namespace prefix on every cross-chunk reference. Chunk file
 * names are derived from the chunk name, not from content, so the `import`
 * specifiers a sibling chunk embeds are stable across app edits and need no
 * placeholder pass; the Vite plugin owns its own hashing and HTML rewrite,
 * and standalone consumers load the entry with `<script type="module">`.
 */
const AUTO_CHUNK_OUTPUT_TYPE: ResolvedChunkOutputType = "esm";

/**
 * Applies the gates for chunk output shape.
 *
 * `esm` needs all three of: a chunked mode (`bundler-runtime` or `split` — the
 * ones with a chunk graph and a manifest; they share one emission path, so they
 * resolve identically here), an output level that can actually run
 * `import`/`export` (Closure happily emits ES5 bodies *with* `import`
 * statements, so this gate is ours), and a consumer that loads the entry as a
 * module. Worker bundles and anything embedded with a plain `<script>` stay on
 * `script`. The gates outrank an explicit `esm` request, so a forced-script
 * consumer can never be handed module output.
 */
export function resolveChunkOutputType({
  chunkMode,
  languageOut,
  outputType,
  worker = false,
}: {
  chunkMode: ChunkMode;
  languageOut: LanguageOut;
  outputType: ChunkOutputType;
  worker?: boolean;
}): ResolvedChunkOutputType {
  if (
    chunkMode === "off" ||
    worker ||
    languageOut === "ECMASCRIPT3" ||
    languageOut === "ECMASCRIPT5"
  ) {
    return "script";
  }
  return outputType === "auto" ? AUTO_CHUNK_OUTPUT_TYPE : outputType;
}

/**
 * Applies the gates for the vendor chunk.
 *
 * **Opt-in only.** `auto` resolves to `false`; nothing but an explicit
 * `vendorChunk: true` turns the split on. The split trades first-load bytes
 * for repeat-visit stability, and which side wins depends on traffic the
 * bundler cannot see, so it is not a default we can pick for anyone. Measured
 * on the Svelte example: 29,796 B gzip split versus 27,570 B unsplit, against
 * a ~12.5 KB gzip vendor chunk that then survives every app-only deploy in
 * the browser cache. See docs/vite.md.
 *
 * The gates below still apply on top of an explicit `true`: the split only
 * works under ES module output, where the base chunk's file name is embedded
 * in every sibling's `import` statement and an app edit therefore cascades
 * new names through the whole graph. Script-mode chunks reference each other
 * through the manifest instead, so there is nothing to stabilise and an extra
 * chunk is pure overhead; `off`/`split` have no chunk graph at all.
 */
export function resolveVendorChunk({
  chunkMode,
  languageOut,
  outputType,
  vendorChunk = "auto",
  worker = false,
}: {
  chunkMode: ChunkMode;
  languageOut: LanguageOut;
  outputType: ChunkOutputType;
  vendorChunk?: boolean | "auto" | undefined;
  worker?: boolean;
}): boolean {
  if (vendorChunk !== true) {
    return false;
  }
  if (chunkMode === "off") {
    return false;
  }
  return (
    resolveChunkOutputType({ chunkMode, languageOut, outputType, worker }) ===
    "esm"
  );
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

function normalizeManifestFile(filePath: string) {
  if (filePath.length === 0) {
    return "";
  }
  const normalized = filePath.replace(/\\/gu, "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(filePath) ||
    normalized.endsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new TypeError(
      `chunks.manifestFile must be a safe relative file path. Received ${JSON.stringify(filePath)}.`,
    );
  }
  const relativePath = path.posix.normalize(normalized).replace(/^\.\//u, "");
  if (!relativePath || relativePath === ".") {
    throw new TypeError(
      `chunks.manifestFile must be a safe relative file path. Received ${JSON.stringify(filePath)}.`,
    );
  }
  return relativePath;
}

export async function validateOutputPathBoundaries(
  options: ResolvedBuildOptions,
  cacheWorkspaceDir: string | null,
  extraInputPaths: string[] = [],
) {
  const outDir = await canonicalPath(options.outDir);
  const protectedInputs = [
    ["projectRoot", options.projectRoot],
    ["srcDir", options.srcDir],
    ...options.entries.map(
      (entry, index) => [`entries[${index}]`, entry.file] as const,
    ),
    ...options.externs.map(
      (filePath, index) => [`externs[${index}]`, filePath] as const,
    ),
    ...options.js.map((filePath, index) => [`js[${index}]`, filePath] as const),
    ...options.typedExterns.map(
      (filePath, index) => [`typedExterns[${index}]`, filePath] as const,
    ),
    ...extraInputPaths.map(
      (filePath, index) => [`resolved input ${index + 1}`, filePath] as const,
    ),
  ] as const;

  for (const [label, inputPath] of protectedInputs) {
    const canonicalInput = await canonicalPath(inputPath);
    if (isSameOrDescendant(canonicalInput, outDir)) {
      throw new TypeError(
        `Unsafe outDir ${JSON.stringify(options.outDir)}: it contains ${label} ${JSON.stringify(inputPath)}.`,
      );
    }
  }

  if (cacheWorkspaceDir) {
    const workspaceDir = await canonicalPath(cacheWorkspaceDir);
    if (isSameOrDescendant(workspaceDir, outDir)) {
      throw new TypeError(
        `Unsafe outDir ${JSON.stringify(options.outDir)}: it contains the selected cache workspace ${JSON.stringify(cacheWorkspaceDir)}.`,
      );
    }
  }
}

async function canonicalPath(filePath: string) {
  const suffix: string[] = [];
  let current = path.resolve(filePath);
  for (;;) {
    try {
      const resolved = await fs.realpath(current);
      return path.join(resolved, ...suffix);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(filePath);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSameOrDescendant(candidatePath: string, parentPath: string) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
