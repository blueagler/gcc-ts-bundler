const __gcc_current_module_url = require('node:url').pathToFileURL(__filename).href;
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
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/internal/bundle-location.ts
function getBundleFilePath() {
  return import_url.fileURLToPath(__gcc_current_module_url);
}
function createBundleRequire() {
  bundleRequire ??= import_module.createRequire(__gcc_current_module_url);
  return bundleRequire;
}
function getPackageRootFromBundle() {
  if (packageRoot) {
    return packageRoot;
  }
  let currentDir = import_path.default.dirname(getBundleFilePath());
  while (true) {
    if (import_fs.default.existsSync(import_path.default.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }
    const parentDir = import_path.default.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package.json from bundled module path ${getBundleFilePath()}`);
    }
    currentDir = parentDir;
  }
}
var import_fs, import_path, import_module, import_url, bundleRequire = null, packageRoot = null;
var init_bundle_location = __esm(() => {
  import_fs = __toESM(require("fs"));
  import_path = __toESM(require("path"));
  import_module = require("module");
  import_url = require("url");
});

// src/native/index.ts
var exports_native = {};
__export(exports_native, {
  default: () => native_default
});
module.exports = __toCommonJS(exports_native);
function detectLinuxLibc() {
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return "gnu";
  }
  try {
    const { execFileSync } = require2("node:child_process");
    const output = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.includes("musl") ? "musl" : "gnu";
  } catch {}
  return "musl";
}
function getTargetKey() {
  if (process.platform === "linux") {
    return `${process.platform}-${process.arch}-${detectLinuxLibc()}`;
  }
  if (process.platform === "win32") {
    return `${process.platform}-${process.arch}-msvc`;
  }
  return `${process.platform}-${process.arch}`;
}
function loadNativeBinding() {
  const targetKey = getTargetKey();
  const packageName = SUPPORTED_TARGETS[targetKey];
  const localFallbackPath = import_path2.default.join(getPackageRootFromBundle(), "native", "index.node");
  if (import_fs2.default.existsSync(localFallbackPath)) {
    return require2(localFallbackPath);
  }
  const loadErrors = [];
  if (packageName) {
    try {
      return require2(packageName);
    } catch (error) {
      loadErrors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const supportedTargets = Object.keys(SUPPORTED_TARGETS).join(", ");
  const details = loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(`No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`);
}
var import_fs2, import_path2, require2, SUPPORTED_TARGETS, native_default;
var init_native = __esm(() => {
  init_bundle_location();
  import_fs2 = __toESM(require("fs"));
  import_path2 = __toESM(require("path"));
  require2 = createBundleRequire();
  SUPPORTED_TARGETS = {
    "darwin-arm64": "gcc-ts-bundler-darwin-arm64",
    "darwin-x64": "gcc-ts-bundler-darwin-x64",
    "linux-arm64-gnu": "gcc-ts-bundler-linux-arm64-gnu",
    "linux-arm64-musl": "gcc-ts-bundler-linux-arm64-musl",
    "linux-x64-gnu": "gcc-ts-bundler-linux-x64-gnu",
    "linux-x64-musl": "gcc-ts-bundler-linux-x64-musl",
    "win32-arm64-msvc": "gcc-ts-bundler-win32-arm64-msvc",
    "win32-x64-msvc": "gcc-ts-bundler-win32-x64-msvc"
  };
  native_default = loadNativeBinding();
});

// src/cache/hash.ts
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
var import_crypto;
var init_hash = __esm(() => {
  import_crypto = __toESM(require("crypto"));
});

// src/internal/files.ts
function uniqueSortedStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
async function ensureDirectory(dirPath) {
  await import_promises.default.mkdir(dirPath, { recursive: true });
}
async function ensureParentDirectory(filePath) {
  await ensureDirectory(import_path3.default.dirname(filePath));
}
async function hashFileInput(filePath) {
  const stat = await import_promises.default.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = import_promises.default.readFile(filePath, "utf-8").then((contents) => hashContent(contents));
  fileInputHashCache.set(cacheKey, pending);
  return pending;
}
async function hashFilesInOrder(filePaths) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}
async function publishFilesToDirectory(sourceFiles, outDir, mode) {
  await import_promises.default.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = import_path3.default.join(outDir, import_path3.default.basename(sourceFile));
    if (mode === "copy") {
      await import_promises.default.copyFile(sourceFile, destinationFile);
      return;
    }
    try {
      await import_promises.default.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await import_promises.default.copyFile(sourceFile, destinationFile);
    }
  }));
}
async function syncDirectoryEntries(rootDir, entries, options = {}) {
  await ensureDirectory(rootDir);
  const expectedEntries = new Map(entries.map((entry) => [normalizeRelativePath(entry.relativePath), entry]));
  const existingFiles = await listRelativeFiles(rootDir);
  await Promise.all(existingFiles.filter((relativePath) => !expectedEntries.has(relativePath) && !(options.preserve?.(relativePath) ?? false)).map((relativePath) => import_promises.default.rm(import_path3.default.join(rootDir, relativePath), { force: true })));
  await removeEmptyDirectories(rootDir);
  await Promise.all([...expectedEntries.values()].map(async (entry) => {
    const filePath = import_path3.default.join(rootDir, normalizeRelativePath(entry.relativePath));
    await ensureParentDirectory(filePath);
    await writeFileIfChanged(filePath, entry.content);
  }));
}
async function writeFileIfChanged(filePath, content) {
  const nextContent = typeof content === "string" ? content : Buffer.from(content);
  let currentContent = null;
  try {
    currentContent = await import_promises.default.readFile(filePath, typeof content === "string" ? "utf8" : undefined);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (currentContent !== null && fileContentsEqual(currentContent, nextContent)) {
    return;
  }
  await import_promises.default.writeFile(filePath, nextContent);
}
async function listRelativeFiles(rootDir, currentDir = rootDir) {
  let entries;
  try {
    entries = await import_promises.default.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = import_path3.default.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(rootDir, entryPath));
      continue;
    }
    files.push(normalizeRelativePath(import_path3.default.relative(rootDir, entryPath)));
  }
  return files.sort((left, right) => left.localeCompare(right));
}
async function removeEmptyDirectories(rootDir, currentDir = rootDir) {
  let entries;
  try {
    entries = await import_promises.default.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const entryPath = import_path3.default.join(currentDir, entry.name);
    await removeEmptyDirectories(rootDir, entryPath);
    const nestedEntries = await import_promises.default.readdir(entryPath).catch((error) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
    if (nestedEntries.length === 0 && entryPath !== rootDir) {
      await import_promises.default.rmdir(entryPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  }));
}
function fileContentsEqual(currentContent, nextContent) {
  if (typeof currentContent === "string" && typeof nextContent === "string") {
    return currentContent === nextContent;
  }
  const currentBuffer = typeof currentContent === "string" ? Buffer.from(currentContent) : currentContent;
  const nextBuffer = typeof nextContent === "string" ? Buffer.from(nextContent) : nextContent;
  return currentBuffer.equals(nextBuffer);
}
function normalizeRelativePath(relativePath) {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/u, "");
}
var import_promises, import_path3, fileInputHashCache;
var init_files = __esm(() => {
  init_hash();
  import_promises = __toESM(require("fs/promises"));
  import_path3 = __toESM(require("path"));
  fileInputHashCache = new Map;
});

// src/stages/native/compiler-options.ts
async function loadCompilerOptions(configPath, extraOptions = {}) {
  const configStat = await import_fs3.default.promises.stat(configPath);
  const cacheKey = hashJson({
    configPath,
    extraOptions,
    mtimeMs: configStat.mtimeMs,
    size: configStat.size
  });
  const cached = compilerOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const configDir = import_path6.default.dirname(configPath);
  const configFile = import_typescript4.default.readConfigFile(configPath, import_typescript4.default.sys.readFile);
  if (configFile.error) {
    throw new Error(import_typescript4.default.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = import_typescript4.default.parseJsonConfigFileContent(configFile.config, import_typescript4.default.sys, configDir, {
    ...extraOptions,
    baseUrl: extraOptions.baseUrl ?? configFile.config.compilerOptions?.baseUrl ?? configDir,
    ignoreDeprecations: extraOptions.ignoreDeprecations ?? configFile.config.compilerOptions?.ignoreDeprecations ?? "6.0",
    paths: {
      ...configFile.config.compilerOptions?.paths ?? {},
      ...extraOptions.paths ?? {}
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(import_typescript4.default.formatDiagnosticsWithColorAndContext(parsedConfig.errors, import_typescript4.default.createCompilerHost({})));
  }
  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
}
var import_fs3, import_path6, import_typescript4, compilerOptionsCache;
var init_compiler_options = __esm(() => {
  init_hash();
  import_fs3 = __toESM(require("fs"));
  import_path6 = __toESM(require("path"));
  import_typescript4 = __toESM(require("typescript"));
  compilerOptionsCache = new Map;
});

// src/api/types.ts
var DEFAULT_BUILD_OPTIONS;
var init_types = __esm(() => {
  DEFAULT_BUILD_OPTIONS = Object.freeze({
    cache: {
      dir: "",
      mode: "persistent"
    },
    compilationLevel: "ADVANCED",
    chunks: {
      baseChunkName: "main",
      loader: "script",
      manifestFile: "",
      mode: "off",
      publicPath: "./"
    },
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
});

// src/cache/store.ts
function getProjectCacheDir(rootDir, projectRoot) {
  return import_path9.default.join(rootDir, hashContent(projectRoot));
}
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return import_path9.default.join(import_os.default.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return import_path9.default.join(process.env.LOCALAPPDATA ?? import_path9.default.join(import_os.default.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return import_path9.default.join(process.env.XDG_CACHE_HOME ?? import_path9.default.join(import_os.default.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await import_fs7.default.promises.mkdtemp(import_path9.default.join(import_os.default.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = import_path9.default.join(rootDir2, "workspace");
    await import_fs7.default.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await import_fs7.default.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = import_path9.default.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = getProjectCacheDir(rootDir, projectRoot);
  const workspaceDir = import_path9.default.join(projectCacheDir, "workspace");
  await import_fs7.default.promises.mkdir(workspaceDir, { recursive: true });
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
    const raw = await import_fs7.default.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function writeJson(filePath, value) {
  await ensureParentDirectory(filePath);
  await import_fs7.default.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
var import_fs7, import_os, import_path9;
var init_store = __esm(() => {
  init_files();
  init_hash();
  import_fs7 = __toESM(require("fs"));
  import_os = __toESM(require("os"));
  import_path9 = __toESM(require("path"));
});

// src/native/load.ts
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  cachedBinding = native_default;
  return cachedBinding;
}
function resolveGraph(input) {
  const result = loadBinding().resolveGraph(input.entries, input.srcDir, input.workspaceDir, input.packageMode);
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(result.fileHashes.map((entry) => [entry.filePath, entry.hash])),
    graph: Object.fromEntries(result.graph.map((entry) => [entry.filePath, entry.dependencies])),
    lazyImports: result.lazyImports,
    packageAliases: result.packageAliases,
    packageJsonFiles: result.packageJsonFiles,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles
  };
}
function planChunks(input) {
  return loadBinding().planChunks(input.chunkMode, input.baseChunkName, input.workspaceDir, input.entryFiles, input.graphEntries, input.lazyImports, input.shimFiles);
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function rewriteDecoratorMetadata(code, propertyRenamingReport) {
  return loadBinding().rewriteDecoratorMetadata(code, propertyRenamingReport);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.explicitExternPaths ?? [], input.outDir, input.externsPath, input.metadataPath, input.chunkMode, input.runtimeModuleSourceMapFile ?? null, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? [], input.lazyImports ?? []);
}
function prepareClosureJobs(input) {
  return loadBinding().prepareClosureJobs(input);
}
function rewriteBundlerRuntimeEs5Helpers(code) {
  return loadBinding().rewriteBundlerRuntimeEs5Helpers(code);
}
function writeEntryShims(input) {
  return loadBinding().writeEntryShims(input.entries);
}
function collectFileStates(filePaths) {
  return loadBinding().collectFileStates(filePaths);
}
function collectPublishedOutputStats(filePaths) {
  return loadBinding().collectPublishedOutputStats(filePaths);
}
function matchFileStates(expected) {
  return loadBinding().matchFileStates(expected);
}
function publishedOutputSnapshotMatches(publishedOutputs, outDir) {
  return loadBinding().publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
function publishedOutputsMatch(outputFiles, outDir) {
  return loadBinding().publishedOutputsMatch(outputFiles, outDir);
}
var cachedBinding = null;
var init_load = __esm(() => {
  init_native();
});

// src/internal/file-state.ts
async function collectTrackedFiles(filePaths) {
  const states = collectFileStates(uniqueSortedStrings(filePaths));
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
  return collectFileStates(uniqueSortedStrings(filePaths)).every((state) => state.exists);
}
async function publishedOutputsMatch2(outputFiles, outDir) {
  return publishedOutputsMatch(uniqueSortedStrings(outputFiles), outDir);
}
async function publishedOutputsMatchSnapshot(publishedOutputs, outDir) {
  return publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
async function collectPublishedOutputStats2(outputFiles) {
  return collectPublishedOutputStats(uniqueSortedStrings(outputFiles));
}
var init_file_state = __esm(() => {
  init_load();
  init_files();
});

// src/pipeline/resolve-build/entries.ts
function resolveOutputNames(entryPaths, outputNames) {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }
    return outputNames;
  }
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => import_path10.default.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
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
function toBuildEntry(entry, sourceRoot) {
  return {
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: import_path10.default.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  };
}
function toShimFiles(entryFiles, shimDir) {
  return entryFiles.map((entry) => import_path10.default.join(shimDir, `${entry.chunkName}.ts`));
}
var import_path10;
var init_entries = __esm(() => {
  import_path10 = __toESM(require("path"));
});

// src/pipeline/resolve-build/signatures.ts
async function hashTsConfig(configPath) {
  return hashContent(await import_fs8.default.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await import_fs8.default.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
function getPackageRoot() {
  return getPackageRootFromBundle();
}
async function getPackageSignature(packageRoot2 = getPackageRoot()) {
  let packageSignaturePromise = packageSignaturePromises.get(packageRoot2);
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await import_fs8.default.promises.stat(import_path11.default.join(packageRoot2, "package.json"));
      const runtimeSignature = await readRuntimeSignature(packageRoot2);
      const nativeSignature = await readNativeSignature(packageRoot2);
      return hashContent(JSON.stringify({
        nativeSignature,
        packageJson: {
          mtimeMs: packageJsonStat.mtimeMs,
          size: packageJsonStat.size
        },
        runtimeSignature
      }));
    })();
    packageSignaturePromises.set(packageRoot2, packageSignaturePromise);
  }
  return packageSignaturePromise;
}
function getOptionsSignature(options) {
  return hashJson({
    compilationLevel: options.compilationLevel,
    chunks: options.chunks,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => import_path11.default.relative(options.srcDir, entry)),
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
async function readRuntimeSignature(packageRoot2) {
  try {
    const stat = await import_fs8.default.promises.stat(import_path11.default.join(packageRoot2, "dist", "index.mjs"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot2) {
  try {
    const stat = await import_fs8.default.promises.stat(import_path11.default.join(packageRoot2, "native", "index.node"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
var import_fs8, import_path11, packageSignaturePromises;
var init_signatures = __esm(() => {
  init_hash();
  init_bundle_location();
  import_fs8 = __toESM(require("fs"));
  import_path11 = __toESM(require("path"));
  packageSignaturePromises = new Map;
});

// src/pipeline/resolve-build/cache.ts
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = import_path12.default.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
var import_path12;
var init_cache = __esm(() => {
  init_store();
  import_path12 = __toESM(require("path"));
});

// src/pipeline/resolve-build/jsx-runtime.ts
async function collectTsxRuntimeSupport({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return emptyTsxRuntimeSupport();
  }
  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return emptyTsxRuntimeSupport();
  }
  const resolvedEntry = require3.resolve(runtimeSpecifier, {
    paths: [workspaceDir]
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(resolvedEntry, workspaceDir);
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: import_path13.default.join(workspaceDir, "src"),
    workspaceDir
  });
  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles,
    trackedFiles: graph.trackedFiles
  };
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
function mergeTsxRuntimeTrackedFiles(baseTrackedFiles, runtimeTrackedFiles) {
  return uniqueSortedStrings([...baseTrackedFiles, ...runtimeTrackedFiles]);
}
function mergeRuntimePackageJsonFiles(packageJsonFiles, runtimePackageJsonFiles) {
  return uniqueSortedStrings([...packageJsonFiles, ...runtimePackageJsonFiles]);
}
function emptyTsxRuntimeSupport() {
  return {
    packageAliases: [],
    packageJsonFiles: [],
    sourceFiles: [],
    trackedFiles: []
  };
}
function getJsxRuntimeSpecifier(compilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case import_typescript8.default.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case import_typescript8.default.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
function toWorkspaceNodeModulesPath(resolvedPath, workspaceDir) {
  const marker = `${import_path13.default.sep}node_modules${import_path13.default.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return import_path13.default.join(workspaceDir, relativeNodeModulesPath);
}
function toRuntimePackageAlias(specifier, targetPath) {
  const segments = specifier.startsWith("@") ? specifier.split("/", 3) : specifier.split("/", 2);
  const packageName = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  const subpathSegments = specifier.startsWith("@") ? segments.slice(2) : segments.slice(1);
  return {
    packageName,
    subpath: subpathSegments.length > 0 ? `./${subpathSegments.join("/")}` : ".",
    targetPath
  };
}
var import_path13, import_typescript8, require3;
var init_jsx_runtime = __esm(() => {
  init_load();
  init_compiler_options();
  init_files();
  init_bundle_location();
  import_path13 = __toESM(require("path"));
  import_typescript8 = __toESM(require("typescript"));
  require3 = createBundleRequire();
});

// src/pipeline/resolve-build/workspace.ts
async function ensureDirectorySymlink(linkPath, targetPath) {
  try {
    const currentTarget = await import_fs9.default.promises.readlink(linkPath);
    if (import_path14.default.resolve(import_path14.default.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await import_fs9.default.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await import_fs9.default.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await import_fs9.default.promises.mkdir(import_path14.default.dirname(linkPath), { recursive: true });
  await import_fs9.default.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = import_path14.default.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = import_path14.default.join(options.projectRoot, "node_modules");
  const hasNodeModules = await import_fs9.default.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = import_typescript9.default.findConfigFile(projectRoot, import_typescript9.default.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function removePathIfExists(targetPath) {
  try {
    await import_fs9.default.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
var import_fs9, import_path14, import_typescript9;
var init_workspace = __esm(() => {
  import_fs9 = __toESM(require("fs"));
  import_path14 = __toESM(require("path"));
  import_typescript9 = __toESM(require("typescript"));
});

// src/internal/timing.ts
function logInternalTiming(label, durationMs) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }
  console.error(`[gcc-ts-bundler timing] ${label}: ${durationMs.toFixed(1)}ms`);
}
function logInternalDetail(label, detail) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return;
  }
  console.error(`[gcc-ts-bundler timing] ${label}: ${detail}`);
}
async function withInternalTiming(label, work) {
  if (!SHOW_INTERNAL_TIMINGS) {
    return await work();
  }
  const startedAt = import_node_perf_hooks.performance.now();
  try {
    return await work();
  } finally {
    logInternalTiming(label, import_node_perf_hooks.performance.now() - startedAt);
  }
}
var import_node_perf_hooks, SHOW_INTERNAL_TIMINGS;
var init_timing = __esm(() => {
  import_node_perf_hooks = require("node:perf_hooks");
  SHOW_INTERNAL_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";
});

// src/pipeline/resolve-build/options.ts
function normalizeBuildOptions(options) {
  const projectRoot = import_path15.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path15.default.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = import_path15.default.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  const chunkPublicPath = normalizeChunkPublicPath(options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath);
  const chunkManifestFile = import_path15.default.basename(options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile);
  return {
    cache: {
      dir: options.cache?.dir ? import_path15.default.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
    },
    chunks: {
      baseChunkName: options.chunks?.baseChunkName ?? DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      loader: normalizeChunkLoader(options.chunks?.loader ?? DEFAULT_BUILD_OPTIONS.chunks.loader),
      manifestFile: chunkManifestFile,
      mode: options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
      publicPath: chunkPublicPath
    },
    compilationLevel: options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight: options.diagnostics?.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose: options.diagnostics?.verbose ?? DEFAULT_BUILD_OPTIONS.diagnostics.verbose
    },
    entries: options.entries.map((entry) => import_path15.default.isAbsolute(entry) ? entry : import_path15.default.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => import_path15.default.isAbsolute(filePath) ? filePath : import_path15.default.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => import_path15.default.isAbsolute(filePath) ? filePath : import_path15.default.resolve(projectRoot, filePath)),
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
function normalizeChunkPublicPath(publicPath) {
  if (publicPath.length === 0) {
    return "./";
  }
  return publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
}
function normalizeChunkLoader(loader) {
  if (loader === "fetch") {
    throw new Error(UNSUPPORTED_FETCH_LOADER_ERROR);
  }
  return "script";
}
var import_path15, UNSUPPORTED_FETCH_LOADER_ERROR = 'gcc-ts-bundler does not support chunks.loader="fetch". Use "script" instead.';
var init_options = __esm(() => {
  init_types();
  import_path15 = __toESM(require("path"));
});

// src/pipeline/resolve-build.ts
async function createBuildContext(options) {
  const packageRoot2 = getPackageRoot();
  const usesPersistentCache = options.cache.mode === "persistent";
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot: packageRoot2,
    packageSignature: usesPersistentCache ? await getPackageSignature(packageRoot2) : "",
    projectCacheDir: getProjectCacheDir(import_path16.default.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), options.projectRoot)
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
  const usesPersistentCache = options.cache.mode === "persistent";
  const sourceRoot = import_path16.default.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = usesPersistentCache ? await hashTsConfig(tsConfigPath) : "";
  const entryRelativePaths = options.entries.map((entry) => import_path16.default.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => import_path16.default.join(sourceRoot, import_path16.default.relative(options.srcDir, entry)));
  const resolveSnapshotPath = import_path16.default.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = usesPersistentCache ? await readJsonIfExists(resolveSnapshotPath) : null;
  const resolveSnapshotHit = !!cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles);
  if (usesPersistentCache) {
    logInternalDetail("cache:resolve-snapshot", resolveSnapshotHit ? "hit" : "miss");
  }
  if (cachedSnapshot && resolveSnapshotHit) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
    const shimDir2 = import_path16.default.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      lazyImports: cachedSnapshot.lazyImports ?? [],
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: import_path16.default.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: import_path16.default.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: shimFiles2,
      sourceFiles: cachedSnapshot.sourceFiles,
      tsxRuntimeSourceFiles: cachedSnapshot.tsxRuntimeSourceFiles ?? [],
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
  const resolvedLazyImports = graphResult.lazyImports;
  const tsxRuntimeSupport = await collectTsxRuntimeSupport({
    fileNames: graphResult.sourceFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  });
  const packageAliases = mergePackageAliases([
    ...graphResult.packageAliases,
    ...tsxRuntimeSupport.packageAliases
  ]);
  const packageJsonFiles = mergeRuntimePackageJsonFiles(graphResult.packageJsonFiles, tsxRuntimeSupport.packageJsonFiles);
  const resolveKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature,
    tsxRuntimeSourceFiles: tsxRuntimeSupport.sourceFiles
  }) : "active";
  const resolveMetadataPath = import_path16.default.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = usesPersistentCache ? await readJsonIfExists(resolveMetadataPath) : null;
  if (resolveMetadata) {
    resolveMetadata = {
      ...resolveMetadata,
      packageAliases: resolveMetadata.packageAliases ?? packageAliases,
      packageJsonFiles: resolveMetadata.packageJsonFiles ?? packageJsonFiles,
      tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? tsxRuntimeSupport.sourceFiles
    };
  }
  if (!resolveMetadata) {
    const entryFiles2 = graphResult.entries.map((entry, index) => ({
      chunkName: sanitizeChunkName(outputNames[index]),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: outputNames[index],
      sourcePath: entry.sourcePath,
      sourceRelativePath: import_path16.default.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = import_path16.default.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    resolveMetadata = {
      chunkPlan: planChunks({
        baseChunkName: options.chunks.baseChunkName,
        chunkMode: options.chunks.mode,
        entryFiles: entryFiles2.map((entry) => ({
          chunkName: entry.chunkName,
          outputName: entry.outputName,
          sourcePath: entry.sourcePath
        })),
        graphEntries: [
          ...Object.entries(graphResult.graph).map(([filePath, dependencies]) => ({
            dependencies,
            filePath
          })),
          ...shimFiles2.map((shimFile, index) => ({
            dependencies: [entryFiles2[index].sourcePath],
            filePath: shimFile
          }))
        ],
        lazyImports: resolvedLazyImports,
        shimFiles: shimFiles2,
        workspaceDir: cacheStore.workspaceDir
      }),
      entryFiles: entryFiles2.map((entry) => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath
      })),
      lazyImports: resolvedLazyImports,
      packageAliases,
      packageJsonFiles,
      tsxRuntimeSourceFiles: tsxRuntimeSupport.sourceFiles
    };
    if (usesPersistentCache) {
      await writeJson(resolveMetadataPath, resolveMetadata);
    }
  } else if (usesPersistentCache && (!Array.isArray(resolveMetadata.packageAliases) || !Array.isArray(resolveMetadata.packageJsonFiles) || !Array.isArray(resolveMetadata.tsxRuntimeSourceFiles))) {
    await writeJson(resolveMetadataPath, resolveMetadata);
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
  const shimDir = import_path16.default.join(cacheStore.workspaceDir, "entries");
  const shimFiles = toShimFiles(entryFiles, shimDir);
  const nativeEmitKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    externInputHash: await hashExternalInputs(options.externs),
    packageSignature: context.packageSignature,
    resolveKey,
    tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? []
  }) : "active";
  const finalKey = usesPersistentCache ? hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash: await hashExternalInputs([
      ...options.externs,
      ...options.js
    ]),
    languageOut: options.languageOut,
    packageSignature: context.packageSignature,
    resolveKey,
    tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? []
  }) : "active";
  const trackedFiles = usesPersistentCache ? await collectTrackedFiles([
    ...mergeTsxRuntimeTrackedFiles(graphResult.trackedFiles, tsxRuntimeSupport.trackedFiles),
    tsConfigPath,
    ...options.externs,
    ...options.js
  ]) : {};
  if (usesPersistentCache) {
    await writeJson(resolveSnapshotPath, {
      compilerOptionsHash,
      entryFiles: resolveMetadata.entryFiles,
      finalKey,
      lazyImports: resolvedLazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases,
      packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey,
      sourceFiles: graphResult.sourceFiles,
      tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
      trackedFiles
    });
  }
  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    lazyImports: resolvedLazyImports,
    packageAliases,
    packageJsonFiles,
    finalCacheDir: import_path16.default.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: import_path16.default.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
    tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  };
}
var import_path16;
var init_resolve_build = __esm(() => {
  init_hash();
  init_store();
  init_file_state();
  init_load();
  init_entries();
  init_signatures();
  init_cache();
  init_jsx_runtime();
  init_workspace();
  init_timing();
  init_options();
  init_signatures();
  import_path16 = __toESM(require("path"));
});

