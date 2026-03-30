#!/usr/bin/env node
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};

// src/cli/usage.ts
function usage() {
  console.error(`Usage: gcc-ts-bundler <command> [options]

Example:
  gcc-ts-bundler build --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist
  gcc-ts-bundler clean-cache --project-root=.

Commands:
  build               Build the requested entries
  clean-cache         Remove the persistent cache for a project root

Build flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Output directory
  --language-out        ECMASCRIPT3 | ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT_NEXT
  --compilation-level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --cache-mode          off | temp | persistent
  --cache-dir           Explicit cache directory
  --preflight           off | errors-only | full
  --verbose             Print verbose diagnostics
  --fatal-warnings      Treat typed transpile warnings as fatal
  -h, --help            Show this help message

Deprecated aliases still accepted for one transition release:
  --src_dir --entry_point --output_dir --language_out --compilation_level
  --fatal_warnings --preserve_cache
`);
}

// src/cli/parse-options.ts
var import_minimist = __toESM(require("minimist"));

// src/api/types.ts
var DEFAULT_BUILD_OPTIONS = Object.freeze({
  cache: {
    dir: "",
    mode: "persistent"
  },
  compilationLevel: "ADVANCED",
  diagnostics: {
    fatalWarnings: false,
    preflight: "errors-only",
    verbose: false
  },
  entries: [],
  externs: [],
  js: [],
  languageOut: "ECMASCRIPT_NEXT",
  outDir: "",
  outputNames: [],
  projectRoot: "",
  srcDir: ""
});

// src/cli/parse-options.ts
function asStringArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
function parseCliArgs(args) {
  const parsedArgs = import_minimist.default(args, {
    alias: {
      h: "help"
    },
    boolean: ["fatal-warnings", "help", "verbose"],
    string: [
      "cache-dir",
      "cache-mode",
      "compilation-level",
      "entry",
      "entry-point",
      "language-out",
      "out-dir",
      "preflight",
      "project-root",
      "src-dir"
    ]
  });
  if (parsedArgs.help) {
    return { options: { entries: [] }, showHelp: true };
  }
  const entries = asStringArray(parsedArgs.entry ?? parsedArgs.entry_point ?? parsedArgs.entryPoint);
  return {
    options: {
      cache: {
        dir: parsedArgs["cache-dir"] ?? parsedArgs.cache_dir,
        mode: parsedArgs["cache-mode"] ?? parsedArgs.cache_mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
      },
      compilationLevel: parsedArgs["compilation-level"] ?? parsedArgs.compilation_level ?? parsedArgs.compilationLevel,
      diagnostics: {
        fatalWarnings: Boolean(parsedArgs["fatal-warnings"] ?? parsedArgs.fatal_warnings ?? parsedArgs.fatalWarnings),
        preflight: parsedArgs.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
        verbose: Boolean(parsedArgs.verbose)
      },
      entries,
      externs: asStringArray(parsedArgs.externs),
      js: asStringArray(parsedArgs.js),
      languageOut: parsedArgs["language-out"] ?? parsedArgs.language_out ?? parsedArgs.languageOut,
      outDir: parsedArgs["out-dir"] ?? parsedArgs.output_dir ?? parsedArgs.outputDir,
      projectRoot: parsedArgs["project-root"] ?? parsedArgs.project_root,
      srcDir: parsedArgs["src-dir"] ?? parsedArgs.src_dir ?? parsedArgs.srcDir
    },
    showHelp: false
  };
}

// src/pipeline/build-pipeline.ts
var import_path6 = __toESM(require("path"));
var import_fs6 = __toESM(require("fs"));

// src/cache/hash.ts
var import_crypto = __toESM(require("crypto"));
function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, nestedValue]) => typeof nestedValue !== "function").sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]));
  }
  return value;
}
function hashContent(content) {
  return import_crypto.default.createHash("sha256").update(content).digest("hex");
}
function hashJson(value) {
  return hashContent(JSON.stringify(normalizeValue(value)));
}

