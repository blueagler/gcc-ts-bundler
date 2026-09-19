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
    options.srcDir ?? DEFAULT_BUILD_OPTIONS.srcDir,
  );
  const outDir = path.resolve(
    projectRoot,
    options.outDir ?? DEFAULT_BUILD_OPTIONS.outDir,
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
  const entries = options.entries.map((entry) => normalizeEntry(entry, srcDir));
  const entryPaths = new Set(entries.map((entry) => entry.file));

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
    finalMinify: options.finalMinify ?? true,
    rollupChunks: options.rollupChunks ?? [],
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
    hideWarningsFor:
      options.hideWarningsFor === undefined
        ? DEFAULT_BUILD_OPTIONS.hideWarningsFor
        : [...options.hideWarningsFor],
    entries,
    externals: normalizeExternalSpecifiers(options.externals ?? []),
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
    preserveModules: normalizePreserveModules(
      options.preserveModules ?? [],
      projectRoot,
      srcDir,
    ),
    projectRoot,
    srcDir,
    target: requireChoice(
      options.target ?? DEFAULT_BUILD_OPTIONS.target,
      TARGET_NAMES,
      "target",
    ),
    typedExterns: (options.typedExterns ?? []).map((extern, index) => {
      if (typeof extern === "string") {
        return { path: path.resolve(projectRoot, extern), entryFiles: [] };
      }
      if (
        !extern ||
        typeof extern.path !== "string" ||
        !Array.isArray(extern.entries) ||
        extern.entries.length === 0
      ) {
        throw new TypeError(
          `typedExterns[${index}] must provide a path and nonempty entries scope.`,
        );
      }
      const entryFiles = extern.entries.map((entry) => {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new TypeError(
            `typedExterns[${index}].entries must contain entry paths.`,
          );
        }
        const file = path.resolve(projectRoot, entry);
        if (!entryPaths.has(file)) {
          throw new TypeError(
            `typedExterns[${index}] scope ${JSON.stringify(entry)} is not a configured build entry.`,
          );
        }
        return file;
      });
      return {
        path: path.resolve(projectRoot, extern.path),
        entryFiles: [...new Set(entryFiles)].sort(),
      };
    }),
    typeMetadata: options.typeMetadata,
    authoredFiles: options.authoredFiles,
    viteRuntimeSourceMapFile: options.viteRuntimeSourceMapFile
      ? path.resolve(projectRoot, options.viteRuntimeSourceMapFile)
      : undefined,
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
 * placeholder pass; the Vite plugin owns HTML emission and chunk naming,
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
function normalizeExternalSpecifiers(specifiers: readonly string[]) {
  return [...new Set(specifiers.map((specifier) => specifier.trim()))]
    .map((specifier) => {
      if (
        !specifier ||
        specifier.startsWith(".") ||
        specifier.startsWith("/")
      ) {
        throw new Error(
          `externals entries must be non-relative module specifiers, got ${JSON.stringify(specifier)}.`,
        );
      }
      return specifier;
    })
    .sort((left, right) => left.localeCompare(right));
}

function normalizePreserveModules(
  modules: readonly string[],
  projectRoot: string,
  srcDir: string,
) {
  const resolvedSrcDir = path.resolve(srcDir);
  return [
    ...new Set(
      modules.map((modulePath) => path.resolve(projectRoot, modulePath)),
    ),
  ]
    .map((modulePath) => {
      const relative = path.relative(resolvedSrcDir, modulePath);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(
          `preserveModules path must be inside srcDir: ${modulePath}`,
        );
      }
      return modulePath;
    })
    .sort((left, right) => left.localeCompare(right));
}

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
    worker ||
    languageOut === "ECMASCRIPT3" ||
    languageOut === "ECMASCRIPT5"
  ) {
    return "script";
  }
  if (chunkMode === "off") {
    return outputType === "esm" ? "esm" : "script";
  }
  return outputType === "auto" ? AUTO_CHUNK_OUTPUT_TYPE : outputType;
}