// src/stages/native/closure-ir/decorators.ts
function containsDecorators(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (import_typescript10.default.canHaveDecorators(node) && (import_typescript10.default.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    import_typescript10.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function transpileDecoratedSource({
  compilerOptions,
  fileName,
  sourceText
}) {
  return import_typescript10.default.transpileModule(sourceText, {
    compilerOptions: {
      ...compilerOptions,
      module: import_typescript10.default.ModuleKind.ESNext,
      moduleResolution: import_typescript10.default.ModuleResolutionKind.Bundler,
      sourceMap: false,
      target: import_typescript10.default.ScriptTarget.ES2018
    },
    fileName,
    reportDiagnostics: true
  });
}
var import_typescript10;
var init_decorators = __esm(() => {
  import_typescript10 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata/docs.ts
function createClosureDocRenderContext(sourceFile) {
  return {
    recordNamesByKey: new Map,
    sourceFileStem: sanitizeClosureName(import_path17.default.basename(sourceFile.fileName).replace(/\.[cm]?[jt]sx?$/u, "")),
    typeDeclarations: [],
    usedRecordNames: new Set
  };
}
function buildInterfaceDeclarationSnippet(statement, checker, context) {
  const name = statement.name.text;
  context.usedRecordNames.add(name);
  const lines = ["/**"];
  lines.push(" * @record");
  appendTemplateTags(lines, statement.typeParameters);
  lines.push(" */");
  lines.push(`function ${name}() {}`);
  appendInterfaceMembers(lines, name, statement.members, checker, context);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${name} = ${name};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildTypeAliasDeclarationSnippet(statement, checker, context) {
  if (import_typescript11.default.isTypeLiteralNode(statement.type)) {
    const name = statement.name.text;
    context.usedRecordNames.add(name);
    const lines2 = ["/**"];
    lines2.push(" * @record");
    appendTemplateTags(lines2, statement.typeParameters);
    lines2.push(" */");
    lines2.push(`function ${name}() {}`);
    appendInterfaceMembers(lines2, name, statement.type.members, checker, context);
    if (hasExportModifier(statement)) {
      lines2.push(`exports.${name} = ${name};`);
    }
    return {
      snippet: `${lines2.join(`
`)}
`
    };
  }
  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker, context);
  const lines = ["/**"];
  appendTemplateTags(lines, statement.typeParameters);
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
function buildFunctionJsDoc(statement, checker, context, firstParamObjectRecordTypeName) {
  if (!statement.body) {
    return null;
  }
  const declarations = collectFunctionOverloadDeclarations(statement);
  return buildSignaturesJsDoc({
    checker,
    context,
    declarations,
    firstParamObjectRecordTypeName
  });
}
function buildFunctionObjectParamRecord(statement, checker, context) {
  const firstParameter = statement.parameters[0];
  if (!firstParameter || !import_typescript11.default.isObjectBindingPattern(firstParameter.name) || hasRestElement(firstParameter.name)) {
    return null;
  }
  const parameterType = checker.getTypeAtLocation(firstParameter);
  const recordTypeName = buildRecordForObjectType({
    checker,
    context,
    preferredName: `${statement.name.text}$Param0`,
    type: parameterType
  });
  if (!recordTypeName) {
    return null;
  }
  return {
    snippet: "",
    typeName: recordTypeName
  };
}
function buildClassJsDoc(statement, checker, context) {
  const typeParameters = statement.typeParameters ?? [];
  const tags = [
    ...collectPreservedJsDocTags(statement),
    ...templateTags(typeParameters)
  ];
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureHeritageType(typeNode, checker, context);
        if (!closureType) {
          continue;
        }
        if (clause.token === import_typescript11.default.SyntaxKind.ExtendsKeyword) {
          tags.push({ name: "extends", type: closureType });
        } else if (clause.token === import_typescript11.default.SyntaxKind.ImplementsKeyword) {
          tags.push({ name: "implements", type: closureType });
        }
      }
    }
  }
  return tags.length > 0 ? renderJsDoc(tags) : null;
}
function buildFunctionLikeDoc(declaration, checker, context) {
  if (isBodylessFunctionLikeDeclaration(declaration)) {
    return null;
  }
  const declarations = collectOverloadDeclarations(declaration);
  return buildSignaturesJsDoc({ checker, context, declarations });
}
function buildVariableJsDoc({
  checker,
  context,
  initializer,
  name,
  typeNode
}) {
  if (initializer && (import_typescript11.default.isArrowFunction(initializer) || import_typescript11.default.isFunctionExpression(initializer))) {
    return buildFunctionLikeDoc(initializer, checker, context);
  }
  const type = typeNode ? checker.getTypeFromTypeNode(typeNode) : initializer ? checker.getTypeAtLocation(initializer) : null;
  if (!type || !isWorthAnnotatingVariableType(type, checker)) {
    return null;
  }
  return buildTypeJsDoc(toClosureType(type, checker, context));
}
function buildClassMemberDoc({
  checker,
  context,
  member
}) {
  if (import_typescript11.default.isConstructorDeclaration(member) || import_typescript11.default.isMethodDeclaration(member) || import_typescript11.default.isGetAccessorDeclaration(member) || import_typescript11.default.isSetAccessorDeclaration(member)) {
    return buildFunctionLikeDoc(member, checker, context);
  }
  if (!import_typescript11.default.isPropertyDeclaration(member) || !member.type) {
    return null;
  }
  return buildTypeJsDoc(getTypedDeclarationClosureType(member, checker, context));
}
function buildObjectMemberDoc({
  checker,
  context,
  member
}) {
  if (import_typescript11.default.isMethodDeclaration(member) || import_typescript11.default.isGetAccessorDeclaration(member) || import_typescript11.default.isSetAccessorDeclaration(member)) {
    return buildFunctionLikeDoc(member, checker, context);
  }
  if (import_typescript11.default.isPropertyAssignment(member) && (import_typescript11.default.isArrowFunction(member.initializer) || import_typescript11.default.isFunctionExpression(member.initializer))) {
    return buildFunctionLikeDoc(member.initializer, checker, context);
  }
  if (import_typescript11.default.isPropertyAssignment(member)) {
    const type = checker.getTypeAtLocation(member.initializer);
    return isWorthAnnotatingVariableType(type, checker) ? buildTypeJsDoc(toClosureType(type, checker, context)) : null;
  }
  return null;
}
function toClosureType(type, checker, context, seen = new Set) {
  if (seen.size > MAX_TYPE_DEPTH) {
    return "?";
  }
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);
  if (type.flags & import_typescript11.default.TypeFlags.Any)
    return "?";
  if (type.flags & import_typescript11.default.TypeFlags.Unknown)
    return "?";
  if (type.flags & import_typescript11.default.TypeFlags.StringLike)
    return "string";
  if (type.flags & import_typescript11.default.TypeFlags.NumberLike)
    return "number";
  if (type.flags & import_typescript11.default.TypeFlags.BooleanLike)
    return "boolean";
  if (type.flags & import_typescript11.default.TypeFlags.Void)
    return "void";
  if (type.flags & import_typescript11.default.TypeFlags.Undefined)
    return "undefined";
  if (type.flags & import_typescript11.default.TypeFlags.Null)
    return "null";
  if (type.flags & import_typescript11.default.TypeFlags.Never)
    return "?";
  if (type.flags & import_typescript11.default.TypeFlags.TypeParameter) {
    return sanitizeClosureName(checker.typeToString(type));
  }
  if (type.isUnion()) {
    if (type.types.length > MAX_UNION_MEMBERS) {
      return collapseLargeUnion(type, checker);
    }
    const rendered = uniqueSortedStrings2(type.types.map((item) => toClosureType(item, checker, context, seen)));
    return rendered.length === 1 ? rendered[0] : `(${rendered.join("|")})`;
  }
  if (type.isIntersection()) {
    const recordName2 = buildRecordForObjectType({
      checker,
      context,
      type
    });
    return recordName2 ? `!${recordName2}` : "!Object";
  }
  if (checker.isArrayType(type) || isReadonlyArrayType(type, checker)) {
    const typeArguments = checker.getTypeArguments(type);
    const elementType = typeArguments[0] ? toClosureType(typeArguments[0], checker, context, seen) : "?";
    return `!Array<${elementType}>`;
  }
  if (checker.isTupleType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${uniqueSortedStrings2(typeArguments.map((item) => toClosureType(item, checker, context, seen))).join("|")}>`;
  }
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0 && type.getProperties().length === 0) {
    return signatureToClosureFunctionType(callSignatures[0], checker, context, seen);
  }
  const namedType = renderNamedType(type, checker, context, seen);
  if (namedType) {
    return namedType;
  }
  const recordName = buildRecordForObjectType({ checker, context, type });
  if (recordName) {
    return `!${recordName}`;
  }
  return "?";
}
function buildSignaturesJsDoc({
  checker,
  context,
  declarations,
  firstParamObjectRecordTypeName
}) {
  const signatures = declarations.map((declaration) => ({
    declaration,
    signature: checker.getSignatureFromDeclaration(declaration)
  })).filter((entry) => !!entry.signature);
  if (signatures.length === 0) {
    return null;
  }
  const implementation = declarations[declarations.length - 1];
  const tags = [
    ...collectPreservedJsDocTags(implementation),
    ...uniqueTemplateTags(declarations)
  ];
  const perSignatureParams = signatures.map(({ declaration, signature }) => collectSignatureParamInfos({
    checker,
    context,
    declaration,
    firstParamObjectRecordTypeName,
    signature
  }));
  const thisTypes = uniqueSortedStrings2(perSignatureParams.flatMap((params) => params.filter((param) => param.thisParam)).map((param) => param.type));
  if (thisTypes.length > 0) {
    tags.push({ name: "this", type: mergeClosureTypes(thisTypes) });
  }
  const realParams = perSignatureParams.map((params) => params.filter((param) => !param.thisParam));
  const maxParamCount = Math.max(0, ...realParams.map((params) => params.length));
  const minParamCount = Math.min(...realParams.map((params) => params.filter((param) => !param.rest).length));
  let foundOptional = false;
  for (let index = 0;index < maxParamCount; index += 1) {
    const candidates = realParams.map((params) => params[index]).filter((param) => !!param);
    if (candidates.length === 0) {
      continue;
    }
    const first = candidates[0];
    const rest = candidates.some((param) => param.rest);
    const isOptional = !rest && (foundOptional || index >= minParamCount || candidates.some((param) => param.optional));
    foundOptional ||= isOptional;
    const mergedType = mergeClosureTypes(candidates.map((param) => isOptional ? stripUndefinedFromClosureType(param.type) : param.type));
    tags.push({
      name: "param",
      text: first.name,
      type: `${rest ? "..." : ""}${mergedType}${isOptional ? "=" : ""}`
    });
    if (rest) {
      break;
    }
  }
  if (!signatures.some(({ declaration }) => import_typescript11.default.isConstructorDeclaration(declaration)) && !isSetterDeclaration(implementation)) {
    tags.push({
      name: "return",
      type: mergeClosureTypes(signatures.map(({ signature }) => toClosureType(checker.getReturnTypeOfSignature(signature), checker, context)))
    });
  }
  return renderJsDoc(tags);
}
function buildTypeJsDoc(closureType) {
  return renderJsDoc([{ name: "type", type: closureType }]);
}
function appendInterfaceMembers(lines, typeName, members, checker, context) {
  for (const member of members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      continue;
    }
    if (import_typescript11.default.isPropertySignature(member)) {
      const propertyType = getTypedDeclarationClosureType(member, checker, context);
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
      continue;
    }
    if (import_typescript11.default.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(signature, checker, context);
      lines.push(`/** @type {${functionType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
    }
  }
}
function buildRecordForObjectType({
  checker,
  context,
  preferredName,
  type
}) {
  const properties = checker.getPropertiesOfType(type).filter((property) => {
    const name = property.getName();
    return name !== "__type" && !name.startsWith("__@");
  });
  if (properties.length === 0 || properties.length > MAX_RECORD_PROPERTIES || context.recordNamesByKey.size > MAX_RECORDS_PER_FILE || isGlobalObjectType(type, checker)) {
    return null;
  }
  const key = structuralRecordKey(type, checker, properties);
  const current = context.recordNamesByKey.get(key);
  if (current) {
    return current;
  }
  const baseName = preferredName ? sanitizeClosureName(preferredName) : `${context.sourceFileStem}$Record${context.recordNamesByKey.size}`;
  const recordName = reserveRecordName(baseName, context);
  context.recordNamesByKey.set(key, recordName);
  const lines = ["/**", " * @record", " */", `function ${recordName}() {}`];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : checker.getTypeOfSymbol(property);
    lines.push(`/** @type {${toClosureType(propertyType, checker, context, new Set([type]))}} */`);
    lines.push(renderPrototypeProperty(recordName, property.getName()));
  }
  context.typeDeclarations.push({ snippet: `${lines.join(`
`)}
` });
  return recordName;
}
function getTypedDeclarationClosureType(declaration, checker, context) {
  const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
  const type = symbol ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : declaration.type ? checker.getTypeFromTypeNode(declaration.type) : checker.getTypeAtLocation(declaration);
  const closureType = toClosureType(type, checker, context);
  return declaration.questionToken ? unionClosureTypes([closureType, "undefined"]) : closureType;
}
function renderNamedType(type, checker, context, seen) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) {
    return null;
  }
  if (!type.aliasSymbol && !isTypeLikeSymbol(symbol)) {
    return null;
  }
  const symbolName = checker.symbolToString(symbol);
  if (!symbolName || symbolName === "__type" || !isClosureQualifiedName(symbolName)) {
    return null;
  }
  if (["Array", "ReadonlyArray"].includes(symbolName)) {
    return null;
  }
  const builtinType = renderBuiltinNamedType(symbolName, type, checker, context, seen);
  if (builtinType) {
    return builtinType;
  }
  if (symbolName === "Record" && type.aliasTypeArguments && type.aliasTypeArguments.length >= 2) {
    return `!Object<${toClosureType(type.aliasTypeArguments[0], checker, context, seen)}, ${toClosureType(type.aliasTypeArguments[1], checker, context, seen)}>`;
  }
  if (isDeclarationFileSymbol(symbol) && !(symbol.flags & (import_typescript11.default.SymbolFlags.Class | import_typescript11.default.SymbolFlags.Enum)) && type.getProperties().length > 0) {
    const recordName = buildRecordForObjectType({
      checker,
      context,
      preferredName: symbolName,
      type
    });
    return recordName ? `!${recordName}` : null;
  }
  if (isGlobalObjectType(type, checker)) {
    return "!Object";
  }
  const args = checker.getTypeArguments(type);
  const renderedArgs = args.map((arg) => toClosureType(arg, checker, context, seen));
  return renderedArgs.length > 0 ? `!${symbolName}<${renderedArgs.join(", ")}>` : `!${symbolName}`;
}
function renderBuiltinNamedType(symbolName, type, checker, context, seen) {
  const closureName = BUILTIN_GENERIC_TYPE_NAMES.get(symbolName);
  if (closureName) {
    const args = checker.getTypeArguments(type);
    const renderedArgs = args.map((arg) => toClosureType(arg, checker, context, seen));
    return renderedArgs.length > 0 ? `!${closureName}<${renderedArgs.join(", ")}>` : `!${closureName}`;
  }
  if (!BUILTIN_TYPE_NAMES.has(symbolName)) {
    return null;
  }
  if (symbolName === "Object") {
    return "!Object";
  }
  if (symbolName === "Function") {
    return "!Function";
  }
  return `!${symbolName}`;
}
function isTypeLikeSymbol(symbol) {
  return Boolean(symbol.flags & (import_typescript11.default.SymbolFlags.Class | import_typescript11.default.SymbolFlags.Enum | import_typescript11.default.SymbolFlags.Interface | import_typescript11.default.SymbolFlags.TypeAlias | import_typescript11.default.SymbolFlags.TypeParameter));
}
function isDeclarationFileSymbol(symbol) {
  return (symbol.declarations ?? []).some((declaration) => declaration.getSourceFile().isDeclarationFile);
}
function signatureToClosureFunctionType(signature, checker, context, seen = new Set) {
  const params = collectSignatureParamInfos({
    checker,
    context,
    declaration: signature.declaration,
    signature
  }).filter((parameter) => !parameter.thisParam).map((parameter) => `${parameter.rest ? "..." : ""}${parameter.optional ? stripUndefinedFromClosureType(parameter.type) : parameter.type}${parameter.optional ? "=" : ""}`);
  const returnType = toClosureType(checker.getReturnTypeOfSignature(signature), checker, context, new Set(seen));
  return `function(${params.join(", ")}): ${returnType}`;
}
function collectFunctionOverloadDeclarations(implementation) {
  if (!implementation.name || !implementation.body) {
    return [implementation];
  }
  if (!import_typescript11.default.isSourceFile(implementation.parent) && !import_typescript11.default.isModuleBlock(implementation.parent)) {
    return [implementation];
  }
  const declarations = implementation.parent.statements.filter((statement) => import_typescript11.default.isFunctionDeclaration(statement) && statement.name?.text === implementation.name?.text);
  const implementationIndex = declarations.indexOf(implementation);
  return implementationIndex > 0 ? declarations.slice(0, implementationIndex + 1) : [implementation];
}
function collectOverloadDeclarations(implementation) {
  if (!hasFunctionBody(implementation)) {
    return [implementation];
  }
  if (import_typescript11.default.isFunctionDeclaration(implementation)) {
    return collectFunctionOverloadDeclarations(implementation);
  }
  if (import_typescript11.default.isMethodDeclaration(implementation) || import_typescript11.default.isConstructorDeclaration(implementation)) {
    const members = import_typescript11.default.isClassDeclaration(implementation.parent) || import_typescript11.default.isClassExpression(implementation.parent) ? implementation.parent.members : undefined;
    if (!members) {
      return [implementation];
    }
    const implementationName = getClassMemberName(implementation);
    const candidates = members.filter((member) => (import_typescript11.default.isMethodDeclaration(member) || import_typescript11.default.isConstructorDeclaration(member)) && getClassMemberName(member) === implementationName);
    const implementationIndex = candidates.indexOf(implementation);
    return implementationIndex > 0 ? candidates.slice(0, implementationIndex + 1) : [implementation];
  }
  return [implementation];
}
function collectSignatureParamInfos({
  checker,
  context,
  declaration,
  firstParamObjectRecordTypeName,
  signature
}) {
  const parameters = getDeclarationParameters(declaration);
  return parameters.map((parameter, index) => {
    const thisParam = isThisParameter(parameter);
    const rest = !!parameter.dotDotDotToken;
    const optional = !!parameter.questionToken || !!parameter.initializer;
    const name = index === 0 && firstParamObjectRecordTypeName ? "__props" : parameterNameForJsDoc(parameter, index);
    const type = index === 0 && firstParamObjectRecordTypeName ? `!${firstParamObjectRecordTypeName}` : renderParameterType(parameter, checker, context, rest);
    return {
      name,
      optional,
      rest,
      thisParam,
      type
    };
  });
}
function renderParameterType(parameter, checker, context, rest) {
  const type = checker.getTypeAtLocation(parameter);
  if (!rest) {
    return toClosureType(type, checker, context);
  }
  const elementType = getArrayElementType(type, checker);
  return elementType ? toClosureType(elementType, checker, context) : "?";
}
function getArrayElementType(type, checker) {
  if (!checker.isArrayType(type) && !isReadonlyArrayType(type, checker)) {
    return null;
  }
  return checker.getTypeArguments(type)[0] ?? null;
}
function hasFunctionBody(declaration) {
  return "body" in declaration && !!declaration.body;
}
function isBodylessFunctionLikeDeclaration(declaration) {
  return "body" in declaration && !declaration.body;
}
function isThisParameter(parameter) {
  return import_typescript11.default.isIdentifier(parameter.name) && parameter.name.text === "this";
}
function mergeClosureTypes(types) {
  return unionClosureTypes(types.filter(Boolean));
}
function unionClosureTypes(types) {
  const unique = uniqueSortedStrings2(types.flatMap(expandClosureUnionType));
  return unique.length === 1 ? unique[0] : `(${unique.join("|")})`;
}
function expandClosureUnionType(type) {
  return type.startsWith("(") && type.endsWith(")") ? splitTopLevelUnion(type.slice(1, -1)) : [type];
}
function stripUndefinedFromClosureType(type) {
  if (type === "undefined") {
    return "?";
  }
  if (!type.includes("undefined")) {
    return type;
  }
  if (!type.startsWith("(") || !type.endsWith(")")) {
    return type;
  }
  const parts = splitTopLevelUnion(type.slice(1, -1)).filter((part) => part !== "undefined");
  return parts.length === 0 ? "?" : parts.length === 1 ? parts[0] : `(${parts.join("|")})`;
}
function splitTopLevelUnion(type) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0;index < type.length; index += 1) {
    const char = type[index];
    if (char === "<" || char === "(" || char === "{") {
      depth += 1;
    } else if (char === ">" || char === ")" || char === "}") {
      depth -= 1;
    } else if (char === "|" && depth === 0) {
      parts.push(type.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(type.slice(start));
  return parts;
}
function collectPreservedJsDocTags(node) {
  const tags = [];
  for (const tag of import_typescript11.default.getJSDocTags(node)) {
    const name = tag.tagName.text;
    if (CONFLICTING_GENERATED_TAGS.has(name)) {
      continue;
    }
    const text = jsDocCommentText(tag.comment);
    tags.push(text ? { name, text } : { name });
  }
  return tags;
}
function jsDocCommentText(comment) {
  if (!comment) {
    return "";
  }
  if (typeof comment === "string") {
    return comment.trim();
  }
  return comment.map((part) => part.getText()).join(" ").trim();
}
function uniqueTemplateTags(declarations) {
  return uniqueSortedStrings2(declarations.flatMap((declaration) => getTemplateNames(getSignatureTypeParameters(declaration)))).map((name) => ({ name: "template", text: name }));
}
function templateTags(typeParameters) {
  return getTemplateNames(typeParameters).map((name) => ({
    name: "template",
    text: name
  }));
}
function renderJsDoc(tags) {
  const lines = ["/**"];
  for (const tag of tags) {
    if (!tag.name) {
      continue;
    }
    if (tag.type && tag.text) {
      lines.push(` * @${tag.name} {${tag.type}} ${tag.text}`);
    } else if (tag.type) {
      lines.push(` * @${tag.name} {${tag.type}}`);
    } else if (tag.text) {
      lines.push(` * @${tag.name} ${tag.text}`);
    } else {
      lines.push(` * @${tag.name}`);
    }
  }
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function toClosureHeritageType(typeNode, checker, context) {
  const expressionName = getHeritageExpressionName(typeNode.expression);
  if (expressionName) {
    const args = (typeNode.typeArguments ?? []).map((argument) => toClosureType(checker.getTypeFromTypeNode(argument), checker, context));
    return args.length > 0 ? `${expressionName}<${args.join(", ")}>` : expressionName;
  }
  return toClosureType(checker.getTypeAtLocation(typeNode), checker, context).replace(/^!/, "").replace(/<this>$/u, "").replace(/,\s*this(?=>)/gu, "");
}
function getHeritageExpressionName(expression) {
  if (import_typescript11.default.isIdentifier(expression)) {
    return expression.text;
  }
  if (import_typescript11.default.isPropertyAccessExpression(expression)) {
    const left = getHeritageExpressionName(expression.expression);
    return left ? `${left}.${expression.name.text}` : null;
  }
  return null;
}
function collapseLargeUnion(type, checker) {
  const nonNullable = type.types.filter((item) => !(item.flags & import_typescript11.default.TypeFlags.Null) && !(item.flags & import_typescript11.default.TypeFlags.Undefined));
  const suffix = type.types.filter((item) => item.flags & (import_typescript11.default.TypeFlags.Null | import_typescript11.default.TypeFlags.Undefined)).map((item) => item.flags & import_typescript11.default.TypeFlags.Null ? "null" : "undefined");
  if (nonNullable.every((item) => item.flags & import_typescript11.default.TypeFlags.StringLike)) {
    return unionWithSuffix("string", suffix);
  }
  if (nonNullable.every((item) => item.flags & import_typescript11.default.TypeFlags.NumberLike)) {
    return unionWithSuffix("number", suffix);
  }
  if (nonNullable.every((item) => item.flags & import_typescript11.default.TypeFlags.BooleanLike)) {
    return unionWithSuffix("boolean", suffix);
  }
  if (nonNullable.every((item) => checker.isArrayType(item))) {
    return unionWithSuffix("!Array<?>", suffix);
  }
  if (nonNullable.every((item) => item.getProperties().length > 0)) {
    return unionWithSuffix("!Object", suffix);
  }
  return unionWithSuffix("?", suffix);
}
function unionWithSuffix(base, suffix) {
  const rendered = uniqueSortedStrings2([base, ...suffix]);
  return rendered.length === 1 ? rendered[0] : `(${rendered.join("|")})`;
}
function isWorthAnnotatingVariableType(type, checker) {
  if (type.flags & (import_typescript11.default.TypeFlags.Any | import_typescript11.default.TypeFlags.Unknown | import_typescript11.default.TypeFlags.StringLike | import_typescript11.default.TypeFlags.NumberLike | import_typescript11.default.TypeFlags.BooleanLike | import_typescript11.default.TypeFlags.Void | import_typescript11.default.TypeFlags.Undefined | import_typescript11.default.TypeFlags.Null | import_typescript11.default.TypeFlags.Never)) {
    return false;
  }
  return checker.isArrayType(type) || checker.isTupleType(type) || type.getCallSignatures().length > 0 || type.getProperties().length > 0 || Boolean(type.getSymbol() || type.aliasSymbol);
}
function getSignatureTypeParameters(declaration) {
  return "typeParameters" in declaration ? declaration.typeParameters : undefined;
}
function getDeclarationParameters(declaration) {
  return "parameters" in declaration ? declaration.parameters : [];
}
function parameterNameForJsDoc(declaration, index) {
  if (declaration && import_typescript11.default.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return `__param${index}`;
}
function appendTemplateTags(lines, typeParameters) {
  for (const tag of templateTags(typeParameters)) {
    lines.push(` * @template ${tag.text}`);
  }
}
function getTemplateNames(typeParameters) {
  return (typeParameters ?? []).map((parameter) => sanitizeClosureName(parameter.name.text));
}
function hasExportModifier(node) {
  return (import_typescript11.default.getCombinedModifierFlags(node) & import_typescript11.default.ModifierFlags.Export) !== 0;
}
function hasRestElement(pattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}
function getPropertyNameText2(name) {
  if (!name) {
    return null;
  }
  if (import_typescript11.default.isIdentifier(name) || import_typescript11.default.isStringLiteral(name) || import_typescript11.default.isNumericLiteral(name) || import_typescript11.default.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function getClassMemberName(member) {
  if (import_typescript11.default.isConstructorDeclaration(member)) {
    return "constructor";
  }
  return getPropertyNameText2(member.name);
}
function getObjectPropertyName(member) {
  if (import_typescript11.default.isPropertyAssignment(member) || import_typescript11.default.isMethodDeclaration(member) || import_typescript11.default.isGetAccessorDeclaration(member) || import_typescript11.default.isSetAccessorDeclaration(member) || import_typescript11.default.isShorthandPropertyAssignment(member)) {
    return getPropertyNameText2(member.name);
  }
  return null;
}
function hasStaticModifier2(node) {
  return (import_typescript11.default.getCombinedModifierFlags(node) & import_typescript11.default.ModifierFlags.Static) !== 0;
}
function isSetterDeclaration(declaration) {
  return import_typescript11.default.isSetAccessorDeclaration(declaration);
}
function renderPrototypeProperty(typeName, propertyName) {
  return isClosureIdentifier(propertyName) ? `${typeName}.prototype.${propertyName};` : `${typeName}.prototype[${JSON.stringify(propertyName)}];`;
}
function reserveRecordName(baseName, context) {
  let candidate = baseName || "Record";
  let index = 0;
  while (context.usedRecordNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}${index}`;
  }
  context.usedRecordNames.add(candidate);
  return candidate;
}
function structuralRecordKey(type, checker, properties) {
  const typeId = type.id;
  if (typeof typeId === "number") {
    return `id:${typeId}`;
  }
  return properties.map((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const propertyType = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : checker.getTypeOfSymbol(property);
    return `${property.getName()}:${checker.typeToString(propertyType)}`;
  }).sort((left, right) => left.localeCompare(right)).join("|");
}
function isReadonlyArrayType(type, checker) {
  const symbol = type.getSymbol();
  return symbol ? checker.symbolToString(symbol) === "ReadonlyArray" : false;
}
function isGlobalObjectType(type, checker) {
  const symbol = type.getSymbol();
  if (!symbol) {
    return false;
  }
  return BUILTIN_TYPE_NAMES.has(checker.symbolToString(symbol));
}
function sanitizeClosureName(name) {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!sanitized || /^[0-9]/u.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}
function isClosureIdentifier(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}
function isClosureQualifiedName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(name);
}
function uniqueSortedStrings2(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
var import_path17, import_typescript11, MAX_RECORDS_PER_FILE = 160, MAX_RECORD_PROPERTIES = 48, MAX_TYPE_DEPTH = 28, MAX_UNION_MEMBERS = 16, BUILTIN_TYPE_NAMES, BUILTIN_GENERIC_TYPE_NAMES, CONFLICTING_GENERATED_TAGS;
var init_docs = __esm(() => {
  import_path17 = __toESM(require("path"));
  import_typescript11 = __toESM(require("typescript"));
  BUILTIN_TYPE_NAMES = new Set([
    "AbortController",
    "AbortSignal",
    "Array",
    "ArrayBuffer",
    "AsyncIterable",
    "AsyncIterator",
    "BigInt64Array",
    "BigUint64Array",
    "Blob",
    "DataView",
    "Date",
    "Error",
    "Float32Array",
    "Float64Array",
    "FormData",
    "Function",
    "Headers",
    "Int16Array",
    "Int32Array",
    "Int8Array",
    "Iterable",
    "Iterator",
    "Map",
    "Object",
    "Promise",
    "ReadonlyArray",
    "ReadonlyMap",
    "ReadonlySet",
    "ReadableStream",
    "ReadableStreamDefaultController",
    "ReadableStreamDefaultReader",
    "RegExp",
    "Request",
    "Response",
    "Set",
    "TextDecoder",
    "TextEncoder",
    "TransformStream",
    "URL",
    "URLSearchParams",
    "Uint16Array",
    "Uint32Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "WeakMap",
    "WeakSet",
    "WritableStream",
    "WritableStreamDefaultController",
    "WritableStreamDefaultWriter"
  ]);
  BUILTIN_GENERIC_TYPE_NAMES = new Map([
    ["AsyncIterable", "AsyncIterable"],
    ["AsyncIterator", "AsyncIterator"],
    ["Iterable", "Iterable"],
    ["Iterator", "Iterator"],
    ["Map", "Map"],
    ["Promise", "Promise"],
    ["ReadonlyMap", "Map"],
    ["ReadonlySet", "Set"],
    ["Set", "Set"],
    ["WeakMap", "WeakMap"],
    ["WeakSet", "WeakSet"]
  ]);
  CONFLICTING_GENERATED_TAGS = new Set([
    "argument",
    "constructor",
    "extends",
    "implements",
    "param",
    "return",
    "template",
    "this",
    "type",
    "typedef"
  ]);
});

// src/stages/native/closure-ir/metadata/enums.ts
function collectUnsafeEnumSymbols(sourceFiles, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & import_typescript12.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node) => {
      if (import_typescript12.default.isElementAccessExpression(node) && import_typescript12.default.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (import_typescript12.default.isCallExpression(node) && import_typescript12.default.isPropertyAccessExpression(node.expression) && import_typescript12.default.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && import_typescript12.default.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (import_typescript12.default.isIdentifier(node) && !import_typescript12.default.isPropertyAccessExpression(node.parent) && !import_typescript12.default.isElementAccessExpression(node.parent) && !import_typescript12.default.isImportSpecifier(node.parent) && !import_typescript12.default.isImportClause(node.parent) && !import_typescript12.default.isExportSpecifier(node.parent) && !import_typescript12.default.isEnumDeclaration(node.parent) && !import_typescript12.default.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & import_typescript12.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & import_typescript12.default.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      import_typescript12.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & import_typescript12.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }
  const members = [];
  let valueType = null;
  let nextNumber = 0;
  for (const member of statement.members) {
    const memberName = getPropertyNameText3(member.name);
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
    exported: hasExportModifier2(statement),
    members,
    name: statement.name.text,
    valueType
  };
}
function hasExportModifier2(node) {
  return (import_typescript12.default.getCombinedModifierFlags(node) & import_typescript12.default.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (import_typescript12.default.getCombinedModifierFlags(node) & import_typescript12.default.ModifierFlags.Const) !== 0;
}
function getPropertyNameText3(name) {
  if (!name) {
    return null;
  }
  if (import_typescript12.default.isIdentifier(name) || import_typescript12.default.isStringLiteral(name) || import_typescript12.default.isNumericLiteral(name) || import_typescript12.default.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function literalValueFromExpression(expression) {
  if (import_typescript12.default.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (import_typescript12.default.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === import_typescript12.default.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === import_typescript12.default.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (import_typescript12.default.isPrefixUnaryExpression(expression) && expression.operator === import_typescript12.default.SyntaxKind.MinusToken && import_typescript12.default.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text);
  }
  return;
}
var import_typescript12;
var init_enums = __esm(() => {
  import_typescript12 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata/collect.ts
function collectClosureIrFileMetadata({
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols
}) {
  const diagnostics = [];
  const renderContext = createClosureDocRenderContext(sourceFile);
  const explicitTypeDeclarations = features.hasTypeDeclarations ? collectTypeDeclarationsForSourceFile(sourceFile, checker, renderContext) : [];
  const topLevelDocs = features.hasTopLevelDocs ? collectClosureDocsForSourceFile(sourceFile, checker, features, renderContext) : [];
  const typeDeclarations = [
    ...explicitTypeDeclarations,
    ...renderContext.typeDeclarations
  ];
  const enumDeclarations = features.hasEnumDeclarations ? collectEnumDeclarationsForSourceFile(sourceFile, checker, unsafeEnumSymbols) : [];
  const decoratedOutputText = features.hasDecorators ? collectDecoratedOutputText({
    compilerOptions,
    diagnostics,
    fileName: sourceFile.fileName,
    sourceText: sourceFile.getFullText()
  }) : undefined;
  return {
    diagnostics,
    file: {
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations
    }
  };
}
function collectTypeDeclarationsForSourceFile(sourceFile, checker, renderContext) {
  const typeDeclarations = [];
  for (const statement of sourceFile.statements) {
    if (import_typescript13.default.isInterfaceDeclaration(statement)) {
      typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker, renderContext));
      continue;
    }
    if (import_typescript13.default.isTypeAliasDeclaration(statement)) {
      typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker, renderContext));
    }
  }
  return typeDeclarations;
}
function collectClosureDocsForSourceFile(sourceFile, checker, features, renderContext) {
  const topLevelDocs = [];
  const shouldAnnotateJs = !features.docEligibility.isTypeScriptLike && features.docEligibility.hasJsDocText;
  const shouldAnnotateTypeScript = features.docEligibility.isTypeScriptLike;
  const visit = (node) => {
    if (import_typescript13.default.isFunctionDeclaration(node) && node.name) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const objectParamRecord = buildFunctionObjectParamRecord(node, checker, renderContext);
        const jsdoc = buildFunctionJsDoc(node, checker, renderContext, objectParamRecord?.typeName);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: node.name.text
          });
        }
      }
      import_typescript13.default.forEachChild(node, visit);
      return;
    }
    if (import_typescript13.default.isVariableDeclaration(node) && import_typescript13.default.isIdentifier(node.name)) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const jsdoc = buildVariableJsDoc({
          checker,
          context: renderContext,
          initializer: node.initializer,
          name: node.name.text,
          typeNode: node.type
        });
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "variable",
            name: node.name.text
          });
        }
        if (node.initializer && import_typescript13.default.isObjectLiteralExpression(node.initializer)) {
          for (const member of node.initializer.properties) {
            const memberName = getObjectPropertyName(member);
            if (!memberName) {
              continue;
            }
            const memberDoc = buildObjectMemberDoc({
              checker,
              context: renderContext,
              member
            });
            if (memberDoc) {
              topLevelDocs.push({
                jsdoc: memberDoc,
                kind: objectDocKind(member),
                name: memberName,
                owner: node.name.text
              });
            }
          }
        }
      }
      import_typescript13.default.forEachChild(node, visit);
      return;
    }
    if (import_typescript13.default.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      const jsdoc = buildClassJsDoc(node, checker, renderContext);
      if (jsdoc) {
        topLevelDocs.push({
          jsdoc,
          kind: "class",
          name: className
        });
      }
      for (const member of node.members) {
        const memberName = getClassMemberName(member);
        if (!memberName) {
          continue;
        }
        const memberDoc = buildClassMemberDoc({
          checker,
          context: renderContext,
          member
        });
        if (memberDoc) {
          topLevelDocs.push({
            jsdoc: memberDoc,
            kind: classDocKind(member),
            name: memberName,
            owner: className,
            static: hasStaticModifier2(member)
          });
        }
      }
      import_typescript13.default.forEachChild(node, visit);
      return;
    }
    if ((import_typescript13.default.isMethodDeclaration(node) || import_typescript13.default.isGetAccessorDeclaration(node) || import_typescript13.default.isSetAccessorDeclaration(node)) && !import_typescript13.default.isClassDeclaration(node.parent) && !import_typescript13.default.isClassExpression(node.parent) && !import_typescript13.default.isObjectLiteralExpression(node.parent) && shouldAnnotateTypeScript) {
      const name = "name" in node && node.name && import_typescript13.default.isIdentifier(node.name) ? node.name.text : null;
      if (name) {
        const jsdoc = buildFunctionLikeDoc(node, checker, renderContext);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "method",
            name
          });
        }
      }
    }
    import_typescript13.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return topLevelDocs;
}
function objectDocKind(member) {
  if (import_typescript13.default.isGetAccessorDeclaration(member))
    return "objectGetter";
  if (import_typescript13.default.isSetAccessorDeclaration(member))
    return "objectSetter";
  if (import_typescript13.default.isMethodDeclaration(member))
    return "objectMethod";
  return "objectProperty";
}
function classDocKind(member) {
  if (import_typescript13.default.isConstructorDeclaration(member))
    return "constructor";
  if (import_typescript13.default.isGetAccessorDeclaration(member))
    return "getter";
  if (import_typescript13.default.isSetAccessorDeclaration(member))
    return "setter";
  if (import_typescript13.default.isPropertyDeclaration(member))
    return "field";
  return "method";
}
function collectEnumDeclarationsForSourceFile(sourceFile, checker, unsafeEnumSymbols) {
  const enumDeclarations = [];
  for (const statement of sourceFile.statements) {
    if (!import_typescript13.default.isEnumDeclaration(statement)) {
      continue;
    }
    const enumDeclaration = buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols);
    if (enumDeclaration) {
      enumDeclarations.push(enumDeclaration);
    }
  }
  return enumDeclarations;
}
function collectDecoratedOutputText({
  compilerOptions,
  diagnostics,
  fileName,
  sourceText
}) {
  const transpiled = transpileDecoratedSource({
    compilerOptions,
    fileName,
    sourceText
  });
  diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === import_typescript13.default.DiagnosticCategory.Error));
  return transpiled.outputText;
}
var import_typescript13;
var init_collect = __esm(() => {
  init_decorators();
  init_docs();
  init_enums();
  import_typescript13 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata/doc-eligibility.ts
function classifyClosureIrDocEligibility(sourceFile) {
  const exportedDeclarationNames = collectExportedTopLevelDeclarationNames(sourceFile);
  const hasJsDocText = sourceFile.text.includes("/**");
  const hasTsCheckText = sourceFile.text.includes("@ts-check");
  const isTypeScriptLike = isTypeScriptLikeSourceFile(sourceFile);
  let hasTopLevelDocs = false;
  for (const statement of sourceFile.statements) {
    if (isDocRelevantTopLevelDeclaration(statement, {
      exportedDeclarationNames,
      hasJsDocText,
      isTypeScriptLike
    })) {
      hasTopLevelDocs = true;
      break;
    }
  }
  return {
    exportedDeclarationNames,
    hasJsDocText,
    hasTsCheckText,
    hasTopLevelDocs,
    isTypeScriptLike
  };
}
function isDocRelevantTopLevelDeclaration(statement, eligibility) {
  if (!((import_typescript14.default.isFunctionDeclaration(statement) || import_typescript14.default.isClassDeclaration(statement)) && statement.name)) {
    return false;
  }
  if (eligibility.isTypeScriptLike && hasNamedExport(statement, eligibility.exportedDeclarationNames)) {
    return true;
  }
  if (import_typescript14.default.isFunctionDeclaration(statement) && canGenerateComponentObjectParamRecord(statement)) {
    return true;
  }
  return eligibility.hasJsDocText && import_typescript14.default.getJSDocCommentsAndTags(statement).length > 0;
}
function collectExportedTopLevelDeclarationNames(sourceFile) {
  const exportedNames = new Set;
  for (const statement of sourceFile.statements) {
    if ((import_typescript14.default.isFunctionDeclaration(statement) || import_typescript14.default.isClassDeclaration(statement)) && statement.name && hasExportModifier3(statement)) {
      exportedNames.add(statement.name.text);
      continue;
    }
    if (import_typescript14.default.isExportDeclaration(statement) && statement.exportClause) {
      if (import_typescript14.default.isNamedExports(statement.exportClause) && !statement.moduleSpecifier) {
        for (const element of statement.exportClause.elements) {
          exportedNames.add(element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }
    if (import_typescript14.default.isExportAssignment(statement) && import_typescript14.default.isIdentifier(statement.expression)) {
      exportedNames.add(statement.expression.text);
    }
  }
  return exportedNames;
}
function hasNamedExport(statement, exportedNames) {
  return !!statement.name && exportedNames.has(statement.name.text);
}
function hasExportModifier3(node) {
  return (import_typescript14.default.getCombinedModifierFlags(node) & import_typescript14.default.ModifierFlags.Export) !== 0;
}
function canGenerateComponentObjectParamRecord(statement) {
  const firstParameter = statement.parameters[0];
  return !!statement.name && /^[A-Z]/.test(statement.name.text) && !!firstParameter && import_typescript14.default.isObjectBindingPattern(firstParameter.name) && !firstParameter.name.elements.some((element) => element.dotDotDotToken);
}
function isTypeScriptLikeSourceFile(sourceFile) {
  return /\.(?:cts|mts|ts|tsx)$/u.test(sourceFile.fileName);
}
var import_typescript14;
var init_doc_eligibility = __esm(() => {
  import_typescript14 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata/scan.ts
function scanClosureIrSourceFiles({
  fileNames,
  program
}) {
  const inputFiles = new Set(fileNames);
  const files = [];
  let analyzedFileCount = 0;
  let hasEnumDeclarations = false;
  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }
    const features = classifyClosureIrFile(sourceFile);
    if (features.shouldAnalyze) {
      analyzedFileCount += 1;
    }
    if (features.hasEnumDeclarations) {
      hasEnumDeclarations = true;
    }
    files.push({ features, sourceFile });
  }
  return {
    analyzedFileCount,
    files,
    hasEnumDeclarations,
    scannedFileCount: files.length
  };
}
function classifyClosureIrSourceFile(sourceFile) {
  let hasEnumDeclarations = false;
  let hasTypeDeclarations = false;
  for (const statement of sourceFile.statements) {
    if (import_typescript15.default.isInterfaceDeclaration(statement) || import_typescript15.default.isTypeAliasDeclaration(statement)) {
      hasTypeDeclarations = true;
      continue;
    }
    if (import_typescript15.default.isEnumDeclaration(statement)) {
      hasEnumDeclarations = true;
      continue;
    }
  }
  const docEligibility = classifyClosureIrDocEligibility(sourceFile);
  const hasExplicitTypeSignals = sourceFile.statements.some(containsExplicitTypeSignal);
  const hasTypeDrivenClosureDocs = docEligibility.isTypeScriptLike && hasExplicitTypeSignals;
  const hasDecorators = sourceFile.text.includes("@") && containsDecorators(sourceFile);
  const needsSemanticPreflight = docEligibility.hasJsDocText || docEligibility.hasTsCheckText || hasDecorators || hasEnumDeclarations || hasTypeDeclarations || hasExplicitTypeSignals;
  const hasTopLevelDocs = docEligibility.hasTopLevelDocs || hasTypeDrivenClosureDocs;
  return {
    docEligibility,
    filePath: sourceFile.fileName,
    hasDecorators,
    hasEnumDeclarations,
    hasTypeDrivenClosureDocs,
    needsSemanticPreflight,
    hasTopLevelDocs,
    hasTypeDeclarations,
    shouldAnalyze: hasDecorators || hasEnumDeclarations || hasTopLevelDocs || hasTypeDeclarations
  };
}
function classifyClosureIrFile(sourceFile) {
  return classifyClosureIrSourceFile(sourceFile);
}
function containsExplicitTypeSignal(node) {
  if (import_typescript15.default.isAsExpression(node) || import_typescript15.default.isEnumDeclaration(node) || import_typescript15.default.isInterfaceDeclaration(node) || import_typescript15.default.isSatisfiesExpression(node) || import_typescript15.default.isTypeAliasDeclaration(node) || import_typescript15.default.isTypeAssertionExpression(node) || import_typescript15.default.isTypeParameterDeclaration(node)) {
    return true;
  }
  if ("type" in node && node.type) {
    return true;
  }
  return import_typescript15.default.forEachChild(node, containsExplicitTypeSignal) ?? false;
}
var import_typescript15;
var init_scan = __esm(() => {
  init_decorators();
  init_doc_eligibility();
  import_typescript15 = __toESM(require("typescript"));
});

// src/stages/native/closure-ir/metadata.ts
function scanClosureIrFiles({
  fileNames,
  program
}) {
  return scanClosureIrSourceFiles({ fileNames, program });
}
function collectClosureIrFiles({
  compilerOptions,
  fileNames,
  program,
  scan = scanClosureIrFiles({ fileNames, program })
}) {
  const files = scan.files.map(({ features, sourceFile }) => ({
    features,
    sourceFile
  }));
  const needsChecker = files.some(({ features }) => features.hasEnumDeclarations || features.hasTopLevelDocs || features.hasTypeDeclarations);
  const hasDecorators = files.some(({ features }) => features.hasDecorators);
  if (!needsChecker && !hasDecorators) {
    return {
      diagnostics: [],
      files: files.map(({ sourceFile }) => ({
        decoratedOutputText: undefined,
        enumDeclarations: [],
        filePath: sourceFile.fileName,
        topLevelDocs: [],
        typeDeclarations: []
      })),
      scan
    };
  }
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = scan.hasEnumDeclarations ? collectUnsafeEnumSymbols(scan.files.filter(({ features }) => features.hasEnumDeclarations).map(({ sourceFile }) => sourceFile), checker) : new Set;
  const diagnostics = [];
  const collectedFiles = [];
  for (const { features, sourceFile } of files) {
    if (!features.shouldAnalyze) {
      collectedFiles.push({
        decoratedOutputText: undefined,
        enumDeclarations: [],
        filePath: sourceFile.fileName,
        topLevelDocs: [],
        typeDeclarations: []
      });
      continue;
    }
    const result = collectClosureIrFileMetadata({
      compilerOptions,
      checker,
      features,
      sourceFile,
      unsafeEnumSymbols
    });
    diagnostics.push(...result.diagnostics);
    collectedFiles.push(result.file);
  }
  return { diagnostics, files: collectedFiles, scan };
}
var init_metadata = __esm(() => {
  init_collect();
  init_enums();
  init_scan();
});

// src/stages/native/closure-ir/diagnostics.ts
function shouldIgnorePreflightDiagnostic(diagnostic) {
  const message = import_typescript16.default.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  if (message.includes("implicitly has an 'any' type") && diagnostic.file && !fileHasExplicitTypeSignals(diagnostic.file)) {
    return true;
  }
  switch (diagnostic.code) {
    case 7016:
      return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
    case 7017:
      return message.includes("type 'typeof globalThis'");
    case 2307:
      return message.includes("corresponding type declarations") && isBareModuleResolutionDiagnostic(diagnostic);
    case 5097:
      return isLocalTsExtensionImportDiagnostic(diagnostic);
    default:
      return false;
  }
}
function isBareModuleResolutionDiagnostic(diagnostic) {
  const specifier = getDiagnosticModuleSpecifier(diagnostic);
  if (!specifier) {
    return false;
  }
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#");
}
function isLocalTsExtensionImportDiagnostic(diagnostic) {
  const specifier = getDiagnosticModuleSpecifier(diagnostic);
  return !!specifier && specifier.startsWith(".") && specifier.endsWith(".ts");
}
function getDiagnosticModuleSpecifier(diagnostic) {
  if (!diagnostic.file || diagnostic.start == null || diagnostic.length == null || diagnostic.length <= 0) {
    return null;
  }
  const moduleText = diagnostic.file.text.slice(diagnostic.start, diagnostic.start + diagnostic.length);
  if (moduleText.length < 2 || !(moduleText.startsWith('"') && moduleText.endsWith('"') || moduleText.startsWith("'") && moduleText.endsWith("'"))) {
    return null;
  }
  return moduleText.slice(1, -1);
}
function fileHasExplicitTypeSignals(sourceFile) {
  const cached = explicitTypeSignalCache.get(sourceFile);
  if (cached != null) {
    return cached;
  }
  const hasSignal = sourceFile.text.includes("/**") || sourceFile.text.includes("@ts-check") || sourceFile.statements.some(containsExplicitTypeSignal2);
  explicitTypeSignalCache.set(sourceFile, hasSignal);
  return hasSignal;
}
function containsExplicitTypeSignal2(node) {
  if (import_typescript16.default.isEnumDeclaration(node) || import_typescript16.default.isInterfaceDeclaration(node) || import_typescript16.default.isTypeAliasDeclaration(node) || import_typescript16.default.isAsExpression(node) || import_typescript16.default.isSatisfiesExpression(node) || import_typescript16.default.isTypeAssertionExpression(node) || import_typescript16.default.isTypeParameterDeclaration(node)) {
    return true;
  }
  if ("type" in node && node.type) {
    return true;
  }
  return import_typescript16.default.forEachChild(node, containsExplicitTypeSignal2) ?? false;
}
var import_typescript16, explicitTypeSignalCache;
var init_diagnostics = __esm(() => {
  import_typescript16 = __toESM(require("typescript"));
  explicitTypeSignalCache = new WeakMap;
});

// src/stages/native/closure-ir/preflight.ts
function collectNativePreflightDiagnostics({
  authoredFiles,
  additionalSyntacticDiagnostics,
  preflight,
  program,
  scan
}) {
  if (preflight === "off") {
    return [];
  }
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...additionalSyntacticDiagnostics ?? collectSyntacticDiagnostics(program),
    ...collectSemanticDiagnostics({
      authoredFiles: authoredFiles ?? loadViteAuthoredFiles(),
      program,
      scan
    })
  ].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic));
  if (preflight === "errors-only") {
    return diagnostics.filter((diagnostic) => diagnostic.category === import_typescript17.default.DiagnosticCategory.Error);
  }
  return diagnostics;
}
function collectSyntacticDiagnostics(program) {
  const diagnostics = [];
  for (const sourceFile of program.getSourceFiles()) {
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile));
  }
  return diagnostics;
}
function collectSemanticDiagnostics({
  authoredFiles,
  program,
  scan
}) {
  const diagnostics = [];
  const semanticFiles = scan.files.filter(({ features, sourceFile }) => {
    if (!features.needsSemanticPreflight) {
      return false;
    }
    if (!authoredFiles) {
      return true;
    }
    return authoredFiles.has(sourceFile.fileName);
  });
  logInternalDetail("native-emit:preflight:files", `${semanticFiles.length}/${scan.scannedFileCount}`);
  for (const { sourceFile } of semanticFiles) {
    diagnostics.push(...program.getSemanticDiagnostics(sourceFile));
  }
  return diagnostics;
}
function loadViteAuthoredFiles(filePath = process.env.GCC_VITE_AUTHORED_FILES_FILE) {
  if (!filePath) {
    return null;
  }
  const cached = authoredFileSetCache.get(filePath);
  if (cached) {
    return cached;
  }
  try {
    const raw = import_fs10.default.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const authoredFiles = new Set(parsed.filter((value) => typeof value === "string"));
    authoredFileSetCache.set(filePath, authoredFiles);
    return authoredFiles;
  } catch {
    return null;
  }
}
var import_fs10, import_typescript17, authoredFileSetCache;
var init_preflight = __esm(() => {
  init_timing();
  init_diagnostics();
  import_fs10 = __toESM(require("fs"));
  import_typescript17 = __toESM(require("typescript"));
  authoredFileSetCache = new Map;
});

// src/stages/native/closure-ir.ts
async function createNativeTypeAnalysisContext({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: import_typescript18.default.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript18.default.ScriptTarget.ESNext
  });
  return {
    compilerOptions,
    fileNames,
    program: import_typescript18.default.createProgram(fileNames, compilerOptions)
  };
}
function scanNativeTypeAnalysisContext({
  context
}) {
  const { fileNames, program } = context;
  return scanClosureIrFiles({ fileNames, program });
}
function collectNativeClosureIrFromContext({
  context,
  scan
}) {
  const { compilerOptions, fileNames, program } = context;
  const closureIrScan = scan ?? scanNativeTypeAnalysisContext({ context });
  logInternalDetail("native-emit:analysis-scan:files", `${closureIrScan.analyzedFileCount}/${closureIrScan.scannedFileCount}`);
  return collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
    scan: closureIrScan
  });
}
var import_typescript18;
var init_closure_ir = __esm(() => {
  init_timing();
  init_compiler_options();
  init_metadata();
  init_preflight();
  import_typescript18 = __toESM(require("typescript"));
});

// src/stages/native/emit.ts
async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsxRuntimeSourceFiles,
  tsConfigPath,
  workspaceDir
}) {
  const usesPersistentCache = options.cache.mode === "persistent";
  const paths = createNativeEmitPaths({
    cacheDir,
    tsxRuntimeSourceFiles,
    workspaceDir
  });
  const combinedFileNames = uniqueSortedStrings([
    ...fileNames,
    ...tsxRuntimeSourceFiles
  ]);
  const dependencyModules = collectDependencyModules(packageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir: paths.outDir,
    sourceFiles: combinedFileNames,
    workspaceDir
  });
  const cachedResult = await restoreCachedNativeEmitResult({
    dependencyModules,
    dependencyRuntimeFiles,
    metadataPath,
    outDir: paths.outDir,
    usesPersistentCache
  });
  if (usesPersistentCache) {
    logInternalDetail("cache:native-emit", cachedResult ? "hit" : "miss");
  }
  if (cachedResult) {
    return cachedResult;
  }
  const missingInputDiagnostics = await getMissingInputDiagnostics({
    externFileNames: options.externs,
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      supportFiles: []
    };
  }
  await resetNativeEmitOutDir(paths.outDir);
  const analysis = await collectNativeAnalysis({
    fileNames: combinedFileNames,
    options,
    tsConfigPath,
    workspaceDir
  });
  const analysisDiagnostics = [
    ...analysis.preflightDiagnostics,
    ...analysis.diagnostics
  ];
  if (analysisDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysisDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      supportFiles: []
    };
  }
  await import_fs11.default.promises.writeFile(paths.metadataPathForNative, JSON.stringify(analysis.files, null, 2), "utf-8");
  const result = await withInternalTiming("native-emit:transpile", () => Promise.resolve(runNativeTranspile({
    chunkMode: options.chunks.mode,
    combinedFileNames,
    explicitExternPaths: options.externs,
    externsPath: paths.externsPath,
    lazyImports,
    metadataPath: paths.metadataPathForNative,
    outDir: paths.outDir,
    packageAliases,
    packageJsonFiles,
    workspaceDir
  })));
  const finalSupportFiles = uniqueSortedStrings([
    ...paths.runtimeSupportFiles,
    ...result.supportFiles
  ]);
  logInternalDetail("native-emit:extern-preserved-properties", `${result.explicitExternPropertyCount}`);
  if (usesPersistentCache) {
    await persistNativeEmitMetadata({
      dependencyModules,
      dependencyRuntimeFiles,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath,
      metadataPathForNative: paths.metadataPathForNative,
      supportFiles: finalSupportFiles
    });
  }
  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir: paths.outDir,
    supportFiles: finalSupportFiles
  };
}
async function collectNativeAnalysis({
  fileNames,
  options,
  tsConfigPath,
  workspaceDir
}) {
  if (!canUseJsAnalysisFastPath(fileNames)) {
    const analysisContext2 = await withInternalTiming("native-emit:analysis-context", () => createNativeTypeAnalysisContext({
      fileNames,
      tsConfigPath,
      workspaceDir
    }));
    const analysisScan2 = await withInternalTiming("native-emit:analysis-scan", () => Promise.resolve(scanNativeTypeAnalysisContext({ context: analysisContext2 })));
    const preflightDiagnostics2 = await withInternalTiming("native-emit:preflight", () => Promise.resolve(collectNativePreflightDiagnostics({
      preflight: options.diagnostics.preflight,
      program: analysisContext2.program,
      scan: analysisScan2
    })));
    const analysis = await withInternalTiming("native-emit:closure-ir", () => Promise.resolve(collectNativeClosureIrFromContext({
      context: analysisContext2,
      scan: analysisScan2
    })));
    return {
      diagnostics: analysis.diagnostics,
      files: analysis.files,
      preflightDiagnostics: preflightDiagnostics2
    };
  }
  const authoredFiles = loadViteAuthoredFiles();
  const quickScanFiles = await withInternalTiming("native-emit:quick-scan", () => scanNativeFilesQuickly(fileNames));
  const checkerRequiredFileNames = quickScanFiles.filter(({ features, fileName }) => features.shouldAnalyze || features.needsSemanticPreflight && (authoredFiles ? authoredFiles.has(fileName) : true)).map(({ fileName }) => fileName);
  const checkerRequiredFileSet = new Set(checkerRequiredFileNames);
  const trivialJsFiles = quickScanFiles.filter(({ fileName }) => !checkerRequiredFileSet.has(fileName));
  logInternalDetail("native-emit:checker-required-files", `${checkerRequiredFileNames.length}`);
  logInternalDetail("native-emit:trivial-js-files", `${trivialJsFiles.length}`);
  const analysisContext = checkerRequiredFileNames.length > 0 || options.diagnostics.preflight !== "off" ? await withInternalTiming("native-emit:analysis-context", () => createNativeTypeAnalysisContext({
    fileNames: checkerRequiredFileNames,
    tsConfigPath,
    workspaceDir
  })) : null;
  const analysisScan = analysisContext ? await withInternalTiming("native-emit:analysis-scan", () => Promise.resolve(scanNativeTypeAnalysisContext({ context: analysisContext }))) : null;
  if (!analysisScan) {
    logInternalDetail("native-emit:analysis-scan:files", `0/${quickScanFiles.length}`);
  }
  const preflightDiagnostics = analysisContext && analysisScan ? await withInternalTiming("native-emit:preflight", () => Promise.resolve(collectNativePreflightDiagnostics({
    additionalSyntacticDiagnostics: quickScanFiles.flatMap(({ parseDiagnostics }) => parseDiagnostics),
    authoredFiles,
    preflight: options.diagnostics.preflight,
    program: analysisContext.program,
    scan: analysisScan
  }))) : [];
  const checkerAnalysis = analysisContext && analysisScan && checkerRequiredFileNames.length > 0 ? await withInternalTiming("native-emit:closure-ir", () => Promise.resolve(collectNativeClosureIrFromContext({
    context: analysisContext,
    scan: analysisScan
  }))) : { diagnostics: [], files: [] };
  const checkerFileMap = new Map(checkerAnalysis.files.map((file) => [file.filePath, file]));
  return {
    diagnostics: checkerAnalysis.diagnostics,
    files: fileNames.map((fileName) => checkerFileMap.get(fileName) ?? createTrivialClosureIrFile(fileName)),
    preflightDiagnostics
  };
}
function createNativeEmitPaths({
  cacheDir,
  tsxRuntimeSourceFiles,
  workspaceDir
}) {
  const outDir = import_path18.default.join(cacheDir, "out");
  return {
    externsPath: import_path18.default.join(cacheDir, "native-generated.externs.js"),
    metadataPathForNative: import_path18.default.join(cacheDir, "closure-ir.json"),
    outDir,
    runtimeSupportFiles: tsxRuntimeSourceFiles.map((fileName) => toEmittedPath(fileName, outDir, workspaceDir))
  };
}
async function restoreCachedNativeEmitResult({
  dependencyModules,
  dependencyRuntimeFiles,
  metadataPath,
  outDir,
  usesPersistentCache
}) {
  if (!usesPersistentCache) {
    return null;
  }
  const cachedMetadata = await readMetadata(metadataPath);
  if (!cachedMetadata || !await filesExist([
    cachedMetadata.externsPath,
    cachedMetadata.metadataPath,
    ...cachedMetadata.emittedFiles,
    ...cachedMetadata.supportFiles
  ])) {
    return null;
  }
  return {
    dependencyModules: cachedMetadata.dependencyModules.length > 0 ? cachedMetadata.dependencyModules : dependencyModules,
    dependencyRuntimeFiles: cachedMetadata.dependencyRuntimeFiles.length > 0 ? cachedMetadata.dependencyRuntimeFiles : dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: cachedMetadata.emittedFiles,
    externsPath: cachedMetadata.externsPath,
    outDir,
    supportFiles: cachedMetadata.supportFiles
  };
}
async function resetNativeEmitOutDir(outDir) {
  await import_fs11.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs11.default.promises.mkdir(outDir, { recursive: true });
}
function runNativeTranspile({
  chunkMode,
  combinedFileNames,
  explicitExternPaths,
  externsPath,
  lazyImports,
  metadataPath,
  outDir,
  packageAliases,
  packageJsonFiles,
  workspaceDir
}) {
  return transpileSources({
    chunkMode,
    explicitExternPaths,
    metadataPath,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases,
    packageJsonFiles,
    runtimeModuleSourceMapFile: process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE || undefined,
    workspaceDir
  });
}
async function persistNativeEmitMetadata({
  dependencyModules,
  dependencyRuntimeFiles,
  emittedFiles,
  externsPath,
  metadataPath,
  metadataPathForNative,
  supportFiles
}) {
  await import_fs11.default.promises.writeFile(metadataPath, JSON.stringify({
    dependencyModules,
    dependencyRuntimeFiles,
    emittedFiles,
    externsPath,
    metadataPath: metadataPathForNative,
    supportFiles,
    version: NATIVE_EMIT_METADATA_VERSION
  }, null, 2), "utf-8");
}
async function getMissingInputDiagnostics({
  externFileNames,
  fileNames,
  preflight,
  tsConfigPath
}) {
  if (preflight === "off") {
    return [];
  }
  const requiredStates = collectFileStates([
    tsConfigPath,
    ...fileNames,
    ...externFileNames
  ]);
  const missingFiles = requiredStates.filter((state) => !state.exists).map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(`Missing required build input(s): ${missingFiles.join(", ")}`)
    ];
  }
  return [];
}
function createSimpleDiagnostic(messageText) {
  return {
    category: import_typescript19.default.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
async function readMetadata(metadataPath) {
  try {
    const raw = await import_fs11.default.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      dependencyModules: parsed.dependencyModules ?? [],
      dependencyRuntimeFiles: parsed.dependencyRuntimeFiles ?? [],
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
  return import_path18.default.join(outDir, import_path18.default.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
}
function collectDependencyModules(packageAliases) {
  return uniqueSortedStrings(packageAliases.filter((alias) => isDependencyFile(alias.targetPath)).map((alias) => alias.subpath === "." ? alias.packageName : `${alias.packageName}/${alias.subpath.replace(/^\.\//, "")}`));
}
function collectDependencyRuntimeFiles({
  outDir,
  sourceFiles,
  workspaceDir
}) {
  return uniqueSortedStrings(sourceFiles.filter((filePath) => isDependencyFile(filePath)).map((filePath) => toEmittedPath(filePath, outDir, workspaceDir)));
}
function isDependencyFile(filePath) {
  return import_path18.default.resolve(filePath).includes(`${import_path18.default.sep}node_modules${import_path18.default.sep}`);
}
async function scanNativeFilesQuickly(fileNames) {
  const files = await Promise.all(fileNames.map(async (fileName) => {
    const text = await import_fs11.default.promises.readFile(fileName, "utf8");
    const sourceFile = import_typescript19.default.createSourceFile(fileName, text, import_typescript19.default.ScriptTarget.Latest, true, resolveScriptKind(fileName));
    return {
      features: classifyClosureIrSourceFile(sourceFile),
      fileName,
      parseDiagnostics: getSourceFileParseDiagnostics(sourceFile)
    };
  }));
  return files;
}
function canUseJsAnalysisFastPath(fileNames) {
  if (!process.env.GCC_VITE_AUTHORED_FILES_FILE) {
    return false;
  }
  return fileNames.every((fileName) => /\.(?:[cm]?jsx?)$/u.test(fileName));
}
function createTrivialClosureIrFile(filePath) {
  return {
    decoratedOutputText: undefined,
    enumDeclarations: [],
    filePath,
    topLevelDocs: [],
    typeDeclarations: []
  };
}
function resolveScriptKind(fileName) {
  if (fileName.endsWith(".jsx")) {
    return import_typescript19.default.ScriptKind.JSX;
  }
  return import_typescript19.default.ScriptKind.JS;
}
function getSourceFileParseDiagnostics(sourceFile) {
  return [
    ...sourceFile.parseDiagnostics ?? []
  ];
}
var import_fs11, import_path18, import_typescript19, NATIVE_EMIT_METADATA_VERSION = 8;
var init_emit = __esm(() => {
  init_files();
  init_file_state();
  init_timing();
  init_load();
  init_closure_ir();
  init_scan();
  init_preflight();
  import_fs11 = __toESM(require("fs"));
  import_path18 = __toESM(require("path"));
  import_typescript19 = __toESM(require("typescript"));
});

// src/stages/closure/compiler.ts
function applyInternalClosureDebugOptions(closureOptions) {
  const mutableOptions = closureOptions;
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (mutableOptions.compilationLevel === "ADVANCED" && process.env.GCC_USE_TYPES_FOR_OPTIMIZATION !== "false") {
    mutableOptions.useTypesForOptimization = true;
  } else if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
    mutableOptions.useTypesForOptimization = false;
  }
}
function configureClosureCompilerOptions(closureOptions) {
  applyInternalClosureDebugOptions(closureOptions);
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
function resolveClosureCompilerVersionTag() {
  return resolveClosureCompilerJarPath() ?? import_utils.getNativeImagePath() ?? "native";
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
var closureCompilerPackage, import_utils;
var init_compiler = __esm(() => {
  closureCompilerPackage = __toESM(require("google-closure-compiler"));
  import_utils = require("google-closure-compiler/lib/utils.js");
});

// src/stages/closure/cache.ts
function getCompileJobOutputFiles(job) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) => import_path19.default.join(job.chunkOutputPathPrefix, `${chunkSpec.split(":", 1)[0]}.js`));
  }
  throw new Error("Closure compile job is missing output configuration.");
}
function getCompileJobArtifactFiles(job) {
  const artifacts = getCompileJobOutputFiles(job);
  if (job.propertyRenamingReportPath) {
    artifacts.push(job.propertyRenamingReportPath);
  }
  return artifacts;
}
async function tryRestoreCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  artifactFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job, compilerVersion);
  const metadata = await readJsonIfExists(import_path19.default.join(jobCacheDir, "meta.json"));
  if (!metadata || metadata.version !== CLOSURE_JOB_CACHE_VERSION || metadata.artifactFiles.length !== artifactFiles.length) {
    return false;
  }
  const cachedFiles = metadata.artifactFiles.map((fileName) => import_path19.default.join(jobCacheDir, fileName));
  const filesReady = await Promise.all(cachedFiles.map((filePath) => import_promises2.default.stat(filePath).then(() => true).catch(() => false)));
  if (filesReady.some((ready) => !ready)) {
    return false;
  }
  await Promise.all(artifactFiles.map(async (artifactFile, index) => {
    await ensureDirectory(import_path19.default.dirname(artifactFile));
    await import_promises2.default.copyFile(cachedFiles[index], artifactFile);
  }));
  return true;
}
async function persistCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  artifactFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job, compilerVersion);
  await import_promises2.default.rm(jobCacheDir, { force: true, recursive: true });
  await ensureDirectory(jobCacheDir);
  const artifactNames = artifactFiles.map((artifactFile) => import_path19.default.basename(artifactFile));
  await Promise.all(artifactFiles.map((artifactFile, index) => import_promises2.default.copyFile(artifactFile, import_path19.default.join(jobCacheDir, artifactNames[index]))));
  await writeJson(import_path19.default.join(jobCacheDir, "meta.json"), {
    artifactFiles: artifactNames,
    version: CLOSURE_JOB_CACHE_VERSION
  });
}
async function getClosureJobCacheDir(cacheDir, job, compilerVersion) {
  const outputFiles = getCompileJobOutputFiles(job);
  const jsHash = await hashFilesInOrder(job.js);
  const externHash = await hashFilesInOrder(job.externs);
  const cacheKey = hashJson({
    compilerVersion,
    externHash,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      hasPropertyRenamingReport: Boolean(job.propertyRenamingReportPath),
      jsOutputKinds: outputFiles.map((outputFile) => import_path19.default.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel
    },
    jsHash,
    version: CLOSURE_JOB_CACHE_VERSION
  });
  return import_path19.default.join(cacheDir, cacheKey);
}
var import_promises2, import_path19, CLOSURE_JOB_CACHE_VERSION = 2;
var init_cache2 = __esm(() => {
  init_hash();
  init_store();
  init_files();
  import_promises2 = __toESM(require("fs/promises"));
  import_path19 = __toESM(require("path"));
});

// src/stages/closure/concurrency.ts
function determineClosureConcurrency(jobCount) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }
  const available = import_os2.default.availableParallelism?.() ?? import_os2.default.cpus().length ?? 1;
  return Math.min(jobCount, Math.max(1, available - 1));
}
async function runWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;; ) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current]);
    }
  }));
  return results;
}
var import_os2;
var init_concurrency = __esm(() => {
  import_os2 = __toESM(require("os"));
});