// src/cache/store.ts
var import_fs = __toESM(require("fs"));
var import_os = __toESM(require("os"));
var import_path = __toESM(require("path"));
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return import_path.default.join(import_os.default.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return import_path.default.join(process.env.LOCALAPPDATA ?? import_path.default.join(import_os.default.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return import_path.default.join(process.env.XDG_CACHE_HOME ?? import_path.default.join(import_os.default.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await import_fs.default.promises.mkdtemp(import_path.default.join(import_os.default.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = import_path.default.join(rootDir2, "workspace");
    await import_fs.default.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await import_fs.default.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = import_path.default.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path.default.join(rootDir, hashContent(projectRoot));
  const workspaceDir = import_path.default.join(projectCacheDir, "workspace");
  await import_fs.default.promises.mkdir(workspaceDir, { recursive: true });
  return {
    async cleanup() {},
    mode,
    projectCacheDir,
    rootDir,
    workspaceDir
  };
}
async function readJsonIfExists(filePath) {
  try {
    const raw = await import_fs.default.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function writeJson(filePath, value) {
  await ensureDirectoryExistence(filePath);
  await import_fs.default.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
async function ensureDirectoryExistence(filePath) {
  const dirName = import_path.default.dirname(filePath);
  if (await import_fs.default.promises.access(dirName).then(() => true).catch(() => false)) {
    return;
  }
  await import_fs.default.promises.mkdir(dirName, { recursive: true });
}

// src/internal/file-state.ts
var import_fs3 = __toESM(require("fs"));
var import_path2 = __toESM(require("path"));

// src/native/load.ts
var import_fs2 = __toESM(require("fs"));
var import_module = require("module");
var require2 = import_module.createRequire("file:///Users/Blueagle/Code/gcc-ts-bundler/src/native/load.ts");
var cachedBinding = null;
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  const nativeModulePath = require2.resolve("gcc-ts-bundler/native");
  if (!import_fs2.default.existsSync(nativeModulePath)) {
    throw new Error(`Native module not found at ${nativeModulePath}. Run \`bun run build:native\` in gcc-ts-bundler.`);
  }
  cachedBinding = require2(nativeModulePath);
  return cachedBinding;
}
function resolveGraph(input) {
  const result = loadBinding().resolveGraph(input.entries, input.srcDir, input.workspaceDir);
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(result.fileHashes.map((entry) => [entry.filePath, entry.hash])),
    filePaths: result.filePaths,
    graph: Object.fromEntries(result.graph.map((entry) => [entry.filePath, entry.dependencies]))
  };
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.workspaceDir);
}
function writeEntryShims(input) {
  return loadBinding().writeEntryShims(input.entries);
}
function collectFileStates(filePaths) {
  return loadBinding().collectFileStates(filePaths);
}
function matchFileStates(expected) {
  return loadBinding().matchFileStates(expected);
}

// src/internal/file-state.ts
function uniqueSorted(filePaths) {
  return [...new Set(filePaths)].sort((left, right) => left.localeCompare(right));
}
async function collectTrackedFiles(filePaths) {
  const states = collectFileStates(uniqueSorted(filePaths));
  return Object.fromEntries(states.filter((state) => state.exists).map((state) => [
    state.filePath,
    {
      mtimeMs: state.mtimeMs,
      size: state.size
    }
  ]));
}
async function trackedFilesMatch(trackedFiles) {
  return matchFileStates(Object.entries(trackedFiles).map(([filePath, state]) => ({
    exists: true,
    filePath,
    mtimeMs: state.mtimeMs,
    size: state.size
  })));
}
async function filesExist(filePaths) {
  return collectFileStates(uniqueSorted(filePaths)).every((state) => state.exists);
}
async function publishedOutputsMatch(outputFiles, outDir) {
  try {
    const outEntries = (await import_fs3.default.promises.readdir(outDir)).sort();
    const expectedEntries = outputFiles.map((outputFile) => import_path2.default.basename(outputFile)).sort();
    if (outEntries.length !== expectedEntries.length || outEntries.some((entry, index) => entry !== expectedEntries[index])) {
      return false;
    }
    const destinationFiles = outputFiles.map((outputFile) => import_path2.default.join(outDir, import_path2.default.basename(outputFile)));
    const states = collectFileStates([...outputFiles, ...destinationFiles]);
    const stateMap = new Map(states.map((state) => [state.filePath, state]));
    return outputFiles.every((outputFile, index) => {
      const sourceState = stateMap.get(outputFile);
      const destinationState = stateMap.get(destinationFiles[index]);
      return sourceState?.exists === true && destinationState?.exists === true && sourceState.size === destinationState.size;
    });
  } catch {
    return false;
  }
}
async function publishedOutputsMatchSnapshot(publishedOutputs, outDir) {
  try {
    const outEntries = (await import_fs3.default.promises.readdir(outDir)).sort();
    const expectedEntries = publishedOutputs.map(({ name }) => name).sort();
    if (outEntries.length !== expectedEntries.length || outEntries.some((entry, index) => entry !== expectedEntries[index])) {
      return false;
    }
    const states = collectFileStates(publishedOutputs.map(({ name }) => import_path2.default.join(outDir, name)));
    const stateMap = new Map(states.map((state) => [state.filePath, state]));
    return publishedOutputs.every(({ name, size }) => {
      const state = stateMap.get(import_path2.default.join(outDir, name));
      return state?.exists === true && state.size === size;
    });
  } catch {
    return false;
  }
}
async function collectPublishedOutputStats(outputFiles) {
  const states = collectFileStates(outputFiles);
  return states.filter((state) => state.exists).map((state) => ({
    name: import_path2.default.basename(state.filePath),
    size: state.size
  })).sort((left, right) => left.name.localeCompare(right.name));
}
async function copyOrLinkFiles(sourceFiles, outDir) {
  await import_fs3.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs3.default.promises.mkdir(outDir, { recursive: true });
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = import_path2.default.join(outDir, import_path2.default.basename(sourceFile));
    try {
      await import_fs3.default.promises.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await import_fs3.default.promises.copyFile(sourceFile, destinationFile);
    }
  }));
}

// src/pipeline/resolve-build.ts
var import_fs4 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
var import_typescript = __toESM(require("typescript"));
var import_url = require("url");
async function createBuildContext(options) {
  const packageRoot = getPackageRoot();
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot,
    packageSignature: await getPackageSignature(packageRoot),
    projectCacheDir: import_path3.default.join(import_path3.default.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), hashContent(options.projectRoot))
  };
}
async function resolveBuild(context) {
  const { options } = context;
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }
  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot
  });
  const sourceRoot = import_path3.default.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = await hashTsConfig(tsConfigPath);
  const entryRelativePaths = options.entries.map((entry) => import_path3.default.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => import_path3.default.join(sourceRoot, import_path3.default.relative(options.srcDir, entry)));
  const resolveSnapshotPath = import_path3.default.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = await readJsonIfExists(resolveSnapshotPath);
  if (cachedSnapshot && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => ({
      chunkName: entry.chunkName,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: entry.outputName,
      sourcePath: import_path3.default.join(sourceRoot, entry.sourceRelativePath),
      sourceRelativePath: entry.sourceRelativePath
    }));
    const shimDir2 = import_path3.default.join(cacheStore.workspaceDir, "entries");
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      filePaths: cachedSnapshot.filePaths,
      finalCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: entryFiles2.map((entry) => import_path3.default.join(shimDir2, `${entry.chunkName}.ts`)),
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir
    };
  }
  const graphResult = resolveGraph({
    entries: overlayEntries,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir
  });
  const outputNames = resolveOutputNames(entryRelativePaths, options.outputNames);
  const resolveKey = hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature
  });
  const resolveMetadataPath = import_path3.default.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = await readJsonIfExists(resolveMetadataPath);
  if (!resolveMetadata) {
    const entryFiles2 = graphResult.entries.map((entry, index) => ({
      chunkName: sanitizeChunkName(outputNames[index]),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: outputNames[index],
      sourcePath: entry.sourcePath,
      sourceRelativePath: import_path3.default.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = import_path3.default.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = entryFiles2.map((entry) => import_path3.default.join(shimDir2, `${entry.chunkName}.ts`));
    resolveMetadata = {
      chunkPlan: buildChunkPlan({
        entryFiles: entryFiles2,
        graph: {
          ...graphResult.graph,
          ...Object.fromEntries(shimFiles2.map((shimFile, index) => [
            shimFile,
            [entryFiles2[index].sourcePath]
          ]))
        },
        shimFiles: shimFiles2,
        workspaceDir: cacheStore.workspaceDir
      }),
      entryFiles: entryFiles2.map((entry) => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath
      }))
    };
    await writeJson(resolveMetadataPath, resolveMetadata);
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => ({
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: import_path3.default.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  }));
  const shimDir = import_path3.default.join(cacheStore.workspaceDir, "entries");
  const shimFiles = entryFiles.map((entry) => import_path3.default.join(shimDir, `${entry.chunkName}.ts`));
  const nativeEmitKey = hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    packageSignature: context.packageSignature,
    resolveKey
  });
  const finalKey = hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash: await hashExternalInputs([
      ...options.externs,
      ...options.js
    ]),
    languageOut: options.languageOut,
    packageSignature: context.packageSignature,
    resolveKey
  });
  const trackedFiles = await collectTrackedFiles([
    ...graphResult.filePaths,
    tsConfigPath,
    ...options.externs,
    ...options.js
  ]);
  await writeJson(resolveSnapshotPath, {
    compilerOptionsHash,
    entryFiles: resolveMetadata.entryFiles,
    finalKey,
    filePaths: graphResult.filePaths,
    nativeEmitKey,
    optionsSignature: context.optionsSignature,
    packageSignature: context.packageSignature,
    resolveKey,
    trackedFiles
  });
  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    filePaths: graphResult.filePaths,
    finalCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  };
}
function resolveOutputNames(entryPaths, outputNames) {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }
    return outputNames;
  }
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => import_path3.default.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return entryPaths.map((entryPath, index) => {
    const basename = basenames[index];
    if ((basenameCounts.get(basename) ?? 0) === 1) {
      return basename;
    }
    return `${entryPath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
  });
}
function sanitizeChunkName(outputName) {
  return outputName.replace(/\.js$/, "").replace(/[^\w-]/g, "-");
}
async function ensureSourceSymlink(linkPath, targetPath) {
  try {
    const currentTarget = await import_fs4.default.promises.readlink(linkPath);
    if (import_path3.default.resolve(import_path3.default.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await import_fs4.default.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await import_fs4.default.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await import_fs4.default.promises.mkdir(import_path3.default.dirname(linkPath), { recursive: true });
  await import_fs4.default.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = import_typescript.default.findConfigFile(projectRoot, import_typescript.default.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function hashTsConfig(configPath) {
  return hashContent(await import_fs4.default.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await import_fs4.default.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = import_path3.default.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
function buildChunkPlan({
  entryFiles,
  graph,
  shimFiles,
  workspaceDir
}) {
  const shimToEntry = new Map(shimFiles.map((shimFile, index) => [shimFile, entryFiles[index]]));
  const reachability = new Map;
  const counts = new Map;
  for (const shimFile of shimFiles) {
    const reachable = walkReachableFiles(shimFile, graph);
    reachability.set(shimFile, reachable);
    for (const filePath of reachable) {
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
    }
  }
  const sharedFiles = new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([filePath]) => filePath));
  const chunks = [];
  if (entryFiles.length === 1) {
    const [onlyEntry] = entryFiles;
    const [onlyShim] = shimFiles;
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(topologicalSort(Array.from(reachability.get(onlyShim) ?? []), graph), workspaceDir),
      name: stripExtension(onlyEntry.outputName)
    });
    return chunks;
  }
  if (sharedFiles.size > 0) {
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(topologicalSort(Array.from(sharedFiles), graph), workspaceDir),
      name: "shared"
    });
  }
  for (const shimFile of shimFiles) {
    const entry = shimToEntry.get(shimFile);
    const reachable = reachability.get(shimFile) ?? new Set;
    const uniqueFiles = Array.from(reachable).filter((filePath) => !sharedFiles.has(filePath));
    chunks.push({
      dependencies: sharedFiles.size > 0 ? ["shared"] : [],
      files: toRelativeFiles(topologicalSort(uniqueFiles, graph), workspaceDir),
      name: stripExtension(entry.outputName)
    });
  }
  return chunks;
}
function walkReachableFiles(entryFile, graph) {
  const reachable = new Set;
  const pending = [entryFile];
  while (pending.length > 0) {
    const current = pending.pop();
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const dependency of graph[current] ?? []) {
      pending.push(dependency);
    }
  }
  return reachable;
}
function topologicalSort(files, graph) {
  const fileSet = new Set(files);
  const visited = new Set;
  const ordered = [];
  function visit(filePath) {
    if (visited.has(filePath)) {
      return;
    }
    visited.add(filePath);
    for (const dependency of graph[filePath] ?? []) {
      if (fileSet.has(dependency)) {
        visit(dependency);
      }
    }
    ordered.push(filePath);
  }
  [...files].sort((left, right) => left.localeCompare(right)).forEach(visit);
  return ordered;
}
function toRelativeFiles(files, workspaceDir) {
  const seenEmittedPaths = new Set;
  const relativeFiles = [];
  for (const filePath of files) {
    if (filePath.endsWith(".d.ts")) {
      continue;
    }
    const relativeFile = import_path3.default.relative(workspaceDir, filePath);
    const emittedRelativeFile = relativeFile.replace(/\.[^/.]+$/, ".js");
    if (seenEmittedPaths.has(emittedRelativeFile)) {
      continue;
    }
    seenEmittedPaths.add(emittedRelativeFile);
    relativeFiles.push(relativeFile);
  }
  return relativeFiles;
}
function stripExtension(filePath) {
  return filePath.replace(/\.[^/.]+$/, "");
}
function getPackageRoot() {
  return import_path3.default.dirname(import_path3.default.dirname(import_url.fileURLToPath("file:///Users/Blueagle/Code/gcc-ts-bundler/src/pipeline/resolve-build.ts")));
}
async function readRuntimeSignature(packageRoot) {
  try {
    const stat = await import_fs4.default.promises.stat(import_path3.default.join(packageRoot, "dist", "index.mjs"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot) {
  try {
    const stat = await import_fs4.default.promises.stat(import_path3.default.join(packageRoot, "native", "index.node"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
var packageSignaturePromise = null;
async function getPackageSignature(packageRoot = getPackageRoot()) {
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await import_fs4.default.promises.stat(import_path3.default.join(packageRoot, "package.json"));
      const runtimeSignature = await readRuntimeSignature(packageRoot);
      const nativeSignature = await readNativeSignature(packageRoot);
      return hashContent(JSON.stringify({
        nativeSignature,
        packageJson: {
          mtimeMs: packageJsonStat.mtimeMs,
          size: packageJsonStat.size
        },
        runtimeSignature
      }));
    })();
  }
  return packageSignaturePromise;
}
function getOptionsSignature(options) {
  return hashJson({
    compilationLevel: options.compilationLevel,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => import_path3.default.relative(options.srcDir, entry)),
    externs: [...options.externs].sort(),
    js: [...options.js].sort(),
    languageOut: options.languageOut,
    outDir: options.outDir,
    outputNames: [...options.outputNames],
    projectRoot: options.projectRoot,
    srcDir: options.srcDir
  });
}
function normalizeBuildOptions(options) {
  const projectRoot = import_path3.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path3.default.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = import_path3.default.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  return {
    cache: {
      dir: options.cache?.dir ? import_path3.default.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
    },
    compilationLevel: options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight: options.diagnostics?.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose: options.diagnostics?.verbose ?? DEFAULT_BUILD_OPTIONS.diagnostics.verbose
    },
    entries: options.entries.map((entry) => import_path3.default.isAbsolute(entry) ? entry : import_path3.default.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => import_path3.default.isAbsolute(filePath) ? filePath : import_path3.default.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => import_path3.default.isAbsolute(filePath) ? filePath : import_path3.default.resolve(projectRoot, filePath)),
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    outputNames: [...options.outputNames ?? []],
    projectRoot,
    srcDir
  };
}

// src/stages/native/emit.ts
var import_fs5 = __toESM(require("fs"));
var import_path4 = __toESM(require("path"));
var import_typescript2 = __toESM(require("typescript"));
async function emitNativeStage({
  cacheDir,
  fileNames,
  metadataPath,
  options,
  tsConfigPath,
  workspaceDir
}) {
  const outDir = import_path4.default.join(cacheDir, "out");
  const externsPath = import_path4.default.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readMetadata(metadataPath);
  if (cachedMetadata && await filesExist([
    cachedMetadata.externsPath,
    ...cachedMetadata.emittedFiles
  ])) {
    return {
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir
    };
  }
  await import_fs5.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs5.default.promises.mkdir(outDir, { recursive: true });
  const diagnostics = getPreflightDiagnostics({
    fileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir
  });
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir
    };
  }
  const result = transpileSources({
    externsPath,
    fileNames,
    outDir,
    workspaceDir
  });
  await import_fs5.default.promises.writeFile(metadataPath, JSON.stringify({
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath
  }, null, 2), "utf-8");
  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir
  };
}
function getPreflightDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir
}) {
  if (preflight === "off") {
    return [];
  }
  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates.filter((state) => !state.exists).map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(`Missing required build input(s): ${missingFiles.join(", ")}`)
    ];
  }
  if (preflight !== "full") {
    return [];
  }
  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const finalCompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    moduleResolution: import_typescript2.default.ModuleResolutionKind.Bundler,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript2.default.ScriptTarget.ESNext
  };
  const compilerHost = import_typescript2.default.createCompilerHost(finalCompilerOptions);
  const program = import_typescript2.default.createProgram(fileNames, finalCompilerOptions, compilerHost);
  return [...import_typescript2.default.getPreEmitDiagnostics(program)];
}
function loadCompilerOptions(configPath) {
  const configFile = import_typescript2.default.readConfigFile(configPath, import_typescript2.default.sys.readFile);
  if (configFile.error) {
    throw new Error(import_typescript2.default.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = import_typescript2.default.parseJsonConfigFileContent(configFile.config, import_typescript2.default.sys, import_path4.default.dirname(configPath), {}, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(import_typescript2.default.formatDiagnosticsWithColorAndContext(parsedConfig.errors, import_typescript2.default.createCompilerHost({})));
  }
  return parsedConfig.options;
}
function createSimpleDiagnostic(messageText) {
  return {
    category: import_typescript2.default.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
async function readMetadata(metadataPath) {
  try {
    const raw = await import_fs5.default.promises.readFile(metadataPath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// src/stages/closure/run-closure.ts
var import_promises = __toESM(require("fs/promises"));
var import_path5 = __toESM(require("path"));
var closureCompilerPackage = __toESM(require("google-closure-compiler"));
var import_utils = require("google-closure-compiler/lib/utils.js");
var closureLibFilesCache = new Map;
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  externPaths,
  finalCacheDir,
  options,
  outDir,
  packageRoot
}) {
  await import_promises.default.rm(finalCacheDir, { force: true, recursive: true });
  await import_promises.default.mkdir(finalCacheDir, { recursive: true });
  const rawDir = import_path5.default.join(finalCacheDir, "raw");
  const cacheOutputDir = import_path5.default.join(finalCacheDir, "outputs");
  await import_promises.default.mkdir(rawDir, { recursive: true });
  await import_promises.default.mkdir(cacheOutputDir, { recursive: true });
  await import_promises.default.rm(outDir, { force: true, recursive: true });
  await import_promises.default.mkdir(outDir, { recursive: true });
  const closureLibFiles = await collectClosureLibFiles(packageRoot);
  const resolvedChunks = resolveChunkPlan(chunkPlan, emittedOutDir);
  const exitCode = resolvedChunks.length === 1 ? await runSingleClosureCompilation({
    closureLibFiles,
    entryChunk: resolvedChunks[0],
    externPaths,
    options,
    rawOutputPath: import_path5.default.join(rawDir, `${resolvedChunks[0].name}.js`)
  }) : await runChunkedClosureCompilation({
    chunkPlan: resolvedChunks,
    closureLibFiles,
    externPaths,
    options,
    outputDir: rawDir
  });
  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }
  const rawOutputs = resolvedChunks.map((chunk) => import_path5.default.join(rawDir, `${chunk.name}.js`));
  const outputFiles = resolvedChunks.map((chunk) => import_path5.default.join(outDir, `${chunk.name}.js`));
  await Promise.all(rawOutputs.map(async (rawFile, index) => {
    const contents = await import_promises.default.readFile(rawFile, "utf-8");
    const transformed = rewriteGccExports(contents);
    await import_promises.default.writeFile(outputFiles[index], transformed);
  }));
  await copyOrLinkFiles(outputFiles, cacheOutputDir);
  const cacheOutputFiles = outputFiles.map((outputFile) => import_path5.default.join(cacheOutputDir, import_path5.default.basename(outputFile)));
  return { cacheOutputFiles, exitCode: 0, outputFiles };
}
async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  rawOutputPath
}) {
  return runClosureCompiler({
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "NONE",
    externs: externPaths,
    js: [...options.js, ...closureLibFiles, ...entryChunk.files],
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    moduleResolution: "NODE",
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  });
}
async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir
}) {
  const leadingJs = [...options.js, ...closureLibFiles];
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix = chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${chunk.files.length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = [
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files)
  ];
  return runClosureCompiler({
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${import_path5.default.sep}`,
    chunkOutputType: "ES_MODULES",
    dependencyMode: "NONE",
    externs: externPaths,
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    moduleResolution: "NODE",
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  });
}
function resolveChunkPlan(chunkPlan, emittedOutDir) {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    files: chunk.files.map((filePath) => import_path5.default.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js"))),
    name: chunk.name
  }));
}
function getDefaultString(value) {
  if (typeof value === "object" && value !== null && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return;
}
function resolveClosureCompilerJarPath() {
  const closureCompilerModule = closureCompilerPackage;
  const closureCompiler = closureCompilerPackage.compiler;
  const jarPath = typeof closureCompiler.JAR_PATH === "string" ? closureCompiler.JAR_PATH : typeof closureCompilerModule.JAR_PATH === "string" ? closureCompilerModule.JAR_PATH : getDefaultString(closureCompiler.JAR_PATH) ?? getDefaultString(closureCompilerModule.JAR_PATH);
  return jarPath;
}
function configureClosureCompilerInstance(instance) {
  const nativeImagePath = import_utils.getNativeImagePath();
  if (nativeImagePath) {
    instance.JAR_PATH = null;
    instance.javaPath = nativeImagePath;
    return instance;
  }
  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    instance.JAR_PATH = jarPath;
  }
  return instance;
}
async function runClosureCompiler(options) {
  const closureCompiler = closureCompilerPackage.compiler;
  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(new closureCompiler(options));
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      if (stdOut) {
        console.log(stdOut);
      }
      if (stdErr) {
        console.error(stdErr);
      }
      resolve(exitCode);
    });
  });
}
async function collectJavaScriptFiles(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await import_promises.default.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = import_path5.default.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}
function collectClosureLibFiles(packageRoot) {
  const closureLibDir = import_path5.default.join(packageRoot, "closure-lib");
  const existing = closureLibFilesCache.get(closureLibDir);
  if (existing) {
    return existing;
  }
  const filesPromise = collectJavaScriptFiles(closureLibDir);
  closureLibFilesCache.set(closureLibDir, filesPromise);
  return filesPromise;
}

