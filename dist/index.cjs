var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
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
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  cleanCache: () => cleanCache,
  build: () => build2,
  DEFAULT_BUILD_OPTIONS: () => DEFAULT_BUILD_OPTIONS
});
module.exports = __toCommonJS(exports_src);

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
  packages: {
    mode: "esm-only"
  },
  projectRoot: "",
  srcDir: ""
});

// src/pipeline/build-pipeline.ts
var import_path7 = __toESM(require("path"));
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
  const result = loadBinding().resolveGraph(input.entries, input.srcDir, input.workspaceDir, input.packageMode);
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(result.fileHashes.map((entry) => [entry.filePath, entry.hash])),
    graph: Object.fromEntries(result.graph.map((entry) => [entry.filePath, entry.dependencies])),
    packageAliases: result.packageAliases,
    packageJsonFiles: result.packageJsonFiles,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles
  };
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.metadataPath, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? []);
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
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = await hashTsConfig(tsConfigPath);
  const entryRelativePaths = options.entries.map((entry) => import_path3.default.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => import_path3.default.join(sourceRoot, import_path3.default.relative(options.srcDir, entry)));
  const resolveSnapshotPath = import_path3.default.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = await readJsonIfExists(resolveSnapshotPath);
  if (cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
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
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: entryFiles2.map((entry) => import_path3.default.join(shimDir2, `${entry.chunkName}.ts`)),
      sourceFiles: cachedSnapshot.sourceFiles,
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir
    };
  }
  const graphResult = resolveGraph({
    entries: overlayEntries,
    packageMode: options.packages.mode,
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
    ...graphResult.trackedFiles,
    tsConfigPath,
    ...options.externs,
    ...options.js
  ]);
  await writeJson(resolveSnapshotPath, {
    compilerOptionsHash,
    entryFiles: resolveMetadata.entryFiles,
    finalKey,
    nativeEmitKey,
    optionsSignature: context.optionsSignature,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    packageSignature: context.packageSignature,
    resolveKey,
    sourceFiles: graphResult.sourceFiles,
    trackedFiles
  });
  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    finalCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
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
async function ensureDirectorySymlink(linkPath, targetPath) {
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
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = import_path3.default.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = import_path3.default.join(options.projectRoot, "node_modules");
  const hasNodeModules = await import_fs4.default.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function removePathIfExists(targetPath) {
  try {
    await import_fs4.default.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
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
    packages: options.packages,
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
    packages: {
      mode: options.packages?.mode ?? DEFAULT_BUILD_OPTIONS.packages.mode
    },
    projectRoot,
    srcDir
  };
}

// src/stages/native/emit.ts
var import_fs5 = __toESM(require("fs"));
var import_module2 = require("module");
var import_path5 = __toESM(require("path"));
var import_typescript4 = __toESM(require("typescript"));

// src/stages/native/compiler-options.ts
var import_path4 = __toESM(require("path"));
var import_typescript2 = __toESM(require("typescript"));
function loadCompilerOptions(configPath, extraOptions = {}) {
  const configFile = import_typescript2.default.readConfigFile(configPath, import_typescript2.default.sys.readFile);
  if (configFile.error) {
    throw new Error(import_typescript2.default.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = import_typescript2.default.parseJsonConfigFileContent(configFile.config, import_typescript2.default.sys, import_path4.default.dirname(configPath), extraOptions, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(import_typescript2.default.formatDiagnosticsWithColorAndContext(parsedConfig.errors, import_typescript2.default.createCompilerHost({})));
  }
  return parsedConfig.options;
}

// src/stages/native/closure-ir.ts
var import_typescript3 = __toESM(require("typescript"));
async function collectClosureIrMetadata({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    rootDir: workspaceDir
  });
  const program = import_typescript3.default.createProgram(fileNames, compilerOptions);
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const files = [];
  const diagnostics = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!fileNames.includes(sourceFile.fileName)) {
      continue;
    }
    const typeDeclarations = [];
    const topLevelDocs = [];
    const enumDeclarations = [];
    for (const statement of sourceFile.statements) {
      if (import_typescript3.default.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker));
        continue;
      }
      if (import_typescript3.default.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker));
        continue;
      }
      if (import_typescript3.default.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols);
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }
      if (import_typescript3.default.isFunctionDeclaration(statement) && statement.name) {
        const jsdoc = buildFunctionJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: statement.name.text
          });
        }
        continue;
      }
      if (import_typescript3.default.isClassDeclaration(statement) && statement.name) {
        const jsdoc = buildClassJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "class",
            name: statement.name.text
          });
        }
      }
    }
    let decoratedOutputText;
    if (containsDecorators(sourceFile)) {
      const transpiled = import_typescript3.default.transpileModule(sourceFile.getFullText(), {
        compilerOptions: {
          ...compilerOptions,
          module: import_typescript3.default.ModuleKind.ESNext,
          moduleResolution: import_typescript3.default.ModuleResolutionKind.Bundler,
          sourceMap: false,
          target: import_typescript3.default.ScriptTarget.ES2018
        },
        fileName: sourceFile.fileName,
        reportDiagnostics: true
      });
      diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === import_typescript3.default.DiagnosticCategory.Error));
      decoratedOutputText = transpiled.outputText;
    }
    files.push({
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations
    });
  }
  return { diagnostics, files };
}
function containsDecorators(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (import_typescript3.default.canHaveDecorators(node) && (import_typescript3.default.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    import_typescript3.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function collectUnsafeEnumSymbols(program, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & import_typescript3.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node) => {
      if (import_typescript3.default.isElementAccessExpression(node) && import_typescript3.default.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (import_typescript3.default.isCallExpression(node) && import_typescript3.default.isPropertyAccessExpression(node.expression) && import_typescript3.default.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && import_typescript3.default.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (import_typescript3.default.isIdentifier(node) && !import_typescript3.default.isPropertyAccessExpression(node.parent) && !import_typescript3.default.isElementAccessExpression(node.parent) && !import_typescript3.default.isImportSpecifier(node.parent) && !import_typescript3.default.isImportClause(node.parent) && !import_typescript3.default.isExportSpecifier(node.parent) && !import_typescript3.default.isEnumDeclaration(node.parent) && !import_typescript3.default.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & import_typescript3.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & import_typescript3.default.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      import_typescript3.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & import_typescript3.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }
  const members = [];
  let valueType = null;
  let nextNumber = 0;
  for (const member of statement.members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      return null;
    }
    const constantValue = checker.getConstantValue(member);
    const memberValue = constantValue ?? (member.initializer ? literalValueFromExpression(member.initializer) : nextNumber);
    if (memberValue === undefined) {
      return null;
    }
    const currentValueType = typeof memberValue;
    if (currentValueType !== "number" && currentValueType !== "string" && currentValueType !== "boolean") {
      return null;
    }
    if (valueType && valueType !== currentValueType) {
      return null;
    }
    valueType = currentValueType;
    members.push({ name: memberName, value: memberValue });
    if (typeof memberValue === "number") {
      nextNumber = memberValue + 1;
    }
  }
  if (!valueType || members.length === 0) {
    return null;
  }
  if (valueType === "number" && !hasConstModifier(statement)) {
    return null;
  }
  return {
    exported: hasExportModifier(statement),
    members,
    name: statement.name.text,
    valueType
  };
}
function buildInterfaceDeclarationSnippet(statement, checker) {
  const lines = ["/**"];
  lines.push(" * @record");
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(" */");
  lines.push(`function ${statement.name.text}() {}`);
  for (const member of statement.members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      continue;
    }
    if (import_typescript3.default.isPropertySignature(member)) {
      const propertyType = member.type ? toClosureType(checker.getTypeFromTypeNode(member.type), checker) : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
      continue;
    }
    if (import_typescript3.default.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(signature, checker);
      lines.push(`/** @type {${functionType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
    }
  }
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildTypeAliasDeclarationSnippet(statement, checker) {
  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker);
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(` * @typedef {${closureType}}`);
  lines.push(" */");
  lines.push(`let ${statement.name.text};`);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildFunctionJsDoc(statement, checker) {
  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  for (const parameter of signature.getParameters()) {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    lines.push(` * @param {${toClosureType(parameterType, checker)}} ${parameter.getName()}`);
  }
  const returnType = checker.getReturnTypeOfSignature(signature);
  lines.push(` * @return {${toClosureType(returnType, checker)}}`);
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function buildClassJsDoc(statement, checker) {
  const symbol = checker.getSymbolAtLocation(statement.name ?? statement);
  const declaredType = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : checker.getTypeAtLocation(statement);
  const typeParameters = statement.typeParameters ?? [];
  const lines = ["/**"];
  for (const templateName of getTemplateNames(typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureType(checker.getTypeAtLocation(typeNode), checker);
        if (clause.token === import_typescript3.default.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === import_typescript3.default.SyntaxKind.ImplementsKeyword) {
          lines.push(` * @implements {${closureType}}`);
        }
      }
    }
  }
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function getTemplateNames(typeParameters) {
  return (typeParameters ?? []).map((parameter) => parameter.name.text);
}
function hasExportModifier(node) {
  return (import_typescript3.default.getCombinedModifierFlags(node) & import_typescript3.default.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (import_typescript3.default.getCombinedModifierFlags(node) & import_typescript3.default.ModifierFlags.Const) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (import_typescript3.default.isIdentifier(name) || import_typescript3.default.isStringLiteral(name) || import_typescript3.default.isNumericLiteral(name) || import_typescript3.default.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `[${JSON.stringify(name)}]`;
}
function literalValueFromExpression(expression) {
  if (import_typescript3.default.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (import_typescript3.default.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === import_typescript3.default.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === import_typescript3.default.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (import_typescript3.default.isPrefixUnaryExpression(expression) && expression.operator === import_typescript3.default.SyntaxKind.MinusToken && import_typescript3.default.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text);
  }
  return;
}
function signatureToClosureFunctionType(signature, checker) {
  const params = signature.getParameters().map((parameter) => {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    return toClosureType(parameterType, checker);
  });
  const returnType = toClosureType(checker.getReturnTypeOfSignature(signature), checker);
  return `function(${params.join(", ")}): ${returnType}`;
}
function toClosureType(type, checker, seen = new Set) {
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);
  if (type.flags & import_typescript3.default.TypeFlags.Any) {
    return "?";
  }
  if (type.flags & import_typescript3.default.TypeFlags.Unknown) {
    return "?";
  }
  if (type.flags & import_typescript3.default.TypeFlags.StringLike) {
    return "string";
  }
  if (type.flags & import_typescript3.default.TypeFlags.NumberLike) {
    return "number";
  }
  if (type.flags & import_typescript3.default.TypeFlags.BooleanLike) {
    return "boolean";
  }
  if (type.flags & import_typescript3.default.TypeFlags.Void) {
    return "void";
  }
  if (type.flags & import_typescript3.default.TypeFlags.Undefined) {
    return "undefined";
  }
  if (type.flags & import_typescript3.default.TypeFlags.Null) {
    return "null";
  }
  if (type.flags & import_typescript3.default.TypeFlags.Never) {
    return "never";
  }
  if (type.flags & import_typescript3.default.TypeFlags.TypeParameter) {
    return checker.typeToString(type);
  }
  if (type.isUnion()) {
    return `(${type.types.map((item) => toClosureType(item, checker, seen)).join("|")})`;
  }
  if (checker.isArrayType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    const elementType = typeArguments[0] ? toClosureType(typeArguments[0], checker, seen) : "?";
    return `!Array<${elementType}>`;
  }
  if (checker.isTupleType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${typeArguments.map((item) => toClosureType(item, checker, seen)).join("|")}>`;
  }
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0) {
    return signatureToClosureFunctionType(callSignatures[0], checker);
  }
  if (type.getSymbol()) {
    const symbolName = checker.symbolToString(type.getSymbol());
    if (symbolName && symbolName !== "__type") {
      return symbolName;
    }
  }
  if (type.isClassOrInterface() || type.getProperties().length > 0 && !(type.flags & import_typescript3.default.TypeFlags.Object)) {
    return "!Object";
  }
  return "?";
}

// src/stages/native/emit.ts
var require3 = import_module2.createRequire("file:///Users/Blueagle/Code/gcc-ts-bundler/src/stages/native/emit.ts");
var NATIVE_EMIT_METADATA_VERSION = 6;
async function emitNativeStage({
  cacheDir,
  fileNames,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir
}) {
  const outDir = import_path5.default.join(cacheDir, "out");
  const externsPath = import_path5.default.join(cacheDir, "modules-externs.js");
  const metadataPathForNative = import_path5.default.join(cacheDir, "closure-ir.json");
  const runtimePackageInputs = await collectTsxRuntimePackageInputs({
    fileNames,
    tsConfigPath,
    workspaceDir
  });
  const runtimeSupportFiles = runtimePackageInputs.sourceFiles.map((fileName) => toEmittedPath(fileName, outDir, workspaceDir));
  const combinedFileNames = uniqueSorted2([
    ...fileNames,
    ...runtimePackageInputs.sourceFiles
  ]);
  const combinedPackageAliases = mergePackageAliases([
    ...packageAliases,
    ...runtimePackageInputs.packageAliases
  ]);
  const combinedPackageJsonFiles = uniqueSorted2([
    ...packageJsonFiles,
    ...runtimePackageInputs.packageJsonFiles
  ]);
  const cachedMetadata = await readMetadata(metadataPath);
  if (cachedMetadata && await filesExist([
    cachedMetadata.externsPath,
    cachedMetadata.metadataPath,
    ...cachedMetadata.emittedFiles,
    ...cachedMetadata.supportFiles
  ])) {
    return {
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles
    };
  }
  await import_fs5.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs5.default.promises.mkdir(outDir, { recursive: true });
  const diagnostics = getPreflightDiagnostics({
    fileNames: combinedFileNames,
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
      outDir,
      supportFiles: []
    };
  }
  const closureIr = await collectClosureIrMetadata({
    fileNames: combinedFileNames,
    tsConfigPath,
    workspaceDir
  });
  if (closureIr.diagnostics.length > 0) {
    return {
      diagnostics: closureIr.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  await import_fs5.default.promises.writeFile(metadataPathForNative, JSON.stringify(closureIr.files, null, 2), "utf-8");
  const result = transpileSources({
    metadataPath: metadataPathForNative,
    externsPath,
    fileNames: combinedFileNames,
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir
  });
  const finalSupportFiles = uniqueSorted2([
    ...runtimeSupportFiles,
    ...result.supportFiles
  ]);
  await import_fs5.default.promises.writeFile(metadataPath, JSON.stringify({
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    metadataPath: metadataPathForNative,
    supportFiles: finalSupportFiles,
    version: NATIVE_EMIT_METADATA_VERSION
  }, null, 2), "utf-8");
  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles
  };
}
async function collectTsxRuntimePackageInputs({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const resolvedEntry = require3.resolve(runtimeSpecifier, {
    paths: [workspaceDir]
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(resolvedEntry, workspaceDir);
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: import_path5.default.join(workspaceDir, "src"),
    workspaceDir
  });
  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles
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
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: import_typescript4.default.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript4.default.ScriptTarget.ESNext
  };
  const compilerHost = import_typescript4.default.createCompilerHost(finalCompilerOptions);
  const program = import_typescript4.default.createProgram(fileNames, finalCompilerOptions, compilerHost);
  return [...import_typescript4.default.getPreEmitDiagnostics(program)].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic));
}
function createSimpleDiagnostic(messageText) {
  return {
    category: import_typescript4.default.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
function shouldIgnorePreflightDiagnostic(diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }
  const message = import_typescript4.default.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
}
function getJsxRuntimeSpecifier(compilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case import_typescript4.default.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case import_typescript4.default.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
async function readMetadata(metadataPath) {
  try {
    const raw = await import_fs5.default.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      metadataPath: parsed.metadataPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function toEmittedPath(sourcePath, outDir, workspaceDir) {
  return import_path5.default.join(outDir, import_path5.default.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
}
function uniqueSorted2(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function mergePackageAliases(aliases) {
  const merged = new Map;
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\x00${alias.subpath}`, alias);
  }
  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\x00${left.subpath}`;
    const rightKey = `${right.packageName}\x00${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}
function toWorkspaceNodeModulesPath(resolvedPath, workspaceDir) {
  const marker = `${import_path5.default.sep}node_modules${import_path5.default.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return import_path5.default.join(workspaceDir, relativeNodeModulesPath);
}
function toRuntimePackageAlias(specifier, targetPath) {
  const segments = specifier.startsWith("@") ? specifier.split("/", 3) : specifier.split("/", 2);
  const packageName = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  const subpath = specifier.startsWith("@") ? segments[2] : segments[1];
  return {
    packageName,
    subpath: subpath ? `./${subpath}` : ".",
    targetPath
  };
}

// src/stages/closure/run-closure.ts
var import_promises = __toESM(require("fs/promises"));
var import_path6 = __toESM(require("path"));
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
  supportFiles,
  packageRoot
}) {
  await import_promises.default.rm(finalCacheDir, { force: true, recursive: true });
  await import_promises.default.mkdir(finalCacheDir, { recursive: true });
  const rawDir = import_path6.default.join(finalCacheDir, "raw");
  const cacheOutputDir = import_path6.default.join(finalCacheDir, "outputs");
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
    supportFiles,
    rawOutputPath: import_path6.default.join(rawDir, `${resolvedChunks[0].name}.js`)
  }) : await runChunkedClosureCompilation({
    chunkPlan: resolvedChunks,
    closureLibFiles,
    externPaths,
    options,
    outputDir: rawDir,
    supportFiles
  });
  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }
  const rawOutputs = resolvedChunks.map((chunk) => import_path6.default.join(rawDir, `${chunk.name}.js`));
  const outputFiles = resolvedChunks.map((chunk) => import_path6.default.join(outDir, `${chunk.name}.js`));
  await Promise.all(rawOutputs.map(async (rawFile, index) => {
    const contents = await import_promises.default.readFile(rawFile, "utf-8");
    const transformed = rewriteGccExports(contents);
    await import_promises.default.writeFile(outputFiles[index], transformed);
  }));
  await copyOrLinkFiles(outputFiles, cacheOutputDir);
  const cacheOutputFiles = outputFiles.map((outputFile) => import_path6.default.join(cacheOutputDir, import_path6.default.basename(outputFile)));
  return { cacheOutputFiles, exitCode: 0, outputFiles };
}
async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  supportFiles,
  rawOutputPath
}) {
  const closureOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: uniquePaths([
      ...options.js,
      ...closureLibFiles,
      ...supportFiles,
      ...entryChunk.files
    ]),
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  };
  if (entryChunk.entryPoint) {
    closureOptions.entryPoint = [entryChunk.entryPoint];
  }
  return runClosureCompiler(closureOptions);
}
async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir,
  supportFiles
}) {
  const leadingJs = uniquePaths([
    ...options.js,
    ...closureLibFiles,
    ...supportFiles
  ]);
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix = chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${uniquePaths(chunk.files).length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = uniquePaths([
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files)
  ]);
  const closureOptions = {
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${import_path6.default.sep}`,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  };
  const entryPoints = uniquePaths(chunkPlan.map((chunk) => chunk.entryPoint).filter((entryPoint) => Boolean(entryPoint)));
  if (entryPoints.length > 0) {
    closureOptions.entryPoint = entryPoints;
  }
  return runClosureCompiler(closureOptions);
}
function resolveChunkPlan(chunkPlan, emittedOutDir) {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    entryFile: chunk.files.length > 0 ? import_path6.default.join(emittedOutDir, chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js")) : undefined,
    entryPoint: chunk.files.length > 0 ? toGoogModuleId(import_path6.default.join(emittedOutDir, chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js")), emittedOutDir) : undefined,
    files: chunk.files.map((filePath) => import_path6.default.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js"))),
    name: chunk.name
  }));
}
function getDefaultString(value) {
  if (typeof value === "object" && value !== null && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return;
}
function uniquePaths(paths) {
  return [...new Set(paths)];
}
function toGoogModuleId(filePath, moduleRoot) {
  const relativePath = import_path6.default.relative(moduleRoot, filePath).replace(/\\/g, "/");
  const withoutExtension = relativePath.replace(/\.[^/.]+$/, "");
  return `gcc.${withoutExtension.split("/").map((segment) => segment.replace(/[^A-Za-z0-9_$]/g, "_")).join(".")}`;
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
      const entryPath = import_path6.default.join(currentDir, entry.name);
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
  const closureLibDir = import_path6.default.join(packageRoot, "closure-lib");
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
    const fastSnapshot = await readJsonIfExists(import_path7.default.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: fastSnapshot.publishedOutputs.map(({ name }) => import_path7.default.join(context.options.outDir, name))
      };
    }
  }
  let resolved = null;
  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = import_path7.default.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = await readJsonIfExists(finalMetadataPath);
    if (context.options.cache.mode !== "off" && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: finalMetadata.outputFiles.map((outputFile) => import_path7.default.join(context.options.outDir, import_path7.default.basename(outputFile)))
      };
    }
    writeEntryShims({
      entries: resolvedBuild.entryFiles.map((entry) => ({
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        importPath: toImportPath(import_path7.default.relative(import_path7.default.dirname(import_path7.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
        shimPath: import_path7.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
      }))
    });
    const nativeEmitMetadataPath = import_path7.default.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      packageAliases: resolvedBuild.packageAliases,
      packageJsonFiles: resolvedBuild.packageJsonFiles,
      tsConfigPath: resolvedBuild.tsConfigPath,
      workspaceDir: resolvedBuild.workspaceDir
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
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      externPaths: [
        ...context.options.externs,
        ...bundledExterns,
        nativeEmitResult.externsPath
      ],
      finalCacheDir: resolvedBuild.finalCacheDir,
      options: context.options,
      outDir: context.options.outDir,
      supportFiles: nativeEmitResult.supportFiles,
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
    if (context.options.cache.mode === "persistent") {
      await writeJson(import_path7.default.join(context.projectCacheDir, "final-fast.json"), {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats(closureResult.outputFiles),
        trackedFiles: resolvedBuild.trackedFiles
      });
    }
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      outputFiles: closureResult.outputFiles
    };
  } catch (error) {
    return {
      cacheHit: false,
      diagnostics: [createBuildDiagnostic(error)],
      emitSkipped: true,
      exitCode: 1,
      outputFiles: []
    };
  } finally {
    await resolved?.cleanup();
  }
}
async function cleanCache(options = {}) {
  const projectRoot = import_path7.default.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = import_path7.default.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path7.default.join(cacheRoot, hashContent(projectRoot));
  await import_fs6.default.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function collectBundledExterns(packageRoot) {
  if (!bundledExternsCache) {
    bundledExternsCache = (async () => {
      const closureExternsPath = import_path7.default.join(packageRoot, "closure-externs");
      const entries = await import_fs6.default.promises.readdir(closureExternsPath);
      return entries.map((entry) => import_path7.default.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
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
function createBuildDiagnostic(error) {
  return {
    category: 1,
    code: 0,
    messageText: error instanceof Error ? error.message : typeof error === "string" ? error : "Build failed."
  };
}

// src/api/build.ts
var build2 = (options) => build(options);