// src/stages/closure/postprocess/es5.ts
function createEs5HelperRewriteContext({
  bundlerRuntimeBaseInputPath,
  chunkMode,
  languageOut
}) {
  const shouldRewriteHelpers = chunkMode === "bundler-runtime" && /ECMASCRIPT(?:3|5)/.test(languageOut) && !!bundlerRuntimeBaseInputPath;
  const helperKeys = new Set;
  const rewrittenInputs = new Map;
  return {
    requiresInputRead() {
      return shouldRewriteHelpers;
    },
    renderHelperBag(runtimeAlias) {
      return helperKeys.size === 0 ? "" : renderBundlerRuntimeEs5HelperBag(helperKeys, runtimeAlias);
    },
    rewrite(inputPath, contents) {
      if (!shouldRewriteHelpers || inputPath === bundlerRuntimeBaseInputPath) {
        return contents;
      }
      const cached = rewrittenInputs.get(inputPath);
      if (cached !== undefined) {
        return cached;
      }
      const rewritten = rewriteBundlerRuntimeEs5Helpers(contents);
      for (const helperKey of rewritten.helperKeys) {
        helperKeys.add(helperKey);
      }
      rewrittenInputs.set(inputPath, rewritten.code);
      return rewritten.code;
    }
  };
}
function applyEs5HelperRewrite(inputPath, contents, rewriteContext) {
  return rewriteContext.rewrite(inputPath, contents);
}
function renderBundlerRuntimeEs5HelperBag(helperKeys, runtimeAlias) {
  const lines = [
    runtimeAlias ? `var _=${runtimeAlias}._||(${runtimeAlias}._=[]);` : "var G=globalThis.__g,_=G._||(G._=[]);"
  ];
  if (helperKeys.has("class-private-field-set")) {
    lines.push('_[0]=function(a,b,c,d,e){if(d==="m")throw new TypeError("Private method is not writable");if(d==="a"&&!e)throw new TypeError("Private accessor was defined without a setter");if(typeof b==="function"?a!==b||!e:!b.has(a))throw new TypeError("Cannot write private member to an object whose class did not declare it");return d==="a"?e.call(a,c):e?e.value=c:b.set(a,c),c;};');
  }
  if (helperKeys.has("class-private-field-get")) {
    lines.push('_[1]=function(a,b,c,d){if(c==="a"&&!d)throw new TypeError("Private accessor was defined without a getter");if(typeof b==="function"?a!==b||!d:!b.has(a))throw new TypeError("Cannot read private member from an object whose class did not declare it");return c==="m"?d:c==="a"?d.call(a):d?d.value:b.get(a);};');
  }
  if (helperKeys.has("set-function-name")) {
    lines.push('_[2]=function(a,b,c){typeof b==="symbol"&&(b=b.description?"["+b.description+"]":"");return Object.defineProperty(a,"name",{configurable:!0,value:c?c+" "+b:b});};');
  }
  if (helperKeys.has("run-initializers")) {
    lines.push("_[3]=function(a,b,c){for(var d=arguments.length>2,e=0;e<b.length;e++)c=d?b[e].call(a,c):b[e].call(a);return d?c:void 0;};");
  }
  if (helperKeys.has("es-decorate")) {
    lines.push('_[4]=function(a,b,c,d,e,f){function g(h){if(h!==void 0&&typeof h!=="function")throw new TypeError("Function expected");return h;}var i=d.kind,j=i==="getter"?"get":i==="setter"?"set":"value";a=!b&&a?d["static"]?a:a.prototype:null;b=b||(a?Object.getOwnPropertyDescriptor(a,d.name):{});for(var k,l=!1,m=c.length-1;m>=0;m--){k={};for(var n in d)k[n]=n==="access"?{}:d[n];for(n in d.access)k.access[n]=d.access[n];k.addInitializer=function(h){if(l)throw new TypeError("Cannot add initializers after decoration has completed");f.push(g(h||null));};var o=(0,c[m])(i==="accessor"?{get:b.get,set:b.set}:b[j],k);if(i==="accessor"){if(o!==void 0){if(o===null||typeof o!=="object")throw new TypeError("Object expected");if(k=g(o.get))b.get=k;if(k=g(o.set))b.set=k;(k=g(o.init))&&e.unshift(k);}}else if(k=g(o))i==="field"?e.unshift(k):b[j]=k;}a&&Object.defineProperty(a,d.name,b);l=!0;};');
  }
  if (helperKeys.has("closure-template-object")) {
    lines.push("_[5]=function(a){a.raw=a;Object.freeze&&Object.freeze(a);return a;};");
  }
  if (helperKeys.has("closure-inherits")) {
    lines.push('_[6]=function(a,b){a.prototype=Object.create(b.prototype);a.prototype.constructor=a;if(Object.setPrototypeOf)Object.setPrototypeOf(a,b);else for(var c in b)if(c!="prototype")if(Object.defineProperties){var d=Object.getOwnPropertyDescriptor(b,c);d&&Object.defineProperty(a,c,d);}else a[c]=b[c];a.lc=b.prototype;};');
  }
  return lines.join("");
}
var init_es5 = __esm(() => {
  init_load();
});