/**
 * Applies the gates for the vendor chunk.
 *
 * Only explicit `true` enables this partition, and only for chunked ESM.
 * `auto` is off. Separating dependencies can reduce invalidation across app
 * edits but adds another chunk; output-name stability is not guaranteed.
 * Public behavior: docs/reference/api.md#chunk-options.
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
  const outFile =
    typeof entry === "string" || entry.outFile === undefined
      ? undefined
      : entry.outFile;
  return {
    file: path.resolve(srcDir, file),
    name,
    ...(outFile === undefined ? {} : { outFile }),
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
  cacheRootDir: string | null = null,
  outputNames: string[] = [],
) {
  await canonicalizePreservedModules(options);
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
      (extern, index) => [`typedExterns[${index}]`, extern.path] as const,
    ),
    ...(options.typeMetadata?.dependencies ?? []).map(
      (filePath, index) =>
        [`typeMetadata dependency ${index + 1}`, filePath] as const,
    ),
    ...(options.authoredFiles ?? []).map(
      (filePath, index) => [`authoredFiles[${index}]`, filePath] as const,
    ),
    ...(options.viteRuntimeSourceMapFile
      ? [["runtime source map", options.viteRuntimeSourceMapFile] as const]
      : []),
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
    if (
      isSameOrDescendant(workspaceDir, outDir) ||
      isSameOrDescendant(outDir, workspaceDir)
    ) {
      throw new TypeError(
        `Unsafe outDir ${JSON.stringify(options.outDir)}: it contains the selected cache workspace ${JSON.stringify(cacheWorkspaceDir)}.`,
      );
    }
  }
  const cacheRoot = cacheRootDir ? await canonicalPath(cacheRootDir) : null;
  if (cacheRoot && isSameOrDescendant(outDir, cacheRoot)) {
    throw new TypeError(
      `Unsafe outDir ${JSON.stringify(options.outDir)}: it is inside the selected cache.`,
    );
  }
  const destinations = await Promise.all(
    options.entries.map(async (entry) =>
      entry.outFile === undefined
        ? null
        : canonicalPath(path.resolve(options.projectRoot, entry.outFile)),
    ),
  );
  const canonicalOutputs = await Promise.all(
    outputNames.map((name) => canonicalPath(path.join(options.outDir, name))),
  );
  const canonicalInputs = await Promise.all(
    protectedInputs.map(async ([label, inputPath]) => ({
      label,
      inputPath,
      canonical: await canonicalPath(inputPath),
    })),
  );
  const srcDir = await canonicalPath(options.srcDir);
  const workspace = cacheWorkspaceDir
    ? await canonicalPath(cacheWorkspaceDir)
    : null;
  for (const [index, destination] of destinations.entries()) {
    if (!destination) continue;
    const unsafe = (reason: string) => {
      throw new TypeError(
        `Unsafe outFile ${JSON.stringify(options.entries[index]?.outFile)}: ${reason}.`,
      );
    };
    for (const input of canonicalInputs) {
      if (isSameOrDescendant(input.canonical, destination))
        unsafe(`it contains ${input.label} ${JSON.stringify(input.inputPath)}`);
    }
    if (isSameOrDescendant(destination, srcDir)) unsafe("it is inside srcDir");
    if (
      cacheRoot &&
      (isSameOrDescendant(destination, cacheRoot) ||
        isSameOrDescendant(cacheRoot, destination))
    )
      unsafe("it overlaps the selected cache");
    if (
      workspace &&
      (isSameOrDescendant(destination, workspace) ||
        isSameOrDescendant(workspace, destination))
    )
      unsafe("it overlaps the selected cache workspace");
    for (const [otherIndex, other] of destinations.entries()) {
      if (
        other &&
        otherIndex !== index &&
        (isSameOrDescendant(destination, other) ||
          isSameOrDescendant(other, destination))
      )
        unsafe("it overlaps another outFile");
    }
    for (const [otherIndex, output] of canonicalOutputs.entries()) {
      if (
        otherIndex !== index &&
        (isSameOrDescendant(destination, output) ||
          isSameOrDescendant(output, destination))
      )
        unsafe("it overlaps another output");
    }
    if (destination === outDir || isSameOrDescendant(outDir, destination))
      unsafe("it contains outDir");
  }
}

async function canonicalizePreservedModules(options: ResolvedBuildOptions) {
  if (options.preserveModules.length === 0) {
    return;
  }
  const [projectRoot, srcDir] = await Promise.all([
    fs.realpath(options.projectRoot),
    fs.realpath(options.srcDir),
  ]);
  const canonicalModules = await Promise.all(
    options.preserveModules.map(async (modulePath) => {
      const realModulePath = await fs.realpath(modulePath);
      if (
        !isSameOrDescendant(realModulePath, projectRoot) ||
        !isSameOrDescendant(realModulePath, srcDir)
      ) {
        throw new TypeError(
          `preserveModules path resolves outside projectRoot or srcDir: ${modulePath} -> ${realModulePath}`,
        );
      }
      const canonicalLexicalPath = path.resolve(
        srcDir,
        path.relative(options.srcDir, modulePath),
      );
      if (path.relative(canonicalLexicalPath, realModulePath) !== "") {
        throw new TypeError(
          `preserveModules symlink aliases are unsupported: ${modulePath} -> ${realModulePath}`,
        );
      }
      return realModulePath;
    }),
  );
  options.preserveModules = [...new Set(canonicalModules)].sort((left, right) =>
    left.localeCompare(right),
  );
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
