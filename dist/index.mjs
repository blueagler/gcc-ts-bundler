const __gcc_current_module_url = import.meta.url;
var __defProp = Object.defineProperty;
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
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
function getBundleFilePath() {
  return fileURLToPath(__gcc_current_module_url);
}
function createBundleRequire() {
  bundleRequire ??= createRequire(__gcc_current_module_url);
  return bundleRequire;
}
function getPackageRootFromBundle() {
  if (packageRoot) {
    return packageRoot;
  }
  let currentDir = path.dirname(getBundleFilePath());
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package.json from bundled module path ${getBundleFilePath()}`);
    }
    currentDir = parentDir;
  }
}
var bundleRequire = null, packageRoot = null;
var init_bundle_location = () => {};

// src/native/index.ts
import fs2 from "fs";
import path2 from "path";
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
  const localFallbackPath = path2.join(getPackageRootFromBundle(), "native", "index.node");
  if (fs2.existsSync(localFallbackPath)) {
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
var require2, SUPPORTED_TARGETS, native_default;
var init_native = __esm(() => {
  init_bundle_location();
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
import crypto from "crypto";
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
  return crypto.createHash("sha256").update(content).digest("hex");
}
function hashJson(value) {
  return hashContent(JSON.stringify(normalizeValue(value)));
}
var init_hash = () => {};

// src/stages/native/compiler-options.ts
import fs3 from "fs";
import path5 from "path";
import ts4 from "typescript";
async function loadCompilerOptions(configPath, extraOptions = {}) {
  const configStat = await fs3.promises.stat(configPath);
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
  const configDir = path5.dirname(configPath);
  const configFile = ts4.readConfigFile(configPath, ts4.sys.readFile);
  if (configFile.error) {
    throw new Error(ts4.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = ts4.parseJsonConfigFileContent(configFile.config, ts4.sys, configDir, {
    ...extraOptions,
    baseUrl: extraOptions.baseUrl ?? configFile.config.compilerOptions?.baseUrl ?? configDir,
    ignoreDeprecations: extraOptions.ignoreDeprecations ?? configFile.config.compilerOptions?.ignoreDeprecations ?? "6.0",
    paths: {
      ...configFile.config.compilerOptions?.paths ?? {},
      ...extraOptions.paths ?? {}
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(ts4.formatDiagnosticsWithColorAndContext(parsedConfig.errors, ts4.createCompilerHost({})));
  }
  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
}
var compilerOptionsCache;
var init_compiler_options = __esm(() => {
  init_hash();
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

// src/internal/files.ts
import fs7 from "fs/promises";
import path8 from "path";
function uniqueSortedStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
async function ensureDirectory(dirPath) {
  await fs7.mkdir(dirPath, { recursive: true });
}
async function ensureParentDirectory(filePath) {
  await ensureDirectory(path8.dirname(filePath));
}
async function hashFileInput(filePath) {
  const stat = await fs7.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = fs7.readFile(filePath, "utf-8").then((contents) => hashContent(contents));
  fileInputHashCache.set(cacheKey, pending);
  return pending;
}
async function hashFilesInOrder(filePaths) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}
async function copyOrLinkFiles(sourceFiles, outDir) {
  await fs7.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = path8.join(outDir, path8.basename(sourceFile));
    try {
      await fs7.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await fs7.copyFile(sourceFile, destinationFile);
    }
  }));
}
var fileInputHashCache;
var init_files = __esm(() => {
  init_hash();
  fileInputHashCache = new Map;
});

// src/cache/store.ts
import fs8 from "fs";
import os from "os";
import path9 from "path";
function getProjectCacheDir(rootDir, projectRoot) {
  return path9.join(rootDir, hashContent(projectRoot));
}
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return path9.join(os.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return path9.join(process.env.LOCALAPPDATA ?? path9.join(os.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return path9.join(process.env.XDG_CACHE_HOME ?? path9.join(os.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await fs8.promises.mkdtemp(path9.join(os.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = path9.join(rootDir2, "workspace");
    await fs8.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await fs8.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = path9.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = getProjectCacheDir(rootDir, projectRoot);
  const workspaceDir = path9.join(projectCacheDir, "workspace");
  await fs8.promises.mkdir(workspaceDir, { recursive: true });
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
    const raw = await fs8.promises.readFile(filePath, "utf-8");
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
  await fs8.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
var init_store = __esm(() => {
  init_files();
  init_hash();
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
import path10 from "path";
function resolveOutputNames(entryPaths, outputNames) {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }
    return outputNames;
  }
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => path10.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
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
    sourcePath: path10.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  };
}
function toShimFiles(entryFiles, shimDir) {
  return entryFiles.map((entry) => path10.join(shimDir, `${entry.chunkName}.ts`));
}
var init_entries = () => {};

// src/pipeline/resolve-build/signatures.ts
import fs9 from "fs";
import path11 from "path";
async function hashTsConfig(configPath) {
  return hashContent(await fs9.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await fs9.promises.readFile(filePath, "utf-8"))
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
      const packageJsonStat = await fs9.promises.stat(path11.join(packageRoot2, "package.json"));
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
    entries: options.entries.map((entry) => path11.relative(options.srcDir, entry)),
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
    const stat = await fs9.promises.stat(path11.join(packageRoot2, "dist", "index.mjs"));
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
    const stat = await fs9.promises.stat(path11.join(packageRoot2, "native", "index.node"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
var packageSignaturePromises;
var init_signatures = __esm(() => {
  init_hash();
  init_bundle_location();
  packageSignaturePromises = new Map;
});

// src/pipeline/resolve-build/cache.ts
import path12 from "path";
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = path12.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
var init_cache = __esm(() => {
  init_store();
});

// src/pipeline/resolve-build/jsx-runtime.ts
import path13 from "path";
import ts8 from "typescript";
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
    srcDir: path13.join(workspaceDir, "src"),
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
    case ts8.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts8.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
function toWorkspaceNodeModulesPath(resolvedPath, workspaceDir) {
  const marker = `${path13.sep}node_modules${path13.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path13.join(workspaceDir, relativeNodeModulesPath);
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
var require3;
var init_jsx_runtime = __esm(() => {
  init_load();
  init_compiler_options();
  init_files();
  init_bundle_location();
  require3 = createBundleRequire();
});

// src/pipeline/resolve-build/workspace.ts
import fs10 from "fs";
import path14 from "path";
import ts9 from "typescript";
async function ensureDirectorySymlink(linkPath, targetPath) {
  try {
    const currentTarget = await fs10.promises.readlink(linkPath);
    if (path14.resolve(path14.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs10.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs10.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await fs10.promises.mkdir(path14.dirname(linkPath), { recursive: true });
  await fs10.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = path14.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = path14.join(options.projectRoot, "node_modules");
  const hasNodeModules = await fs10.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = ts9.findConfigFile(projectRoot, ts9.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function removePathIfExists(targetPath) {
  try {
    await fs10.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
var init_workspace = () => {};

// src/pipeline/resolve-build/options.ts
import path15 from "path";
function normalizeBuildOptions(options) {
  const projectRoot = path15.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path15.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = path15.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  const chunkPublicPath = normalizeChunkPublicPath(options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath);
  const chunkManifestFile = path15.basename(options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile);
  return {
    cache: {
      dir: options.cache?.dir ? path15.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
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
    entries: options.entries.map((entry) => path15.isAbsolute(entry) ? entry : path15.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => path15.isAbsolute(filePath) ? filePath : path15.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => path15.isAbsolute(filePath) ? filePath : path15.resolve(projectRoot, filePath)),
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
var UNSUPPORTED_FETCH_LOADER_ERROR = 'gcc-ts-bundler does not support chunks.loader="fetch". Use "script" instead.';
var init_options = __esm(() => {
  init_types();
});

// src/pipeline/resolve-build.ts
import path16 from "path";
async function createBuildContext(options) {
  const packageRoot2 = getPackageRoot();
  const usesPersistentCache = options.cache.mode === "persistent";
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot: packageRoot2,
    packageSignature: usesPersistentCache ? await getPackageSignature(packageRoot2) : "",
    projectCacheDir: getProjectCacheDir(path16.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), options.projectRoot)
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
  const sourceRoot = path16.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = usesPersistentCache ? await hashTsConfig(tsConfigPath) : "";
  const entryRelativePaths = options.entries.map((entry) => path16.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => path16.join(sourceRoot, path16.relative(options.srcDir, entry)));
  const resolveSnapshotPath = path16.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = usesPersistentCache ? await readJsonIfExists(resolveSnapshotPath) : null;
  if (cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
    const shimDir2 = path16.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      lazyImports: cachedSnapshot.lazyImports ?? [],
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: path16.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: path16.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
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
  const resolveMetadataPath = path16.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
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
      sourceRelativePath: path16.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = path16.join(cacheStore.workspaceDir, "entries");
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
  const shimDir = path16.join(cacheStore.workspaceDir, "entries");
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
    finalCacheDir: path16.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: path16.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
    tsxRuntimeSourceFiles: resolveMetadata.tsxRuntimeSourceFiles ?? [],
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  };
}
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
  init_options();
  init_signatures();
});

// src/internal/timing.ts
import { performance } from "node:perf_hooks";
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
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    logInternalTiming(label, performance.now() - startedAt);
  }
}
var SHOW_INTERNAL_TIMINGS;
var init_timing = __esm(() => {
  SHOW_INTERNAL_TIMINGS = process.env.GCC_BUILD_TIMINGS === "1";
});

// src/stages/native/closure-ir/decorators.ts
import ts10 from "typescript";
function containsDecorators(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (ts10.canHaveDecorators(node) && (ts10.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    ts10.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function transpileDecoratedSource({
  compilerOptions,
  fileName,
  sourceText
}) {
  return ts10.transpileModule(sourceText, {
    compilerOptions: {
      ...compilerOptions,
      module: ts10.ModuleKind.ESNext,
      moduleResolution: ts10.ModuleResolutionKind.Bundler,
      sourceMap: false,
      target: ts10.ScriptTarget.ES2018
    },
    fileName,
    reportDiagnostics: true
  });
}
var init_decorators = () => {};

// src/stages/native/closure-ir/metadata/docs.ts
import ts11 from "typescript";
function buildInterfaceDeclarationSnippet(statement, checker) {
  const lines = ["/**"];
  lines.push(" * @record");
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(" */");
  lines.push(`function ${statement.name.text}() {}`);
  for (const member of statement.members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      continue;
    }
    if (ts11.isPropertySignature(member)) {
      const propertyType = member.type ? toClosureType(checker.getTypeFromTypeNode(member.type), checker) : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
      continue;
    }
    if (ts11.isMethodSignature(member)) {
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
function buildFunctionJsDoc(statement, checker, firstParamObjectRecordTypeName) {
  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  for (const [index, parameter] of signature.getParameters().entries()) {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    const parameterName = index === 0 && firstParamObjectRecordTypeName ? "__props" : parameter.getName();
    const closureType = index === 0 && firstParamObjectRecordTypeName ? `!${firstParamObjectRecordTypeName}` : toClosureType(parameterType, checker);
    lines.push(` * @param {${closureType}} ${parameterName}`);
  }
  const returnType = checker.getReturnTypeOfSignature(signature);
  lines.push(` * @return {${toClosureType(returnType, checker)}}`);
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function buildFunctionObjectParamRecord(statement, checker) {
  if (!isComponentLikeName(statement.name?.text)) {
    return null;
  }
  const firstParameter = statement.parameters[0];
  if (!firstParameter || !ts11.isObjectBindingPattern(firstParameter.name) || hasRestElement(firstParameter.name)) {
    return null;
  }
  const parameterType = checker.getTypeAtLocation(firstParameter);
  const properties = checker.getPropertiesOfType(parameterType);
  if (properties.length === 0) {
    return null;
  }
  const typeName = `${statement.name.text}$Param0`;
  const lines = ["/**", " * @record", " */", `function ${typeName}() {}`];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? firstParameter;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    lines.push(`/** @type {${toClosureType(propertyType, checker)}} */`);
    lines.push(`${typeName}.prototype.${renderPropertyName(property.getName())};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`,
    typeName
  };
}
function buildClassJsDoc(statement, checker) {
  const typeParameters = statement.typeParameters ?? [];
  const lines = ["/**"];
  for (const templateName of getTemplateNames(typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureType(checker.getTypeAtLocation(typeNode), checker);
        if (clause.token === ts11.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === ts11.SyntaxKind.ImplementsKeyword) {
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
  return (ts11.getCombinedModifierFlags(node) & ts11.ModifierFlags.Export) !== 0;
}
function getPropertyNameText2(name) {
  if (!name) {
    return null;
  }
  if (ts11.isIdentifier(name) || ts11.isStringLiteral(name) || ts11.isNumericLiteral(name) || ts11.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `[${JSON.stringify(name)}]`;
}
function hasRestElement(pattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}
function isComponentLikeName(name) {
  return !!name && /^[A-Z]/.test(name);
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
  if (type.flags & ts11.TypeFlags.Any)
    return "?";
  if (type.flags & ts11.TypeFlags.Unknown)
    return "?";
  if (type.flags & ts11.TypeFlags.StringLike)
    return "string";
  if (type.flags & ts11.TypeFlags.NumberLike)
    return "number";
  if (type.flags & ts11.TypeFlags.BooleanLike)
    return "boolean";
  if (type.flags & ts11.TypeFlags.Void)
    return "void";
  if (type.flags & ts11.TypeFlags.Undefined)
    return "undefined";
  if (type.flags & ts11.TypeFlags.Null)
    return "null";
  if (type.flags & ts11.TypeFlags.Never)
    return "never";
  if (type.flags & ts11.TypeFlags.TypeParameter)
    return checker.typeToString(type);
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
  if (type.isClassOrInterface() || type.getProperties().length > 0 && !(type.flags & ts11.TypeFlags.Object)) {
    return "!Object";
  }
  return "?";
}
var init_docs = () => {};

// src/stages/native/closure-ir/metadata/enums.ts
import ts12 from "typescript";
function collectUnsafeEnumSymbols(sourceFiles, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & ts12.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node) => {
      if (ts12.isElementAccessExpression(node) && ts12.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (ts12.isCallExpression(node) && ts12.isPropertyAccessExpression(node.expression) && ts12.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && ts12.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (ts12.isIdentifier(node) && !ts12.isPropertyAccessExpression(node.parent) && !ts12.isElementAccessExpression(node.parent) && !ts12.isImportSpecifier(node.parent) && !ts12.isImportClause(node.parent) && !ts12.isExportSpecifier(node.parent) && !ts12.isEnumDeclaration(node.parent) && !ts12.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & ts12.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & ts12.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      ts12.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & ts12.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
  return (ts12.getCombinedModifierFlags(node) & ts12.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (ts12.getCombinedModifierFlags(node) & ts12.ModifierFlags.Const) !== 0;
}
function getPropertyNameText3(name) {
  if (!name) {
    return null;
  }
  if (ts12.isIdentifier(name) || ts12.isStringLiteral(name) || ts12.isNumericLiteral(name) || ts12.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function literalValueFromExpression(expression) {
  if (ts12.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts12.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts12.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts12.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts12.isPrefixUnaryExpression(expression) && expression.operator === ts12.SyntaxKind.MinusToken && ts12.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text);
  }
  return;
}
var init_enums = () => {};

// src/stages/native/closure-ir/metadata/doc-eligibility.ts
import ts13 from "typescript";
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
  if (!((ts13.isFunctionDeclaration(statement) || ts13.isClassDeclaration(statement)) && statement.name)) {
    return false;
  }
  if (eligibility.isTypeScriptLike && hasNamedExport(statement, eligibility.exportedDeclarationNames)) {
    return true;
  }
  if (ts13.isFunctionDeclaration(statement) && canGenerateComponentObjectParamRecord(statement)) {
    return true;
  }
  return eligibility.hasJsDocText && ts13.getJSDocCommentsAndTags(statement).length > 0;
}
function collectExportedTopLevelDeclarationNames(sourceFile) {
  const exportedNames = new Set;
  for (const statement of sourceFile.statements) {
    if ((ts13.isFunctionDeclaration(statement) || ts13.isClassDeclaration(statement)) && statement.name && hasExportModifier3(statement)) {
      exportedNames.add(statement.name.text);
      continue;
    }
    if (ts13.isExportDeclaration(statement) && statement.exportClause) {
      if (ts13.isNamedExports(statement.exportClause) && !statement.moduleSpecifier) {
        for (const element of statement.exportClause.elements) {
          exportedNames.add(element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }
    if (ts13.isExportAssignment(statement) && ts13.isIdentifier(statement.expression)) {
      exportedNames.add(statement.expression.text);
    }
  }
  return exportedNames;
}
function hasNamedExport(statement, exportedNames) {
  return !!statement.name && exportedNames.has(statement.name.text);
}
function hasExportModifier3(node) {
  return (ts13.getCombinedModifierFlags(node) & ts13.ModifierFlags.Export) !== 0;
}
function canGenerateComponentObjectParamRecord(statement) {
  const firstParameter = statement.parameters[0];
  return !!statement.name && /^[A-Z]/.test(statement.name.text) && !!firstParameter && ts13.isObjectBindingPattern(firstParameter.name) && !firstParameter.name.elements.some((element) => element.dotDotDotToken);
}
function isTypeScriptLikeSourceFile(sourceFile) {
  return /\.(?:cts|mts|ts|tsx)$/u.test(sourceFile.fileName);
}
var init_doc_eligibility = () => {};

// src/stages/native/closure-ir/metadata/collect.ts
import ts14 from "typescript";
function collectClosureIrFileMetadata({
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols
}) {
  const diagnostics = [];
  const typeDeclarations = features.hasTypeDeclarations ? collectTypeDeclarationsForSourceFile(sourceFile, checker) : [];
  const topLevelDocs = features.hasTopLevelDocs ? collectTopLevelDocsForSourceFile(sourceFile, checker, features, typeDeclarations) : [];
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
function collectTypeDeclarationsForSourceFile(sourceFile, checker) {
  const typeDeclarations = [];
  for (const statement of sourceFile.statements) {
    if (ts14.isInterfaceDeclaration(statement)) {
      typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker));
      continue;
    }
    if (ts14.isTypeAliasDeclaration(statement)) {
      typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker));
    }
  }
  return typeDeclarations;
}
function collectTopLevelDocsForSourceFile(sourceFile, checker, features, typeDeclarations) {
  const topLevelDocs = [];
  for (const statement of sourceFile.statements) {
    if (!isDocRelevantTopLevelDeclaration(statement, features.docEligibility)) {
      continue;
    }
    if (ts14.isFunctionDeclaration(statement)) {
      const objectParamRecord = buildFunctionObjectParamRecord(statement, checker);
      if (objectParamRecord) {
        typeDeclarations.push({ snippet: objectParamRecord.snippet });
      }
      const jsdoc = buildFunctionJsDoc(statement, checker, objectParamRecord?.typeName);
      if (jsdoc) {
        topLevelDocs.push({
          jsdoc,
          kind: "function",
          name: statement.name.text
        });
      }
      continue;
    }
    if (ts14.isClassDeclaration(statement)) {
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
  return topLevelDocs;
}
function collectEnumDeclarationsForSourceFile(sourceFile, checker, unsafeEnumSymbols) {
  const enumDeclarations = [];
  for (const statement of sourceFile.statements) {
    if (!ts14.isEnumDeclaration(statement)) {
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
  diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts14.DiagnosticCategory.Error));
  return transpiled.outputText;
}
var init_collect = __esm(() => {
  init_decorators();
  init_docs();
  init_enums();
  init_doc_eligibility();
});

// src/stages/native/closure-ir/metadata/scan.ts
import ts15 from "typescript";
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
    if (ts15.isInterfaceDeclaration(statement) || ts15.isTypeAliasDeclaration(statement)) {
      hasTypeDeclarations = true;
      continue;
    }
    if (ts15.isEnumDeclaration(statement)) {
      hasEnumDeclarations = true;
      continue;
    }
  }
  const docEligibility = classifyClosureIrDocEligibility(sourceFile);
  const hasDecorators = sourceFile.text.includes("@") && containsDecorators(sourceFile);
  const needsSemanticPreflight = docEligibility.hasJsDocText || docEligibility.hasTsCheckText || hasDecorators || hasEnumDeclarations || hasTypeDeclarations || sourceFile.statements.some(containsExplicitTypeSignal);
  return {
    docEligibility,
    filePath: sourceFile.fileName,
    hasDecorators,
    hasEnumDeclarations,
    needsSemanticPreflight,
    hasTopLevelDocs: docEligibility.hasTopLevelDocs,
    hasTypeDeclarations,
    shouldAnalyze: hasDecorators || hasEnumDeclarations || docEligibility.hasTopLevelDocs || hasTypeDeclarations
  };
}
function classifyClosureIrFile(sourceFile) {
  return classifyClosureIrSourceFile(sourceFile);
}
function containsExplicitTypeSignal(node) {
  if (ts15.isAsExpression(node) || ts15.isEnumDeclaration(node) || ts15.isInterfaceDeclaration(node) || ts15.isSatisfiesExpression(node) || ts15.isTypeAliasDeclaration(node) || ts15.isTypeAssertionExpression(node) || ts15.isTypeParameterDeclaration(node)) {
    return true;
  }
  if ("type" in node && node.type) {
    return true;
  }
  return ts15.forEachChild(node, containsExplicitTypeSignal) ?? false;
}
var init_scan = __esm(() => {
  init_decorators();
  init_doc_eligibility();
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
import ts16 from "typescript";
function shouldIgnorePreflightDiagnostic(diagnostic) {
  const message = ts16.flattenDiagnosticMessageText(diagnostic.messageText, `
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
  if (ts16.isEnumDeclaration(node) || ts16.isInterfaceDeclaration(node) || ts16.isTypeAliasDeclaration(node) || ts16.isAsExpression(node) || ts16.isSatisfiesExpression(node) || ts16.isTypeAssertionExpression(node) || ts16.isTypeParameterDeclaration(node)) {
    return true;
  }
  if ("type" in node && node.type) {
    return true;
  }
  return ts16.forEachChild(node, containsExplicitTypeSignal2) ?? false;
}
var explicitTypeSignalCache;
var init_diagnostics = __esm(() => {
  explicitTypeSignalCache = new WeakMap;
});

// src/stages/native/closure-ir/preflight.ts
import fs11 from "fs";
import ts17 from "typescript";
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
    return diagnostics.filter((diagnostic) => diagnostic.category === ts17.DiagnosticCategory.Error);
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
    const raw = fs11.readFileSync(filePath, "utf8");
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
var authoredFileSetCache;
var init_preflight = __esm(() => {
  init_timing();
  init_diagnostics();
  authoredFileSetCache = new Map;
});

// src/stages/native/closure-ir.ts
import ts18 from "typescript";
async function createNativeTypeAnalysisContext({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts18.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts18.ScriptTarget.ESNext
  });
  return {
    compilerOptions,
    fileNames,
    program: ts18.createProgram(fileNames, compilerOptions)
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
var init_closure_ir = __esm(() => {
  init_timing();
  init_compiler_options();
  init_metadata();
  init_preflight();
});

// src/stages/native/emit.ts
import fs12 from "fs";
import path17 from "path";
import ts19 from "typescript";
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
  await fs12.promises.writeFile(paths.metadataPathForNative, JSON.stringify(analysis.files, null, 2), "utf-8");
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
  const outDir = path17.join(cacheDir, "out");
  return {
    externsPath: path17.join(cacheDir, "native-generated.externs.js"),
    metadataPathForNative: path17.join(cacheDir, "closure-ir.json"),
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
  await fs12.promises.rm(outDir, { force: true, recursive: true });
  await fs12.promises.mkdir(outDir, { recursive: true });
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
  await fs12.promises.writeFile(metadataPath, JSON.stringify({
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
    category: ts19.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
async function readMetadata(metadataPath) {
  try {
    const raw = await fs12.promises.readFile(metadataPath, "utf-8");
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
  return path17.join(outDir, path17.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
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
  return path17.resolve(filePath).includes(`${path17.sep}node_modules${path17.sep}`);
}
async function scanNativeFilesQuickly(fileNames) {
  const files = await Promise.all(fileNames.map(async (fileName) => {
    const text = await fs12.promises.readFile(fileName, "utf8");
    const sourceFile = ts19.createSourceFile(fileName, text, ts19.ScriptTarget.Latest, true, resolveScriptKind(fileName));
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
    return ts19.ScriptKind.JSX;
  }
  return ts19.ScriptKind.JS;
}
function getSourceFileParseDiagnostics(sourceFile) {
  return [
    ...sourceFile.parseDiagnostics ?? []
  ];
}
var NATIVE_EMIT_METADATA_VERSION = 8;
var init_emit = __esm(() => {
  init_files();
  init_file_state();
  init_timing();
  init_load();
  init_closure_ir();
  init_scan();
  init_preflight();
});

// src/stages/closure/compiler.ts
import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
function applyInternalClosureDebugOptions(closureOptions) {
  const mutableOptions = closureOptions;
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
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
  return resolveClosureCompilerJarPath() ?? getNativeImagePath() ?? "native";
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
  const nativeImagePath = getNativeImagePath();
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
var init_compiler = () => {};

// src/stages/closure/cache.ts
import fs13 from "fs/promises";
import path18 from "path";
function getCompileJobOutputFiles(job) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) => path18.join(job.chunkOutputPathPrefix, `${chunkSpec.split(":", 1)[0]}.js`));
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
  const metadata = await readJsonIfExists(path18.join(jobCacheDir, "meta.json"));
  if (!metadata || metadata.version !== CLOSURE_JOB_CACHE_VERSION || metadata.artifactFiles.length !== artifactFiles.length) {
    return false;
  }
  const cachedFiles = metadata.artifactFiles.map((fileName) => path18.join(jobCacheDir, fileName));
  const filesReady = await Promise.all(cachedFiles.map((filePath) => fs13.stat(filePath).then(() => true).catch(() => false)));
  if (filesReady.some((ready) => !ready)) {
    return false;
  }
  await Promise.all(artifactFiles.map(async (artifactFile, index) => {
    await ensureDirectory(path18.dirname(artifactFile));
    await fs13.copyFile(cachedFiles[index], artifactFile);
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
  await fs13.rm(jobCacheDir, { force: true, recursive: true });
  await ensureDirectory(jobCacheDir);
  const artifactNames = artifactFiles.map((artifactFile) => path18.basename(artifactFile));
  await Promise.all(artifactFiles.map((artifactFile, index) => fs13.copyFile(artifactFile, path18.join(jobCacheDir, artifactNames[index]))));
  await writeJson(path18.join(jobCacheDir, "meta.json"), {
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
      jsOutputKinds: outputFiles.map((outputFile) => path18.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel
    },
    jsHash,
    version: CLOSURE_JOB_CACHE_VERSION
  });
  return path18.join(cacheDir, cacheKey);
}
var CLOSURE_JOB_CACHE_VERSION = 2;
var init_cache2 = __esm(() => {
  init_hash();
  init_store();
  init_files();
});

// src/stages/closure/concurrency.ts
import os2 from "os";
function determineClosureConcurrency(jobCount) {
  const override = process.env.GCC_CLOSURE_CONCURRENCY;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(jobCount, parsed);
    }
  }
  const available = os2.availableParallelism?.() ?? os2.cpus().length ?? 1;
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
var init_concurrency = () => {};

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
import fs14 from "fs/promises";
async function readCachedText(filePath, cache) {
  let pending = cache.get(filePath);
  if (!pending) {
    pending = fs14.readFile(filePath, "utf-8");
    cache.set(filePath, pending);
  }
  return pending;
}
async function readPropertyRenamingReport(reportPath, cache) {
  return readCachedText(reportPath, cache);
}
var init_io = () => {};

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
import fs15 from "fs/promises";
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
      await fs15.copyFile(action.inputPath, action.outputPath);
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
    await fs15.writeFile(action.outputPath, contents);
  }));
}
var init_postprocess = __esm(() => {
  init_files();
  init_load();
  init_es5();
  init_io();
});

// src/stages/closure/run-closure.ts
import fs16 from "fs/promises";
import path19 from "path";
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
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) => path19.join(cacheOutputDir, path19.relative(outDir, outputFile)));
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
  await fs16.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);
  const rawDir = path19.join(finalCacheDir, "raw");
  const cacheOutputDir = path19.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await fs16.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);
  return { cacheOutputDir, rawDir };
}
async function writeGeneratedAssets(assets) {
  await Promise.all(assets.map(async (asset) => {
    await ensureParentDirectory(asset.path);
    await fs16.writeFile(asset.path, asset.text, "utf-8");
  }));
}
async function compilePreparedClosureJobs({
  chunkMode,
  prepared,
  projectCacheDir,
  usesPersistentCache
}) {
  const cacheDir = usesPersistentCache ? path19.join(projectCacheDir, "closure-jobs") : null;
  const concurrency = chunkMode === "bundler-runtime" ? determineClosureConcurrency(prepared.compileJobs.length) : 1;
  return runWithConcurrency(prepared.compileJobs, concurrency, async (job) => runPreparedClosureJob({
    cacheDir,
    job
  }));
}
async function publishPreparedClosureOutputs(outputFiles, cacheOutputDir) {
  await copyOrLinkFiles(outputFiles, cacheOutputDir);
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
    return 0;
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
    return exitCode;
  }
  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job
    });
  }
  return 0;
}
var init_run_closure = __esm(() => {
  init_files();
  init_timing();
  init_load();
  init_compiler();
  init_cache2();
  init_concurrency();
  init_postprocess();
});

// src/pipeline/build-helpers.ts
import fs17 from "fs";
import path20 from "path";
async function publishOutputs(outputFiles, outDir) {
  if (await publishedOutputsMatch2(outputFiles, outDir)) {
    return;
  }
  await copyOrLinkFiles(outputFiles, outDir);
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
function toPublishedOutputPaths(publishedOutputs, outDir) {
  return publishedOutputs.map(({ name }) => path20.join(outDir, name));
}
function createBuildDiagnostic(error) {
  return {
    category: 1,
    code: 0,
    messageText: error instanceof Error ? error.message : typeof error === "string" ? error : "Build failed."
  };
}
async function removeProjectCacheDir(projectCacheDir) {
  await fs17.promises.rm(projectCacheDir, { force: true, recursive: true });
}
var init_build_helpers = __esm(() => {
  init_files();
  init_file_state();
});

// src/pipeline/build-pipeline.ts
var exports_build_pipeline = {};
__export(exports_build_pipeline, {
  cleanCache: () => cleanCache,
  build: () => build
});
import path21 from "path";
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  const usesPersistentCache = context.options.cache.mode === "persistent";
  if (usesPersistentCache) {
    const fastSnapshot = await readJsonIfExists(path21.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(fastSnapshot.publishedOutputs, context.options.outDir)
      };
    }
  }
  let resolved = null;
  try {
    resolved = await withInternalTiming("resolve-build", () => resolveBuild(context));
    const resolvedBuild = resolved;
    const finalMetadataPath = path21.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = usesPersistentCache ? await readJsonIfExists(finalMetadataPath) : null;
    if (usesPersistentCache && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(finalMetadata.outputFiles.map((outputFile) => ({
          name: path21.basename(outputFile)
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
          importPath: toImportPath(path21.relative(path21.dirname(path21.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
          shimPath: path21.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
        }))
      });
    }
    const nativeEmitMetadataPath = path21.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
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
      await writeJson(path21.join(context.projectCacheDir, "final-fast.json"), {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats2(closureResult.outputFiles),
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
  const projectRoot = path21.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path21.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  await removeProjectCacheDir(projectCacheDir);
}
var init_build_pipeline = __esm(() => {
  init_store();
  init_file_state();
  init_resolve_build();
  init_emit();
  init_run_closure();
  init_load();
  init_build_helpers();
  init_timing();
});

// src/api/externs.ts
import fs6 from "fs";
import path7 from "path";

// src/api/externs/context.ts
import ts3 from "typescript";

// src/api/externs/contracts/registry.ts
import path4 from "path";
import ts2 from "typescript";

// src/api/externs/shared.ts
import path3 from "path";
import ts from "typescript";
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
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
  const resolvedFilePath = path3.resolve(filePath);
  return !resolvedFilePath.includes(`${path3.sep}node_modules${path3.sep}`) && !resolvedFilePath.endsWith(".d.ts") && resolvedFilePath.startsWith(path3.resolve(projectRoot) + path3.sep);
}
function isExportedDeclaration(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}
function hasStaticModifier(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Static) !== 0;
}
function hasNonPublicModifier(node) {
  const modifierFlags = ts.getCombinedModifierFlags(node);
  return (modifierFlags & ts.ModifierFlags.Private) !== 0 || (modifierFlags & ts.ModifierFlags.Protected) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}
function getStringLiteralMemberName(expression) {
  if (!expression) {
    return null;
  }
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}
function isExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !name.startsWith("_") && !name.startsWith("$") && !BUILTIN_CONTAINER_NAMES.has(name);
}
function isRuntimeExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !BUILTIN_CONTAINER_NAMES.has(name) && !BUILTIN_RUNTIME_MEMBER_NAMES.has(name);
}
function isThisOrSuperExpression(expression) {
  return expression.kind === ts.SyntaxKind.ThisKeyword || expression.kind === ts.SyntaxKind.SuperKeyword;
}
function isKnownConstructorExpression(expression, knownConstructors) {
  return ts.isIdentifier(expression) && knownConstructors.has(expression.text);
}
function isKnownPrototypeExpression(expression, knownConstructors) {
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "prototype" && isKnownConstructorExpression(expression.expression, knownConstructors);
}
function isObjectDefinePropertyCall(expression) {
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Object" && expression.name.text === "defineProperty";
}
function isAssignmentOperator(kind) {
  return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}
function getScriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}
function isScannedDeclarationSymbol(symbol, scannedFiles) {
  return (symbol.declarations ?? []).some((declaration) => scannedFiles.has(path3.resolve(declaration.getSourceFile().fileName)));
}
function findPackageDir(filePath) {
  let currentDir = path3.dirname(filePath);
  while (true) {
    const packageJsonPath = path3.join(currentDir, "package.json");
    if (ts.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = path3.dirname(currentDir);
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
  return filePath.includes(`${path3.sep}node_modules${path3.sep}typescript${path3.sep}lib${path3.sep}`);
}
function symbolCacheKey(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration ? `${path3.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}` : symbol.getName();
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
  const scannedFileSet = new Set(scannedFiles.map((filePath) => path4.resolve(filePath)));
  const interfaceContracts = new Map;
  const typeAliasContracts = new Map;
  const classContracts = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(path4.resolve(sourceFile.fileName))) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (ts2.isInterfaceDeclaration(statement) && isExportedDeclaration(statement)) {
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
      if (ts2.isTypeAliasDeclaration(statement) && isExportedDeclaration(statement)) {
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
      if (ts2.isClassDeclaration(statement) && statement.name && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set;
        const staticMembers = new Set;
        for (const member of statement.members) {
          if (ts2.isConstructorDeclaration(member)) {
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
    if (ts2.isPropertySignature(member) || ts2.isMethodSignature(member) || ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member)) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}
function collectAliasMembers(typeNode) {
  if (ts2.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }
  if (ts2.isIntersectionTypeNode(typeNode)) {
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
  if (ts2.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles) ? new Set([symbol]) : new Set;
  }
  if (ts2.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }
  if (ts2.isIntersectionTypeNode(typeNode) || ts2.isUnionTypeNode(typeNode)) {
    const symbols = new Set;
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(child, checker, scannedFiles)) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }
  if (ts2.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(typeNode.typeName, checker, scannedFiles);
  }
  return new Set;
}
function getContractSymbolsFromEntityName(entityName, checker, scannedFiles) {
  const symbol = ts2.isIdentifier(entityName) ? checker.getSymbolAtLocation(entityName) : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set;
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles) ? new Set([resolved]) : new Set;
}
function collectConstructorParamContracts(statement, checker, scannedFiles) {
  const constructorDeclaration = statement.members.find((member) => ts2.isConstructorDeclaration(member));
  if (!constructorDeclaration || !ts2.isConstructorDeclaration(constructorDeclaration)) {
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
    if (clause.token === ts2.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
          contracts.add(symbol);
        }
      }
      continue;
    }
    if (clause.token === ts2.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) => ts2.isClassDeclaration(item));
        if (declaration && ts2.isClassDeclaration(declaration)) {
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
  const program = ts3.createProgram(rootNames, {
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
import fs4 from "fs";
import path6 from "path";
import ts5 from "typescript";
async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: ts5.ModuleKind.ESNext,
    moduleResolution: ts5.ModuleResolutionKind.Bundler,
    target: ts5.ScriptTarget.ESNext
  };
  const resolvedConfigPath = tsConfigPath ?? path6.join(projectRoot, "tsconfig.json");
  try {
    await fs4.promises.access(resolvedConfigPath, fs4.constants.R_OK);
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
    if (path6.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path6.resolve(srcDir, entry);
    if (ts5.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path6.resolve(projectRoot, entry);
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
    const resolvedFile = path6.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);
    const sourceText = await fs4.promises.readFile(resolvedFile, "utf8");
    const sourceFile = ts5.createSourceFile(resolvedFile, sourceText, ts5.ScriptTarget.Latest, true);
    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = ts5.resolveModuleName(specifier, resolvedFile, compilerOptions, ts5.sys).resolvedModule;
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
  const containingFile = path6.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = ts5.resolveModuleName(specifier, containingFile, compilerOptions, ts5.sys).resolvedModule;
  const resolvedFromTypescript = resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }
  const require3 = ts5.createModuleResolutionCache(projectRoot, (fileName) => fileName, compilerOptions);
  const fallbackResolution = ts5.nodeModuleNameResolver(specifier, containingFile, compilerOptions, ts5.sys, require3).resolvedModule;
  const resolvedFromFallback = fallbackResolution && normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }
  throw new Error(`Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`);
}
function normalizeResolvedTypeFile(resolvedFileName) {
  const normalizedPath = path6.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }
  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (ts5.sys.fileExists(candidate)) {
      return path6.resolve(candidate);
    }
  }
  return null;
}
function withTypeExtension(filePath, nextExtension) {
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return filePath;
  }
  const extension = path6.extname(filePath);
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
    if (ts5.isImportDeclaration(node) || ts5.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts5.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (ts5.isImportEqualsDeclaration(node) && ts5.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts5.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text);
    } else if (ts5.isImportTypeNode(node) && ts5.isLiteralTypeNode(node.argument) && ts5.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text);
    }
    ts5.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

// src/api/externs/runtime-analysis.ts
import fs5 from "fs";
import ts6 from "typescript";
async function analyzeRuntimeUsage(runtimeEntryFiles) {
  const hazards = {
    accessedMembers: new Set,
    definedMembers: new Set,
    protocolMembers: new Set
  };
  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs5.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts6.createSourceFile(runtimeEntryFile, sourceText, ts6.ScriptTarget.Latest, true, getScriptKindForFile(runtimeEntryFile));
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node) => {
      if (ts6.isPropertyAccessExpression(node)) {
        if (isRelevantRuntimeTarget(node.expression, knownConstructors) && isRuntimeExternPropertyName(node.name.text)) {
          hazards.accessedMembers.add(node.name.text);
        }
      } else if (ts6.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, hazards);
      } else if (ts6.isCallExpression(node)) {
        collectProtocolHelperMembers(node, hazards);
        collectRuntimeCallMembers(node, knownConstructors, hazards);
      }
      ts6.forEachChild(node, visit);
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
  if (!memberList || !ts6.isArrayLiteralExpression(memberList)) {
    return;
  }
  for (const element of memberList.elements) {
    if (!ts6.isStringLiteral(element) && !ts6.isNoSubstitutionTemplateLiteral(element)) {
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
  if (ts6.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts6.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts6.isElementAccessExpression(expression)) {
    return getStringLiteralMemberName(expression.argumentExpression);
  }
  if (ts6.isParenthesizedExpression(expression)) {
    return getProtocolHelperCalleeName(expression.expression);
  }
  return null;
}
function collectKnownConstructorBindings(sourceFile) {
  const knownConstructors = new Set;
  const visit = (node) => {
    if ((ts6.isClassDeclaration(node) || ts6.isFunctionDeclaration(node)) && node.name) {
      knownConstructors.add(node.name.text);
    } else if (ts6.isVariableDeclaration(node) && ts6.isIdentifier(node.name) && node.initializer && (ts6.isClassExpression(node.initializer) || ts6.isFunctionExpression(node.initializer) || ts6.isArrowFunction(node.initializer))) {
      knownConstructors.add(node.name.text);
    }
    ts6.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}
function collectRuntimeAssignmentMembers(target, knownConstructors, hazards) {
  if (ts6.isPropertyAccessExpression(target)) {
    if (isRelevantRuntimeTarget(target.expression, knownConstructors)) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        hazards.definedMembers.add(target.name.text);
      }
    }
    return;
  }
  if (ts6.isElementAccessExpression(target)) {
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
  if (ts6.isIdentifier(expression)) {
    return expression.text.startsWith("__publicField");
  }
  if (ts6.isPropertyAccessExpression(expression)) {
    return expression.name.text.startsWith("__publicField");
  }
  if (ts6.isParenthesizedExpression(expression)) {
    return isPublicFieldHelperCall(expression.expression);
  }
  return false;
}
function isRelevantRuntimeTarget(expression, knownConstructors) {
  return isThisOrSuperExpression(expression) || isKnownPrototypeExpression(expression, knownConstructors) || isKnownConstructorExpression(expression, knownConstructors);
}

// src/api/externs/contracts/usage.ts
import ts7 from "typescript";
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
      if (ts7.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child) => {
          if (ts7.isNewExpression(child)) {
            analyzeNewExpression(child, checker, registry, usage, importBindings, localBindings);
          } else if (ts7.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (ts7.isElementAccessExpression(child) && ts7.isStringLiteral(child.argumentExpression)) {
            analyzeElementAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (ts7.isVariableDeclaration(child)) {
            registerVariableBinding(child, checker, registry, importBindings, localBindings);
          }
          ts7.forEachChild(child, classVisit);
        };
        ts7.forEachChild(node, classVisit);
        return;
      }
      if (ts7.isVariableDeclaration(node)) {
        registerVariableBinding(node, checker, registry, importBindings, localBindings);
      } else if (ts7.isNewExpression(node)) {
        analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings);
      } else if (ts7.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      } else if (ts7.isElementAccessExpression(node) && ts7.isStringLiteral(node.argumentExpression)) {
        analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      }
      ts7.forEachChild(node, visit);
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
  if (ts7.isIdentifier(node.expression) && importBindings.has(node.expression.text)) {
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
  if (!ts7.isStringLiteral(argumentExpression)) {
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
    if (!ts7.isImportDeclaration(statement) || !statement.importClause) {
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
    if (!namedBindings || !ts7.isNamedImports(namedBindings)) {
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
    if (!ts7.isPropertyDeclaration(member) || !member.initializer || !ts7.isIdentifier(member.name) || !ts7.isNewExpression(member.initializer) || !ts7.isIdentifier(member.initializer.expression)) {
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
  if (!ts7.isIdentifier(declaration.name) || !declaration.initializer) {
    return;
  }
  const initializer = declaration.initializer;
  const resolvedTypeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(initializer), checker);
  const classSymbol = (ts7.isNewExpression(initializer) && ts7.isIdentifier(initializer.expression) ? importBindings.get(initializer.expression.text) : undefined) ?? (resolvedTypeSymbol ? findClassContractByName(resolvedTypeSymbol.getName(), registry) : undefined);
  if (!classSymbol) {
    return;
  }
  localBindings.set(declaration.name.text, classSymbol);
}
function resolveBoundClassSymbol(expression, importBindings, localBindings, fieldBindings) {
  if (ts7.isIdentifier(expression)) {
    return localBindings.get(expression.text) ?? importBindings.get(expression.text) ?? null;
  }
  if (ts7.isPropertyAccessExpression(expression) && expression.expression.kind === ts7.SyntaxKind.ThisKeyword) {
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
  return !(ts7.isArrayLiteralExpression(expression) || ts7.isObjectLiteralExpression(expression) || ts7.isStringLiteralLike(expression) || ts7.isNumericLiteral(expression) || expression.kind === ts7.SyntaxKind.TrueKeyword || expression.kind === ts7.SyntaxKind.FalseKeyword || expression.kind === ts7.SyntaxKind.NullKeyword);
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
  const projectRoot = path7.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path7.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath = options.tsConfigPath && path7.resolve(projectRoot, options.tsConfigPath);
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
  const outputFile = options.outputFile && path7.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await fs6.promises.mkdir(path7.dirname(outputFile), { recursive: true });
    await fs6.promises.writeFile(outputFile, text, "utf8");
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
import minimist from "minimist";

// src/cli/parse-externs-options.ts
import minimist2 from "minimist";

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
export {
  generateExterns,
  cleanCache2 as cleanCache,
  build2 as build,
  DEFAULT_BUILD_OPTIONS
};