// src/stages/closure/postprocess/io.ts
async function readCachedText(filePath, cache) {
  let pending = cache.get(filePath);
  if (!pending) {
    pending = import_promises3.default.readFile(filePath, "utf-8");
    cache.set(filePath, pending);
  }
  return pending;
}
async function readPropertyRenamingReport(reportPath, cache) {
  return readCachedText(reportPath, cache);
}
var import_promises3;
var init_io = __esm(() => {
  import_promises3 = __toESM(require("fs/promises"));
});

// src/stages/closure/postprocess/runtime.ts
function injectBundlerRuntimeEs5HelperBag(code, helperBag) {
  if (!helperBag) {
    return code;
  }
  const runtimeAlias = findBundlerRuntimeFinalizeAlias(code);
  const markers = runtimeAlias ? [`${runtimeAlias}.u(`, `${runtimeAlias}.n(`] : ["G.u(", "globalThis.__g.u(", 'globalThis["__g"].u('];
  for (const marker of markers) {
    const markerIndex = code.lastIndexOf(marker);
    if (markerIndex !== -1) {
      return `${code.slice(0, markerIndex)}${helperBag}${code.slice(markerIndex)}`;
    }
  }
  return `${code}${helperBag}`;
}
function canonicalizeBundlerRuntimeRootAccess(code) {
  if (!code.includes("var G=globalThis.__g,_=G._")) {
    return code;
  }
  let next = code.replaceAll("globalThis.__g.", "G.").replaceAll('globalThis["__g"].', "G.");
  for (const runtimeAlias of findBundlerRuntimeRootAliases(next)) {
    if (runtimeAlias === "G") {
      continue;
    }
    next = next.replaceAll(`${runtimeAlias}.`, "G.");
    next = stripStandaloneRuntimeAlias(next, runtimeAlias);
  }
  return next;
}
function findBundlerRuntimeFinalizeAlias(code) {
  const aliases = findBundlerRuntimeRootAliases(code);
  for (const alias of aliases) {
    if (code.includes(`${alias}.u(`) || code.includes(`${alias}.n(`)) {
      return alias;
    }
  }
  return;
}
function wrapBundlerRuntimeOutputFile(code) {
  const trimmed = code.trimEnd();
  return `!function(){
${trimmed}
}();
`;
}
function findBundlerRuntimeRootAliases(code) {
  const aliases = new Set;
  for (const pattern of [
    /\bvar\s+([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=[,;])/g,
    /,([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=[,;])/g,
    /(?:^|[;(])([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=;)/gm
  ]) {
    for (const match of code.matchAll(pattern)) {
      aliases.add(match[1]);
    }
  }
  return [...aliases];
}
function stripStandaloneRuntimeAlias(code, runtimeAlias) {
  const escapedAlias = escapeRegex(runtimeAlias);
  return code.replace(new RegExp(`\\bvar ${escapedAlias}=globalThis(?:\\.__g|\\["__g"\\]);(?=G\\.)`, "g"), "").replace(new RegExp(`(^|[;\\n])${escapedAlias}=globalThis(?:\\.__g|\\["__g"\\]);(?=G\\.)`, "gm"), "$1").replace(/\n{3,}/g, `

`);
}
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// src/stages/closure/postprocess.ts
async function runClosurePostprocess({
  chunkMode,
  languageOut,
  prepared
}) {
  const propertyRenamingReports = new Map;
  const es5Rewrite = createEs5HelperRewriteContext({
    bundlerRuntimeBaseInputPath: prepared.bundlerRuntimeBaseInputPath,
    chunkMode,
    languageOut
  });
  const inputContents = new Map;
  const inputPaths = [
    ...new Set(prepared.postprocessActions.map((action) => action.inputPath))
  ];
  await Promise.all(inputPaths.map(async (inputPath) => {
    if (!es5Rewrite.requiresInputRead()) {
      return;
    }
    const originalContents = await readCachedText(inputPath, inputContents);
    applyEs5HelperRewrite(inputPath, originalContents, es5Rewrite);
  }));
  await Promise.all(prepared.postprocessActions.map(async (action) => {
    await ensureParentDirectory(action.outputPath);
    const wrapBundlerRuntimeOutput = chunkMode === "bundler-runtime";
    const reportText = action.propertyRenamingReportPath ? await readPropertyRenamingReport(action.propertyRenamingReportPath, propertyRenamingReports) : "";
    const hasNoRewriteActions = action.kind === "copy" && !reportText && !es5Rewrite.requiresInputRead() && !wrapBundlerRuntimeOutput;
    if (hasNoRewriteActions) {
      await import_promises4.default.copyFile(action.inputPath, action.outputPath);
      return;
    }
    const originalContents = await readCachedText(action.inputPath, inputContents);
    let contents = applyEs5HelperRewrite(action.inputPath, originalContents, es5Rewrite);
    if (action.kind === "rewrite-gcc-exports" || action.kind === "rewrite-gcc-exports-and-decorator-metadata") {
      contents = rewriteGccExports(contents);
    }
    if (reportText && (action.kind === "rewrite-decorator-metadata" || action.kind === "rewrite-gcc-exports-and-decorator-metadata")) {
      contents = rewriteDecoratorMetadata(contents, reportText);
    }
    if (action.inputPath === prepared.bundlerRuntimeBaseInputPath) {
      const runtimeAlias = findBundlerRuntimeFinalizeAlias(contents);
      contents = injectBundlerRuntimeEs5HelperBag(contents, es5Rewrite.renderHelperBag(runtimeAlias));
    }
    contents = canonicalizeBundlerRuntimeRootAccess(contents);
    if (wrapBundlerRuntimeOutput) {
      contents = wrapBundlerRuntimeOutputFile(contents);
    }
    await import_promises4.default.writeFile(action.outputPath, contents);
  }));
}
var import_promises4;
var init_postprocess = __esm(() => {
  init_files();
  init_load();
  init_es5();
  init_io();
  import_promises4 = __toESM(require("fs/promises"));
});

// src/stages/closure/run-closure.ts
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
  projectCacheDir,
  supportFiles,
  packageRoot: packageRoot2
}) {
  const { cacheOutputDir } = await prepareClosureStageDirectories({
    finalCacheDir,
    outDir
  });
  const prepared = prepareClosureJobs({
    chunkLoader: options.chunks.loader,
    chunkMode: options.chunks.mode,
    chunkPlan,
    compilationLevel: options.compilationLevel,
    diagnosticsVerbose: options.diagnostics.verbose,
    emittedOutDir,
    explicitExternPaths,
    explicitJsInputs: options.js,
    finalCacheDir,
    generatedExternPaths,
    languageOut: options.languageOut,
    manifestFile: options.chunks.manifestFile,
    nativeExternPath,
    outDir,
    packageRoot: packageRoot2,
    publicPath: options.chunks.publicPath,
    supportFiles
  });
  await writeGeneratedAssets(prepared.generatedAssets);
  const exitCodes = await withInternalTiming("closure:compile", () => compilePreparedClosureJobs({
    chunkMode: options.chunks.mode,
    prepared,
    projectCacheDir,
    usesPersistentCache: options.cache.mode !== "off"
  }));
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }
  await withInternalTiming("closure:postprocess", () => runClosurePostprocess({
    chunkMode: options.chunks.mode,
    languageOut: options.languageOut,
    prepared
  }));
  await withInternalTiming("closure:publish", () => publishPreparedClosureOutputs(prepared.publishedOutputs, cacheOutputDir));
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) => import_path20.default.join(cacheOutputDir, import_path20.default.relative(outDir, outputFile)));
  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs
  };
}
async function prepareClosureStageDirectories({
  finalCacheDir,
  outDir
}) {
  await import_promises5.default.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);
  const rawDir = import_path20.default.join(finalCacheDir, "raw");
  const cacheOutputDir = import_path20.default.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await import_promises5.default.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);
  return { cacheOutputDir, rawDir };
}
async function writeGeneratedAssets(assets) {
  await Promise.all(assets.map(async (asset) => {
    await ensureParentDirectory(asset.path);
    await import_promises5.default.writeFile(asset.path, asset.text, "utf-8");
  }));
}
async function compilePreparedClosureJobs({
  chunkMode,
  prepared,
  projectCacheDir,
  usesPersistentCache
}) {
  const cacheDir = usesPersistentCache ? import_path20.default.join(projectCacheDir, "closure-jobs") : null;
  const concurrency = chunkMode === "bundler-runtime" ? determineClosureConcurrency(prepared.compileJobs.length) : 1;
  const results = await runWithConcurrency(prepared.compileJobs, concurrency, async (job) => runPreparedClosureJob({
    cacheDir,
    job
  }));
  if (cacheDir) {
    const hits = results.filter((result) => result.cacheHit).length;
    logInternalDetail("cache:closure-jobs", `hits=${hits} misses=${results.length - hits} jobs=${results.length}`);
  }
  return results.map((result) => result.exitCode);
}
async function publishPreparedClosureOutputs(outputFiles, cacheOutputDir) {
  await publishFilesToDirectory(outputFiles, cacheOutputDir, "copy");
}
async function runPreparedClosureJob({
  cacheDir,
  job
}) {
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir ? await tryRestoreCachedClosureJob({
    artifactFiles,
    cacheDir,
    compilerVersion,
    job
  }) : false;
  if (cached) {
    return {
      cacheHit: true,
      exitCode: 0
    };
  }
  const closureOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: [...new Set(job.externs)],
    js: [...new Set(job.js)],
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel
  };
  if (job.chunk) {
    closureOptions.chunk = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions.chunkOutputPathPrefix = job.chunkOutputPathPrefix;
  }
  if (job.dependencyMode) {
    closureOptions.dependencyMode = job.dependencyMode;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions.entryPoint = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions.jsOutputFile = job.jsOutputFile;
  }
  if (job.propertyRenamingReportPath) {
    closureOptions.propertyRenamingReport = job.propertyRenamingReportPath;
  }
  configureClosureCompilerOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return {
      cacheHit: false,
      exitCode
    };
  }
  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job
    });
  }
  return {
    cacheHit: false,
    exitCode: 0
  };
}
var import_promises5, import_path20;
var init_run_closure = __esm(() => {
  init_files();
  init_timing();
  init_load();
  init_compiler();
  init_cache2();
  init_concurrency();
  init_postprocess();
  import_promises5 = __toESM(require("fs/promises"));
  import_path20 = __toESM(require("path"));
});