// src/pipeline/build-pipeline.ts
var bundledExternsCache = null;
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  if (context.options.cache.mode === "persistent") {
    const fastSnapshot = await readJsonIfExists(import_path6.default.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: fastSnapshot.publishedOutputs.map(({ name }) => import_path6.default.join(context.options.outDir, name))
      };
    }
  }
  const resolved = await resolveBuild(context);
  try {
    const finalMetadataPath = import_path6.default.join(resolved.finalCacheDir, "meta.json");
    const finalMetadata = await readJsonIfExists(finalMetadataPath);
    if (context.options.cache.mode !== "off" && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: finalMetadata.outputFiles.map((outputFile) => import_path6.default.join(context.options.outDir, import_path6.default.basename(outputFile)))
      };
    }
    writeEntryShims({
      entries: resolved.entryFiles.map((entry) => ({
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        importPath: toImportPath(import_path6.default.relative(import_path6.default.dirname(import_path6.default.join(resolved.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
        shimPath: import_path6.default.join(resolved.shimDir, `${entry.chunkName}.ts`)
      }))
    });
    const nativeEmitMetadataPath = import_path6.default.join(resolved.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      fileNames: [...resolved.filePaths, ...resolved.shimFiles],
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      tsConfigPath: resolved.tsConfigPath,
      workspaceDir: resolved.workspaceDir
    });
    if (nativeEmitResult.diagnostics.length > 0 || nativeEmitResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: nativeEmitResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    const bundledExterns = await collectBundledExterns(context.packageRoot);
    const closureResult = await runClosureStage({
      chunkPlan: resolved.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      externPaths: [
        ...context.options.externs,
        ...bundledExterns,
        nativeEmitResult.externsPath
      ],
      finalCacheDir: resolved.finalCacheDir,
      options: context.options,
      outDir: context.options.outDir,
      packageRoot: context.packageRoot
    });
    if (closureResult.exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode: closureResult.exitCode,
        outputFiles: []
      };
    }
    await writeJson(finalMetadataPath, {
      outputFiles: closureResult.cacheOutputFiles
    });
    await writeJson(import_path6.default.join(context.projectCacheDir, "final-fast.json"), {
      finalKey: resolved.finalKey,
      optionsSignature: context.optionsSignature,
      packageSignature: context.packageSignature,
      publishedOutputs: await collectPublishedOutputStats(closureResult.outputFiles),
      trackedFiles: resolved.trackedFiles
    });
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      outputFiles: closureResult.outputFiles
    };
  } catch (error) {
    console.error(error);
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: true,
      exitCode: 1,
      outputFiles: []
    };
  } finally {
    await resolved.cleanup();
  }
}
async function cleanCache(options = {}) {
  const projectRoot = import_path6.default.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = import_path6.default.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path6.default.join(cacheRoot, hashContent(projectRoot));
  await import_fs6.default.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function collectBundledExterns(packageRoot) {
  if (!bundledExternsCache) {
    bundledExternsCache = (async () => {
      const closureExternsPath = import_path6.default.join(packageRoot, "closure-externs");
      const entries = await import_fs6.default.promises.readdir(closureExternsPath);
      return entries.map((entry) => import_path6.default.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
    })();
  }
  return bundledExternsCache;
}
async function publishOutputs(outputFiles, outDir) {
  if (await publishedOutputsMatch(outputFiles, outDir)) {
    return;
  }
  await copyOrLinkFiles(outputFiles, outDir);
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

// src/api/build.ts
async function runCli(args) {
  const [firstArg, ...restArgs] = args;
  if (!firstArg || firstArg === "-h" || firstArg === "--help") {
    usage();
    return 0;
  }
  if (firstArg === "clean-cache") {
    const { options: options2, showHelp: showHelp2 } = parseCliArgs(restArgs);
    if (showHelp2) {
      usage();
      return 0;
    }
    await cleanCache({
      cacheDir: options2.cache?.dir,
      projectRoot: options2.projectRoot
    });
    return 0;
  }
  const buildArgs = firstArg === "build" ? restArgs : args;
  const { options, showHelp } = parseCliArgs(buildArgs);
  if (showHelp) {
    usage();
    return 0;
  }
  const result = await build(options);
  return result.exitCode;
}
async function main(args) {
  return runCli(args);
}

// src/entry/cli.ts
main(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
});