// src/pipeline/build-helpers.ts
async function publishOutputs(outputFiles, outDir) {
  if (await publishedOutputsMatch2(outputFiles, outDir)) {
    return;
  }
  await publishFilesToDirectory(outputFiles, outDir, "copy");
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
function toPublishedOutputPaths(publishedOutputs, outDir) {
  return publishedOutputs.map(({ name }) => import_path21.default.join(outDir, name));
}
function createBuildDiagnostic(error) {
  return {
    category: 1,
    code: 0,
    messageText: error instanceof Error ? error.message : typeof error === "string" ? error : "Build failed."
  };
}
async function removeProjectCacheDir(projectCacheDir) {
  await import_fs12.default.promises.rm(projectCacheDir, { force: true, recursive: true });
}
var import_fs12, import_path21;
var init_build_helpers = __esm(() => {
  init_files();
  init_file_state();
  import_fs12 = __toESM(require("fs"));
  import_path21 = __toESM(require("path"));
});

// src/pipeline/build-pipeline.ts
var exports_build_pipeline = {};
__export(exports_build_pipeline, {
  cleanCache: () => cleanCache,
  build: () => build
});
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  const usesPersistentCache = context.options.cache.mode === "persistent";
  let resolved = null;
  try {
    resolved = await withInternalTiming("resolve-build", () => resolveBuild(context));
    const resolvedBuild = resolved;
    const finalFastSnapshotPath = import_path22.default.join(context.projectCacheDir, "final-fast.json");
    const finalFastSnapshot = usesPersistentCache ? await readJsonIfExists(finalFastSnapshotPath) : null;
    const finalFastCacheHit = usesPersistentCache && !!finalFastSnapshot && finalFastSnapshot.finalKey === resolvedBuild.finalKey && finalFastSnapshot.optionsSignature === context.optionsSignature && finalFastSnapshot.packageSignature === context.packageSignature && await publishedOutputsMatchSnapshot(finalFastSnapshot.publishedOutputs, context.options.outDir);
    if (usesPersistentCache) {
      logInternalDetail("cache:final-fast", finalFastCacheHit ? "hit" : "miss");
    }
    if (finalFastSnapshot && finalFastCacheHit) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(finalFastSnapshot.publishedOutputs, context.options.outDir)
      };
    }
    const finalMetadataPath = import_path22.default.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = usesPersistentCache ? await readJsonIfExists(finalMetadataPath) : null;
    const finalMetadataHit = usesPersistentCache && !!finalMetadata && await filesExist(finalMetadata.outputFiles);
    if (usesPersistentCache) {
      logInternalDetail("cache:final-metadata", finalMetadataHit ? "hit" : "miss");
    }
    if (finalMetadata && finalMetadataHit) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(finalMetadata.outputFiles.map((outputFile) => ({
          name: import_path22.default.basename(outputFile)
        })), context.options.outDir)
      };
    }
    if (context.options.chunks.mode !== "off" && resolvedBuild.entryFiles.some((entry) => entry.exportNames.length > 0 || entry.hasDefaultExport)) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic("Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.")
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode === "off" && resolvedBuild.lazyImports.length > 0) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic('Dynamic import() requires chunks.mode = "bundler-runtime".')
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode === "off") {
      writeEntryShims({
        entries: resolvedBuild.entryFiles.map((entry) => ({
          exportNames: entry.exportNames,
          hasDefaultExport: entry.hasDefaultExport,
          importPath: toImportPath(import_path22.default.relative(import_path22.default.dirname(import_path22.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
          shimPath: import_path22.default.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
        }))
      });
    }
    const nativeEmitMetadataPath = import_path22.default.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: context.options.chunks.mode !== "off" ? resolvedBuild.sourceFiles : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      lazyImports: resolvedBuild.lazyImports,
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      packageAliases: resolvedBuild.packageAliases,
      packageJsonFiles: resolvedBuild.packageJsonFiles,
      tsxRuntimeSourceFiles: resolvedBuild.tsxRuntimeSourceFiles,
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
    const closureResult = await runClosureStage({
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      explicitExternPaths: context.options.externs,
      finalCacheDir: resolvedBuild.finalCacheDir,
      generatedExternPaths: [],
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: context.options.outDir,
      projectCacheDir: context.projectCacheDir,
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
    if (usesPersistentCache) {
      await writeJson(finalMetadataPath, {
        outputFiles: closureResult.cacheOutputFiles
      });
      await writeJson(finalFastSnapshotPath, {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats2(closureResult.outputFiles)
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
  const projectRoot = import_path22.default.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = import_path22.default.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  await removeProjectCacheDir(projectCacheDir);
}
var import_path22;
var init_build_pipeline = __esm(() => {
  init_store();
  init_file_state();
  init_resolve_build();
  init_emit();
  init_run_closure();
  init_load();
  init_build_helpers();
  init_timing();
  import_path22 = __toESM(require("path"));
});

// src/index.ts
var exports_src = {};
__export(exports_src, {
  generateExterns: () => generateExterns,
  cleanCache: () => cleanCache2,
  build: () => build2,
  DEFAULT_BUILD_OPTIONS: () => DEFAULT_BUILD_OPTIONS
});
module.exports = __toCommonJS(exports_src);

// src/api/externs.ts
init_files();
var import_fs6 = __toESM(require("fs"));
var import_path8 = __toESM(require("path"));

// src/api/externs/context.ts
var import_typescript3 = __toESM(require("typescript"));

// src/api/externs/contracts/registry.ts
var import_path5 = __toESM(require("path"));
var import_typescript2 = __toESM(require("typescript"));

// src/api/externs/shared.ts
var import_path4 = __toESM(require("path"));
var import_typescript = __toESM(require("typescript"));
var DECLARATION_EXTENSIONS = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".ts",
  ".tsx",
  ".mts",
  ".cts"
];
var BUILTIN_CONTAINER_NAMES = new Set([
  "Array",
  "AsyncIterable",
  "AsyncIterator",
  "Iterable",
  "Iterator",
  "Map",
  "Promise",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Set",
  "String",
  "WeakMap",
  "WeakSet"
]);
var BUILTIN_RUNTIME_MEMBER_NAMES = new Set([
  "addEventListener",
  "apply",
  "attachShadow",
  "attributes",
  "length",
  "message",
  "name",
  "removeAttribute",
  "removeEventListener",
  "setAttribute"
]);
function createEmptyContractRegistry() {
  return {
    classContracts: new Map,
    interfaceContracts: new Map,
    scannedFiles: new Set,
    typeAliasContracts: new Map
  };
}
function collectStructuralContractMembers(symbol, registry, seen = new Set) {
  if (seen.has(symbol)) {
    return new Set;
  }
  seen.add(symbol);
  const interfaceContract = registry.interfaceContracts.get(symbol);
  if (interfaceContract) {
    const members = new Set(interfaceContract.members);
    for (const extendedSymbol of interfaceContract.extends) {
      for (const member of collectStructuralContractMembers(extendedSymbol, registry, seen)) {
        members.add(member);
      }
    }
    return members;
  }
  const typeAliasContract = registry.typeAliasContracts.get(symbol);
  if (typeAliasContract) {
    return new Set(typeAliasContract.members);
  }
  return new Set;
}
function resolveTypeSymbol(type, checker) {
  const symbol = type.getSymbol();
  if (!symbol && type.isUnionOrIntersection()) {
    for (const child of type.types) {
      const childSymbol = resolveTypeSymbol(child, checker);
      if (childSymbol) {
        return childSymbol;
      }
    }
    return null;
  }
  return resolveAliasedSymbol(symbol, checker);
}
function resolveValueSymbol(node, checker) {
  return resolveAliasedSymbol(checker.getSymbolAtLocation(node), checker);
}
function resolveAliasedSymbol(symbol, checker) {
  if (!symbol) {
    return null;
  }
  return symbol.flags & import_typescript.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function renderStructuralExternLine(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `Object.prototype.${name};` : `Object.prototype[${JSON.stringify(name)}];`;
}
function addMapSetValue(map, key, value) {
  const current = map.get(key);
  if (current) {
    current.add(value);
    return;
  }
  map.set(key, new Set([value]));
}
function isProjectAppSourceFile(filePath, projectRoot) {
  const resolvedFilePath = import_path4.default.resolve(filePath);
  return !resolvedFilePath.includes(`${import_path4.default.sep}node_modules${import_path4.default.sep}`) && !resolvedFilePath.endsWith(".d.ts") && resolvedFilePath.startsWith(import_path4.default.resolve(projectRoot) + import_path4.default.sep);
}
function isExportedDeclaration(node) {
  return (import_typescript.default.getCombinedModifierFlags(node) & import_typescript.default.ModifierFlags.Export) !== 0;
}
function hasStaticModifier(node) {
  return (import_typescript.default.getCombinedModifierFlags(node) & import_typescript.default.ModifierFlags.Static) !== 0;
}
function hasNonPublicModifier(node) {
  const modifierFlags = import_typescript.default.getCombinedModifierFlags(node);
  return (modifierFlags & import_typescript.default.ModifierFlags.Private) !== 0 || (modifierFlags & import_typescript.default.ModifierFlags.Protected) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (import_typescript.default.isIdentifier(name) || import_typescript.default.isStringLiteral(name) || import_typescript.default.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}
function getStringLiteralMemberName(expression) {
  if (!expression) {
    return null;
  }
  return import_typescript.default.isStringLiteral(expression) || import_typescript.default.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}
function isExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !name.startsWith("_") && !name.startsWith("$") && !BUILTIN_CONTAINER_NAMES.has(name);
}
function isRuntimeExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !BUILTIN_CONTAINER_NAMES.has(name) && !BUILTIN_RUNTIME_MEMBER_NAMES.has(name);
}
function isThisOrSuperExpression(expression) {
  return expression.kind === import_typescript.default.SyntaxKind.ThisKeyword || expression.kind === import_typescript.default.SyntaxKind.SuperKeyword;
}
function isKnownConstructorExpression(expression, knownConstructors) {
  return import_typescript.default.isIdentifier(expression) && knownConstructors.has(expression.text);
}
function isKnownPrototypeExpression(expression, knownConstructors) {
  return import_typescript.default.isPropertyAccessExpression(expression) && expression.name.text === "prototype" && isKnownConstructorExpression(expression.expression, knownConstructors);
}
function isObjectDefinePropertyCall(expression) {
  return import_typescript.default.isPropertyAccessExpression(expression) && import_typescript.default.isIdentifier(expression.expression) && expression.expression.text === "Object" && expression.name.text === "defineProperty";
}
function isAssignmentOperator(kind) {
  return kind === import_typescript.default.SyntaxKind.EqualsToken || kind === import_typescript.default.SyntaxKind.BarBarEqualsToken || kind === import_typescript.default.SyntaxKind.AmpersandAmpersandEqualsToken || kind === import_typescript.default.SyntaxKind.QuestionQuestionEqualsToken;
}
function getScriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return import_typescript.default.ScriptKind.TSX;
  }
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
    return import_typescript.default.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return import_typescript.default.ScriptKind.JSX;
  }
  return import_typescript.default.ScriptKind.JS;
}
function isScannedDeclarationSymbol(symbol, scannedFiles) {
  return (symbol.declarations ?? []).some((declaration) => scannedFiles.has(import_path4.default.resolve(declaration.getSourceFile().fileName)));
}
function findPackageDir(filePath) {
  let currentDir = import_path4.default.dirname(filePath);
  while (true) {
    const packageJsonPath = import_path4.default.join(currentDir, "package.json");
    if (import_typescript.default.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = import_path4.default.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
function isTypeSourceFile(filePath) {
  return DECLARATION_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}
function isTypescriptLibFile(filePath) {
  return filePath.includes(`${import_path4.default.sep}node_modules${import_path4.default.sep}typescript${import_path4.default.sep}lib${import_path4.default.sep}`);
}
function symbolCacheKey(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration ? `${import_path4.default.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}` : symbol.getName();
}
function uniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function isRecoverableExternConfigError(error) {
  return error instanceof Error && (error.message.includes("TS18003") || error.message.includes("No inputs were found in config file"));
}

// src/api/externs/contracts/registry.ts
function collectContracts({
  checker,
  program,
  scannedFiles
}) {
  const scannedFileSet = new Set(scannedFiles.map((filePath) => import_path5.default.resolve(filePath)));
  const interfaceContracts = new Map;
  const typeAliasContracts = new Map;
  const classContracts = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(import_path5.default.resolve(sourceFile.fileName))) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (import_typescript2.default.isInterfaceDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        interfaceContracts.set(symbol, {
          extends: getReferencedContractSymbols(statement.heritageClauses?.flatMap((clause) => clause.types) ?? [], checker, scannedFileSet),
          members: collectTypeElementMembers(statement.members),
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (import_typescript2.default.isTypeAliasDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const members = collectAliasMembers(statement.type);
        if (members.size === 0) {
          continue;
        }
        typeAliasContracts.set(symbol, {
          members,
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (import_typescript2.default.isClassDeclaration(statement) && statement.name && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set;
        const staticMembers = new Set;
        for (const member of statement.members) {
          if (import_typescript2.default.isConstructorDeclaration(member)) {
            continue;
          }
          if (hasNonPublicModifier(member)) {
            continue;
          }
          const memberName = getPropertyNameText(member.name);
          if (!memberName || !isExternPropertyName(memberName)) {
            continue;
          }
          if (hasStaticModifier(member)) {
            staticMembers.add(memberName);
          } else {
            instanceMembers.add(memberName);
          }
        }
        classContracts.set(symbol, {
          constructorParamContracts: collectConstructorParamContracts(statement, checker, scannedFileSet),
          instanceMembers,
          name: statement.name.text,
          staticMembers,
          symbol,
          usedImplementedContracts: getClassImplementedContracts(statement, checker, scannedFileSet)
        });
      }
    }
  }
  return {
    classContracts,
    interfaceContracts,
    scannedFiles: scannedFileSet,
    typeAliasContracts
  };
}
function collectTypeElementMembers(members) {
  const collected = new Set;
  for (const member of members) {
    if (import_typescript2.default.isPropertySignature(member) || import_typescript2.default.isMethodSignature(member) || import_typescript2.default.isGetAccessorDeclaration(member) || import_typescript2.default.isSetAccessorDeclaration(member)) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}
function collectAliasMembers(typeNode) {
  if (import_typescript2.default.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }
  if (import_typescript2.default.isIntersectionTypeNode(typeNode)) {
    const members = new Set;
    for (const child of typeNode.types) {
      for (const member of collectAliasMembers(child)) {
        members.add(member);
      }
    }
    return members;
  }
  return new Set;
}
function getReferencedContractSymbols(typeNodes, checker, scannedFiles) {
  const symbols = new Set;
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
      symbols.add(symbol);
    }
  }
  return symbols;
}
function getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles) {
  if (import_typescript2.default.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles) ? new Set([symbol]) : new Set;
  }
  if (import_typescript2.default.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }
  if (import_typescript2.default.isIntersectionTypeNode(typeNode) || import_typescript2.default.isUnionTypeNode(typeNode)) {
    const symbols = new Set;
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(child, checker, scannedFiles)) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }
  if (import_typescript2.default.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(typeNode.typeName, checker, scannedFiles);
  }
  return new Set;
}
function getContractSymbolsFromEntityName(entityName, checker, scannedFiles) {
  const symbol = import_typescript2.default.isIdentifier(entityName) ? checker.getSymbolAtLocation(entityName) : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set;
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles) ? new Set([resolved]) : new Set;
}
function collectConstructorParamContracts(statement, checker, scannedFiles) {
  const constructorDeclaration = statement.members.find((member) => import_typescript2.default.isConstructorDeclaration(member));
  if (!constructorDeclaration || !import_typescript2.default.isConstructorDeclaration(constructorDeclaration)) {
    return [];
  }
  return constructorDeclaration.parameters.map((parameter) => parameter.type ? getContractSymbolsFromTypeNode(parameter.type, checker, scannedFiles) : new Set);
}
function getClassImplementedContracts(statement, checker, scannedFiles, seen = new Set) {
  const contracts = new Set;
  const classSymbol = statement.name && checker.getSymbolAtLocation(statement.name);
  const classKey = classSymbol ? symbolCacheKey(classSymbol) : "";
  if (classKey && seen.has(classKey)) {
    return contracts;
  }
  if (classKey) {
    seen.add(classKey);
  }
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token === import_typescript2.default.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
          contracts.add(symbol);
        }
      }
      continue;
    }
    if (clause.token === import_typescript2.default.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) => import_typescript2.default.isClassDeclaration(item));
        if (declaration && import_typescript2.default.isClassDeclaration(declaration)) {
          for (const symbol of getClassImplementedContracts(declaration, checker, scannedFiles, seen)) {
            contracts.add(symbol);
          }
        }
      }
    }
  }
  return contracts;
}

// src/api/externs/context.ts
function createExternAnalysisContext({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  scannedFiles
}) {
  const rootNames = uniqueStrings([...scannedFiles, ...appEntryFiles]);
  const program = import_typescript3.default.createProgram(rootNames, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true
  });
  const checker = program.getTypeChecker();
  const registry = scannedFiles.length === 0 ? createEmptyContractRegistry() : collectContracts({
    checker,
    program,
    scannedFiles
  });
  return {
    appEntryFiles,
    checker,
    compilerOptions,
    program,
    projectRoot,
    registry,
    scannedFiles
  };
}

// src/api/externs/compiler.ts
init_compiler_options();
var import_fs4 = __toESM(require("fs"));
var import_path7 = __toESM(require("path"));
var import_typescript5 = __toESM(require("typescript"));
async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: import_typescript5.default.ModuleKind.ESNext,
    moduleResolution: import_typescript5.default.ModuleResolutionKind.Bundler,
    target: import_typescript5.default.ScriptTarget.ESNext
  };
  const resolvedConfigPath = tsConfigPath ?? import_path7.default.join(projectRoot, "tsconfig.json");
  try {
    await import_fs4.default.promises.access(resolvedConfigPath, import_fs4.default.constants.R_OK);
    try {
      return await loadCompilerOptions(resolvedConfigPath, {
        allowJs: true,
        rootDir: projectRoot
      });
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return fallbackOptions;
}
async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  specifiers,
  tolerateMissing
}) {
  const resolvedEntries = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(await resolveModuleTypeEntry({
        compilerOptions,
        projectRoot,
        specifier
      }));
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueStrings(resolvedEntries);
}
function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir
}) {
  return entryFiles.map((entry) => {
    if (import_path7.default.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = import_path7.default.resolve(srcDir, entry);
    if (import_typescript5.default.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return import_path7.default.resolve(projectRoot, entry);
  });
}
async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies
}) {
  const rootPackageDirs = new Set(entryFiles.map((filePath) => findPackageDir(filePath)).filter((packageDir) => packageDir !== null));
  const queue = [...entryFiles];
  const seen = new Set;
  while (queue.length > 0) {
    const nextFile = queue.shift();
    if (!nextFile) {
      continue;
    }
    const resolvedFile = import_path7.default.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);
    const sourceText = await import_fs4.default.promises.readFile(resolvedFile, "utf8");
    const sourceFile = import_typescript5.default.createSourceFile(resolvedFile, sourceText, import_typescript5.default.ScriptTarget.Latest, true);
    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = import_typescript5.default.resolveModuleName(specifier, resolvedFile, compilerOptions, import_typescript5.default.sys).resolvedModule;
      if (!resolvedModule) {
        continue;
      }
      const normalizedDependency = normalizeResolvedTypeFile(resolvedModule.resolvedFileName);
      if (!normalizedDependency || isTypescriptLibFile(normalizedDependency)) {
        continue;
      }
      if (!includeDependencies) {
        const dependencyPackageDir = findPackageDir(normalizedDependency);
        if (dependencyPackageDir && !rootPackageDirs.has(dependencyPackageDir)) {
          continue;
        }
      }
      queue.push(normalizedDependency);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}
async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  specifier
}) {
  const containingFile = import_path7.default.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = import_typescript5.default.resolveModuleName(specifier, containingFile, compilerOptions, import_typescript5.default.sys).resolvedModule;
  const resolvedFromTypescript = resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }
  const require3 = import_typescript5.default.createModuleResolutionCache(projectRoot, (fileName) => fileName, compilerOptions);
  const fallbackResolution = import_typescript5.default.nodeModuleNameResolver(specifier, containingFile, compilerOptions, import_typescript5.default.sys, require3).resolvedModule;
  const resolvedFromFallback = fallbackResolution && normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }
  throw new Error(`Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`);
}
function normalizeResolvedTypeFile(resolvedFileName) {
  const normalizedPath = import_path7.default.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }
  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (import_typescript5.default.sys.fileExists(candidate)) {
      return import_path7.default.resolve(candidate);
    }
  }
  return null;
}
function withTypeExtension(filePath, nextExtension) {
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return filePath;
  }
  const extension = import_path7.default.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`;
}
function collectReferencedSpecifiers(sourceFile) {
  const specifiers = new Set;
  const add = (value) => {
    if (value) {
      specifiers.add(value);
    }
  };
  const visit = (node) => {
    if (import_typescript5.default.isImportDeclaration(node) || import_typescript5.default.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && import_typescript5.default.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (import_typescript5.default.isImportEqualsDeclaration(node) && import_typescript5.default.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && import_typescript5.default.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text);
    } else if (import_typescript5.default.isImportTypeNode(node) && import_typescript5.default.isLiteralTypeNode(node.argument) && import_typescript5.default.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text);
    }
    import_typescript5.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

// src/api/externs/runtime-analysis.ts
var import_fs5 = __toESM(require("fs"));
var import_typescript6 = __toESM(require("typescript"));
async function analyzeRuntimeUsage(runtimeEntryFiles) {
  const hazards = {
    accessedMembers: new Set,
    definedMembers: new Set,
    protocolMembers: new Set
  };
  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await import_fs5.default.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = import_typescript6.default.createSourceFile(runtimeEntryFile, sourceText, import_typescript6.default.ScriptTarget.Latest, true, getScriptKindForFile(runtimeEntryFile));
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node) => {
      if (import_typescript6.default.isPropertyAccessExpression(node)) {
        if (isRelevantRuntimeTarget(node.expression, knownConstructors) && isRuntimeExternPropertyName(node.name.text)) {
          hazards.accessedMembers.add(node.name.text);
        }
      } else if (import_typescript6.default.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, hazards);
      } else if (import_typescript6.default.isCallExpression(node)) {
        collectProtocolHelperMembers(node, hazards);
        collectRuntimeCallMembers(node, knownConstructors, hazards);
      }
      import_typescript6.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return hazards;
}
function collectProtocolHelperMembers(node, hazards) {
  const signature = getProtocolHelperCallSignature(node);
  if (!signature) {
    return;
  }
  if (signature.kind === "direct-key-read") {
    const memberName = getStringLiteralMemberName(node.arguments[1]);
    if (memberName && isRuntimeExternPropertyName(memberName)) {
      hazards.protocolMembers.add(memberName);
    }
    return;
  }
  const memberList = node.arguments[1];
  if (!memberList || !import_typescript6.default.isArrayLiteralExpression(memberList)) {
    return;
  }
  for (const element of memberList.elements) {
    if (!import_typescript6.default.isStringLiteral(element) && !import_typescript6.default.isNoSubstitutionTemplateLiteral(element)) {
      continue;
    }
    if (isRuntimeExternPropertyName(element.text)) {
      hazards.protocolMembers.add(element.text);
    }
  }
}
function getProtocolHelperCallSignature(node) {
  if (node.arguments.length < 2) {
    return null;
  }
  const calleeName = getProtocolHelperCalleeName(node.expression);
  if (!calleeName) {
    return null;
  }
  switch (calleeName) {
    case "prop":
      return { kind: "direct-key-read" };
    case "rest_props":
    case "legacy_rest_props":
      return { kind: "key-exclusion-list" };
    default:
      return null;
  }
}
function getProtocolHelperCalleeName(expression) {
  if (import_typescript6.default.isIdentifier(expression)) {
    return expression.text;
  }
  if (import_typescript6.default.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (import_typescript6.default.isElementAccessExpression(expression)) {
    return getStringLiteralMemberName(expression.argumentExpression);
  }
  if (import_typescript6.default.isParenthesizedExpression(expression)) {
    return getProtocolHelperCalleeName(expression.expression);
  }
  return null;
}
function collectKnownConstructorBindings(sourceFile) {
  const knownConstructors = new Set;
  const visit = (node) => {
    if ((import_typescript6.default.isClassDeclaration(node) || import_typescript6.default.isFunctionDeclaration(node)) && node.name) {
      knownConstructors.add(node.name.text);
    } else if (import_typescript6.default.isVariableDeclaration(node) && import_typescript6.default.isIdentifier(node.name) && node.initializer && (import_typescript6.default.isClassExpression(node.initializer) || import_typescript6.default.isFunctionExpression(node.initializer) || import_typescript6.default.isArrowFunction(node.initializer))) {
      knownConstructors.add(node.name.text);
    }
    import_typescript6.default.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}
function collectRuntimeAssignmentMembers(target, knownConstructors, hazards) {
  if (import_typescript6.default.isPropertyAccessExpression(target)) {
    if (isRelevantRuntimeTarget(target.expression, knownConstructors)) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        hazards.definedMembers.add(target.name.text);
      }
    }
    return;
  }
  if (import_typescript6.default.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (memberName && isRelevantRuntimeTarget(target.expression, knownConstructors) && isRuntimeExternPropertyName(memberName)) {
      hazards.definedMembers.add(memberName);
    }
  }
}
function collectRuntimeCallMembers(node, knownConstructors, hazards) {
  const callee = node.expression;
  if (isPublicFieldHelperCall(callee) && node.arguments.length >= 2) {
    const memberName2 = getStringLiteralMemberName(node.arguments[1]);
    if (memberName2 && isRelevantRuntimeTarget(node.arguments[0], knownConstructors) && isRuntimeExternPropertyName(memberName2)) {
      hazards.definedMembers.add(memberName2);
    }
    return;
  }
  if (!isObjectDefinePropertyCall(callee) || node.arguments.length < 2) {
    return;
  }
  const memberName = getStringLiteralMemberName(node.arguments[1]);
  if (!memberName || !isRuntimeExternPropertyName(memberName)) {
    return;
  }
  const target = node.arguments[0];
  if (isRelevantRuntimeTarget(target, knownConstructors)) {
    hazards.definedMembers.add(memberName);
  }
}
function isPublicFieldHelperCall(expression) {
  if (import_typescript6.default.isIdentifier(expression)) {
    return expression.text.startsWith("__publicField");
  }
  if (import_typescript6.default.isPropertyAccessExpression(expression)) {
    return expression.name.text.startsWith("__publicField");
  }
  if (import_typescript6.default.isParenthesizedExpression(expression)) {
    return isPublicFieldHelperCall(expression.expression);
  }
  return false;
}
function isRelevantRuntimeTarget(expression, knownConstructors) {
  return isThisOrSuperExpression(expression) || isKnownPrototypeExpression(expression, knownConstructors) || isKnownConstructorExpression(expression, knownConstructors);
}

// src/api/externs/contracts/usage.ts
var import_typescript7 = __toESM(require("typescript"));
function analyzeAppUsage(analysis) {
  const { checker, program, projectRoot, registry } = analysis;
  const usage = {
    nominalInstanceMembers: new Map,
    nominalStaticMembers: new Map,
    structuralContracts: new Set,
    structuralMembers: new Set
  };
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => isProjectAppSourceFile(sourceFile.fileName, projectRoot));
  for (const sourceFile of sourceFiles) {
    const importBindings = collectImportedClassBindings(sourceFile, registry);
    const localBindings = new Map;
    const visit = (node) => {
      if (import_typescript7.default.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child) => {
          if (import_typescript7.default.isNewExpression(child)) {
            analyzeNewExpression(child, checker, registry, usage, importBindings, localBindings);
          } else if (import_typescript7.default.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (import_typescript7.default.isElementAccessExpression(child) && import_typescript7.default.isStringLiteral(child.argumentExpression)) {
            analyzeElementAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (import_typescript7.default.isVariableDeclaration(child)) {
            registerVariableBinding(child, checker, registry, importBindings, localBindings);
          }
          import_typescript7.default.forEachChild(child, classVisit);
        };
        import_typescript7.default.forEachChild(node, classVisit);
        return;
      }
      if (import_typescript7.default.isVariableDeclaration(node)) {
        registerVariableBinding(node, checker, registry, importBindings, localBindings);
      } else if (import_typescript7.default.isNewExpression(node)) {
        analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings);
      } else if (import_typescript7.default.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      } else if (import_typescript7.default.isElementAccessExpression(node) && import_typescript7.default.isStringLiteral(node.argumentExpression)) {
        analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      }
      import_typescript7.default.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return usage;
}
function collectBoundaryAwareExternLines(analysis) {
  const usage = analyzeAppUsage(analysis);
  const emittedLines = new Set;
  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, analysis.registry)) {
      emittedLines.add(renderStructuralExternLine2(member));
    }
  }
  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine2(member));
  }
  return emittedLines;
}
function collectBoundaryAwareUsageMemberNames(analysis) {
  const usage = analyzeAppUsage(analysis);
  const members = new Set;
  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, analysis.registry)) {
      members.add(member);
    }
  }
  for (const member of usage.structuralMembers) {
    members.add(member);
  }
  for (const names of usage.nominalInstanceMembers.values()) {
    for (const member of names) {
      members.add(member);
    }
  }
  for (const names of usage.nominalStaticMembers.values()) {
    for (const member of names) {
      members.add(member);
    }
  }
  return members;
}
function analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings) {
  const calleeSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, new Map) ?? resolveValueSymbol(node.expression, checker) ?? resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!calleeSymbol) {
    return;
  }
  const classContract = registry.classContracts.get(calleeSymbol);
  if (!classContract) {
    return;
  }
  for (const [
    index,
    contractSymbols
  ] of classContract.constructorParamContracts.entries()) {
    const argument = node.arguments?.[index];
    if (!argument || !isStructuralBoundaryArgument(argument)) {
      continue;
    }
    for (const symbol of contractSymbols) {
      usage.structuralContracts.add(symbol);
    }
  }
}
function analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const propertyName = node.name.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  if (import_typescript7.default.isIdentifier(node.expression) && importBindings.has(node.expression.text)) {
    const targetSymbol = importBindings.get(node.expression.text);
    if (targetSymbol) {
      const classContract = registry.classContracts.get(targetSymbol);
      if (classContract && classContract.staticMembers.has(propertyName)) {
        addMapSetValue(usage.nominalStaticMembers, targetSymbol, propertyName);
        return;
      }
    }
  }
  const boundInstanceSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundInstanceSymbol && registry.classContracts.has(boundInstanceSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundInstanceSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const argumentExpression = node.argumentExpression;
  if (!import_typescript7.default.isStringLiteral(argumentExpression)) {
    return;
  }
  const propertyName = argumentExpression.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  const boundSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundSymbol && registry.classContracts.has(boundSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function collectImportedClassBindings(sourceFile, registry) {
  const bindings = new Map;
  for (const statement of sourceFile.statements) {
    if (!import_typescript7.default.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      const symbol = findClassContractByName(clause.name.text, registry);
      if (symbol) {
        bindings.set(clause.name.text, symbol);
      }
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings || !import_typescript7.default.isNamedImports(namedBindings)) {
      continue;
    }
    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const symbol = findClassContractByName(importedName, registry);
      if (symbol) {
        bindings.set(specifier.name.text, symbol);
      }
    }
  }
  return bindings;
}
function collectClassFieldBindings(declaration, importBindings) {
  const bindings = new Map;
  for (const member of declaration.members) {
    if (!import_typescript7.default.isPropertyDeclaration(member) || !member.initializer || !import_typescript7.default.isIdentifier(member.name) || !import_typescript7.default.isNewExpression(member.initializer) || !import_typescript7.default.isIdentifier(member.initializer.expression)) {
      continue;
    }
    const classSymbol = importBindings.get(member.initializer.expression.text);
    if (classSymbol) {
      bindings.set(member.name.text, classSymbol);
    }
  }
  return bindings;
}
function registerVariableBinding(declaration, checker, registry, importBindings, localBindings) {
  if (!import_typescript7.default.isIdentifier(declaration.name) || !declaration.initializer) {
    return;
  }
  const initializer = declaration.initializer;
  const resolvedTypeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(initializer), checker);
  const classSymbol = (import_typescript7.default.isNewExpression(initializer) && import_typescript7.default.isIdentifier(initializer.expression) ? importBindings.get(initializer.expression.text) : undefined) ?? (resolvedTypeSymbol ? findClassContractByName(resolvedTypeSymbol.getName(), registry) : undefined);
  if (!classSymbol) {
    return;
  }
  localBindings.set(declaration.name.text, classSymbol);
}
function resolveBoundClassSymbol(expression, importBindings, localBindings, fieldBindings) {
  if (import_typescript7.default.isIdentifier(expression)) {
    return localBindings.get(expression.text) ?? importBindings.get(expression.text) ?? null;
  }
  if (import_typescript7.default.isPropertyAccessExpression(expression) && expression.expression.kind === import_typescript7.default.SyntaxKind.ThisKeyword) {
    return fieldBindings.get(expression.name.text) ?? null;
  }
  return null;
}
function findClassContractByName(name, registry) {
  for (const [symbol, contract] of registry.classContracts) {
    if (contract.name === name) {
      return symbol;
    }
  }
  return null;
}
function isStructuralBoundaryArgument(expression) {
  return !(import_typescript7.default.isArrayLiteralExpression(expression) || import_typescript7.default.isObjectLiteralExpression(expression) || import_typescript7.default.isStringLiteralLike(expression) || import_typescript7.default.isNumericLiteral(expression) || expression.kind === import_typescript7.default.SyntaxKind.TrueKeyword || expression.kind === import_typescript7.default.SyntaxKind.FalseKeyword || expression.kind === import_typescript7.default.SyntaxKind.NullKeyword);
}
function renderStructuralExternLine2(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `Object.prototype.${name};` : `Object.prototype[${JSON.stringify(name)}];`;
}
// src/api/externs/contracts.ts
function collectCandidateExternLines(registry) {
  const properties = new Set;
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(contract.symbol, registry)) {
      properties.add(member);
    }
  }
  for (const contract of registry.typeAliasContracts.values()) {
    for (const member of contract.members) {
      properties.add(member);
    }
  }
  for (const contract of registry.classContracts.values()) {
    for (const member of contract.instanceMembers) {
      properties.add(member);
    }
  }
  return new Set([...properties].sort((left, right) => left.localeCompare(right)).map((property) => renderStructuralExternLine(property)));
}
function collectBoundaryAwareExternLines2(analysis) {
  return collectBoundaryAwareExternLines(analysis);
}
function collectBoundaryAwareUsageMemberNames2(analysis) {
  return collectBoundaryAwareUsageMemberNames(analysis);
}

// src/api/externs/render.ts
function renderCandidateExterns({
  analysis,
  modules
}) {
  return renderExternText({
    emittedLines: collectCandidateExternLines(analysis.registry),
    mode: "candidates",
    modules,
    scannedFiles: analysis.scannedFiles
  });
}
function renderBoundaryAwareExterns({
  analysis,
  modules
}) {
  return renderExternText({
    emittedLines: collectBoundaryAwareExternLines2(analysis),
    mode: "boundary-aware",
    modules,
    scannedFiles: analysis.scannedFiles
  });
}
async function renderRuntimeAwareExterns({
  analysis,
  modules,
  runtimeEntryFiles
}) {
  const appUsageMembers = analysis.appEntryFiles.length > 0 ? collectBoundaryAwareUsageMemberNames2(analysis) : new Set;
  const runtimeUsage = await analyzeRuntimeUsage(runtimeEntryFiles);
  const emittedLines = new Set;
  for (const member of runtimeUsage.protocolMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  for (const member of runtimeUsage.definedMembers) {
    if (runtimeUsage.accessedMembers.has(member) || appUsageMembers.has(member)) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles: analysis.scannedFiles
  });
}
function renderExternText({
  emittedLines,
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles
}) {
  const scannedSummary = mode === "runtime-aware" ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.` : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;
  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    ""
  ].join(`
`);
}

// src/api/externs.ts
async function generateExterns(options) {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }
  const mode = options.mode ?? "boundary-aware";
  const projectRoot = import_path8.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path8.default.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath = options.tsConfigPath && import_path8.default.resolve(projectRoot, options.tsConfigPath);
  const compilerOptions = await loadExternCompilerOptions({
    projectRoot,
    tsConfigPath
  });
  const includeDependencies = options.includeDependencies ?? true;
  const resolvedAppEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: options.appEntryFiles ?? [],
    projectRoot,
    srcDir
  });
  const resolvedRuntimeEntryFiles = resolveAnalysisEntryFiles({
    entryFiles: options.runtimeEntryFiles ?? [],
    projectRoot,
    srcDir
  });
  if (mode === "boundary-aware" && (options.appEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in boundary-aware mode requires appEntryFiles.");
  }
  if (mode === "runtime-aware" && (options.runtimeEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in runtime-aware mode requires runtimeEntryFiles.");
  }
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot,
    specifiers: options.modules,
    tolerateMissing: mode === "runtime-aware"
  });
  const scannedFiles = typeEntryFiles.length === 0 ? [] : await collectReachableTypeFiles({
    compilerOptions,
    entryFiles: typeEntryFiles,
    includeDependencies
  });
  const analysis = createExternAnalysisContext({
    appEntryFiles: resolvedAppEntryFiles,
    compilerOptions,
    projectRoot,
    scannedFiles
  });
  const text = mode === "candidates" ? renderCandidateExterns({
    analysis,
    modules: options.modules
  }) : mode === "boundary-aware" ? renderBoundaryAwareExterns({
    analysis,
    modules: options.modules
  }) : await renderRuntimeAwareExterns({
    analysis,
    modules: options.modules,
    runtimeEntryFiles: resolvedRuntimeEntryFiles
  });
  const outputFile = options.outputFile && import_path8.default.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await import_fs6.default.promises.mkdir(import_path8.default.dirname(outputFile), { recursive: true });
    await writeFileIfChanged(outputFile, text);
  }
  return {
    mode,
    modules: [...options.modules],
    outputFile,
    scannedFiles,
    text
  };
}

// src/cli/parse-options.ts
init_types();
var import_minimist = __toESM(require("minimist"));

// src/cli/parse-externs-options.ts
var import_minimist2 = __toESM(require("minimist"));

// src/api/build.ts
async function loadBuildPipeline() {
  return Promise.resolve().then(() => (init_build_pipeline(), exports_build_pipeline));
}
async function cleanCache2(options) {
  const pipeline = await loadBuildPipeline();
  return pipeline.cleanCache(options);
}
var build2 = async (options) => {
  const pipeline = await loadBuildPipeline();
  return pipeline.build(options);
};

// src/index.ts
init_types();
