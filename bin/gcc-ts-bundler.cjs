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
var import_fs6 = __toESM(require("fs"));
var import_path6 = __toESM(require("path"));

// src/cache/store.ts
var import_fs2 = __toESM(require("fs"));
var import_os = __toESM(require("os"));
var import_path2 = __toESM(require("path"));

// src/utils/file-utils.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
async function ensureDirectoryExistence(filePath) {
  const dirName = import_path.default.dirname(filePath);
  if (await import_fs.default.promises.access(dirName).then(() => true).catch(() => false))
    return;
  await import_fs.default.promises.mkdir(dirName, { recursive: true });
}

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
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return import_path2.default.join(import_os.default.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return import_path2.default.join(process.env.LOCALAPPDATA ?? import_path2.default.join(import_os.default.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return import_path2.default.join(process.env.XDG_CACHE_HOME ?? import_path2.default.join(import_os.default.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await import_fs2.default.promises.mkdtemp(import_path2.default.join(import_os.default.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = import_path2.default.join(rootDir2, "workspace");
    await import_fs2.default.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await import_fs2.default.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = import_path2.default.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path2.default.join(rootDir, hashContent(projectRoot));
  const workspaceDir = import_path2.default.join(projectCacheDir, "workspace");
  await import_fs2.default.promises.mkdir(workspaceDir, { recursive: true });
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
    const raw = await import_fs2.default.promises.readFile(filePath, "utf-8");
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
  await import_fs2.default.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

// src/pipeline/resolve-build.ts
var import_fs4 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
var import_typescript = __toESM(require("typescript"));
var import_url = require("url");

// src/native/load.ts
var import_fs3 = __toESM(require("fs"));
var import_module = require("module");
var require2 = import_module.createRequire("file:///Users/Blueagle/Code/gcc-ts-bundler/src/native/load.ts");
var cachedBinding = null;
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  const nativeModulePath = require2.resolve("gcc-ts-bundler/native");
  if (!import_fs3.default.existsSync(nativeModulePath)) {
    throw new Error(`Native module not found at ${nativeModulePath}. Run \`bun run build:native\` in gcc-ts-bundler.`);
  }
  cachedBinding = require2(nativeModulePath);
  return cachedBinding;
}
function resolveGraph(input) {
  return JSON.parse(loadBinding().resolveGraphJson(JSON.stringify(input)));
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return JSON.parse(loadBinding().transpileSourcesJson(JSON.stringify(input)));
}
function writeEntryShims(input) {
  return JSON.parse(loadBinding().writeEntryShimsJson(JSON.stringify(input)));
}

// src/pipeline/resolve-build.ts
async function resolveBuild(options) {
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }
  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot
  });
  const packageRoot = getPackageRoot();
  const packageJsonRaw = await import_fs4.default.promises.readFile(import_path3.default.join(packageRoot, "package.json"), "utf-8");
  const packageJson = JSON.parse(packageJsonRaw);
  const runtimeSignature = await readRuntimeSignature(packageRoot);
  const nativeSignature = await readNativeSignature(packageRoot);
  const packageSignature = hashContent(`${packageJsonRaw}
${runtimeSignature}
${nativeSignature}`);
  const sourceRoot = import_path3.default.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);
  const compilerOptions = await loadCompilerOptions(options.projectRoot);
  const overlayEntries = options.entries.map((entry) => import_path3.default.join(sourceRoot, import_path3.default.relative(options.srcDir, entry)));
  const graphResult = resolveGraph({
    entries: overlayEntries,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir
  });
  const outputNames = resolveOutputNames(options.entries.map((entry) => import_path3.default.relative(options.srcDir, entry)));
  const resolveKey = hashJson({
    compilerOptions,
    entries: options.entries.map((entry) => import_path3.default.relative(options.srcDir, entry)),
    files: graphResult.fileHashes,
    packageSignature
  });
  const resolveMetadataPath = import_path3.default.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = await readJsonIfExists(resolveMetadataPath);
  const isResolveCacheHit = resolveMetadata !== null;
  if (!resolveMetadata) {
    resolveMetadata = {
      entryFiles: graphResult.entries.map((entry, index) => ({
        chunkName: sanitizeChunkName(outputNames[index]),
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: outputNames[index],
        sourceRelativePath: import_path3.default.relative(sourceRoot, entry.sourcePath)
      })),
      graph: toRelativeGraph(graphResult.graph, cacheStore.workspaceDir)
    };
    await writeJson(resolveMetadataPath, resolveMetadata);
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => ({
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    outputPath: import_path3.default.join(options.outDir, entry.outputName),
    sourcePath: import_path3.default.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  }));
  const shimDir = import_path3.default.join(cacheStore.workspaceDir, "entries");
  const externalInputHash = await hashExternalInputs([
    ...options.externs,
    ...options.js
  ]);
  const nativeEmitKey = hashJson({
    compilerOptions,
    diagnostics: options.diagnostics,
    packageSignature,
    resolveKey
  });
  const finalKey = hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash,
    languageOut: options.languageOut,
    packageSignature,
    nativeEmitKey,
    resolveKey
  });
  return {
    cacheRoot: cacheStore.rootDir,
    cleanup: cacheStore.cleanup,
    compilerOptions,
    entryFiles,
    externalInputHash,
    fileHashes: graphResult.fileHashes,
    filePaths: graphResult.filePaths,
    finalCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    graph: fromRelativeGraph(resolveMetadata.graph, cacheStore.workspaceDir),
    isFinalCacheHit: false,
    isNativeEmitCacheHit: false,
    isResolveCacheHit,
    options,
    packageRoot,
    packageVersion: packageJson.version,
    projectCacheDir: cacheStore.projectCacheDir,
    resolveKey,
    resolveMetadataPath,
    sharedChunkName: entryFiles.length > 1 ? "shared" : null,
    shimDir,
    shimFiles: entryFiles.map((entry) => import_path3.default.join(shimDir, `${entry.chunkName}.ts`)),
    sourceRoot,
    tsConfigPath: import_path3.default.join(options.projectRoot, "tsconfig.json"),
    nativeEmitCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    nativeEmitKey,
    workspaceDir: cacheStore.workspaceDir
  };
}
function resolveOutputNames(entryPaths) {
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
async function loadCompilerOptions(projectRoot) {
  const configPath = import_typescript.default.findConfigFile(projectRoot, import_typescript.default.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  const configFile = import_typescript.default.readConfigFile(configPath, import_typescript.default.sys.readFile);
  if (configFile.error) {
    throw new Error(import_typescript.default.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = import_typescript.default.parseJsonConfigFileContent(configFile.config, import_typescript.default.sys, projectRoot, {}, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(import_typescript.default.formatDiagnosticsWithColorAndContext(parsedConfig.errors, import_typescript.default.createCompilerHost({})));
  }
  return parsedConfig.options;
}
function toRelativeGraph(graph, workspaceDir) {
  return Object.fromEntries(Object.entries(graph).map(([filePath, dependencies]) => [
    import_path3.default.relative(workspaceDir, filePath),
    dependencies.map((dependency) => import_path3.default.relative(workspaceDir, dependency))
  ]));
}
function fromRelativeGraph(graph, workspaceDir) {
  return Object.fromEntries(Object.entries(graph).map(([filePath, dependencies]) => [
    import_path3.default.join(workspaceDir, filePath),
    dependencies.map((dependency) => import_path3.default.join(workspaceDir, dependency))
  ]));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await import_fs4.default.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
function getPackageRoot() {
  return import_path3.default.dirname(import_path3.default.dirname(import_url.fileURLToPath("file:///Users/Blueagle/Code/gcc-ts-bundler/src/pipeline/resolve-build.ts")));
}
async function readRuntimeSignature(packageRoot) {
  try {
    return await import_fs4.default.promises.readFile(import_path3.default.join(packageRoot, "dist", "index.mjs"), "utf-8");
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot) {
  try {
    const contents = await import_fs4.default.promises.readFile(import_path3.default.join(packageRoot, "native", "index.node"));
    return hashContent(contents.toString("base64"));
  } catch {
    return "";
  }
}
function normalizeBuildOptions(options) {
  const projectRoot = import_path3.default.resolve(options.projectRoot ?? process.cwd());
  const srcDir = import_path3.default.resolve(projectRoot, options.srcDir ?? "src");
  const outDir = import_path3.default.resolve(projectRoot, options.outDir ?? "dist");
  return {
    cache: {
      dir: options.cache?.dir ? import_path3.default.resolve(projectRoot, options.cache.dir) : "",
      mode: options.cache?.mode ?? "persistent"
    },
    compilationLevel: options.compilationLevel ?? "ADVANCED",
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? false,
      preflight: options.diagnostics?.preflight ?? "errors-only",
      verbose: options.diagnostics?.verbose ?? false
    },
    entries: options.entries.map((entry) => import_path3.default.isAbsolute(entry) ? entry : import_path3.default.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => import_path3.default.isAbsolute(filePath) ? filePath : import_path3.default.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => import_path3.default.isAbsolute(filePath) ? filePath : import_path3.default.resolve(projectRoot, filePath)),
    languageOut: options.languageOut ?? "ECMASCRIPT_NEXT",
    outDir,
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
  compilerOptions,
  fileNames,
  metadataPath,
  options,
  workspaceDir
}) {
  const outDir = import_path4.default.join(cacheDir, "out");
  const externsPath = import_path4.default.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readMetadata(metadataPath);
  if (cachedMetadata && await pathExists(cachedMetadata.externsPath) && (await Promise.all(cachedMetadata.emittedFiles.map(pathExists))).every(Boolean)) {
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
  const finalCompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    moduleResolution: import_typescript2.default.ModuleResolutionKind.Bundler,
    outDir,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript2.default.ScriptTarget.ESNext
  };
  const compilerHost = import_typescript2.default.createCompilerHost(finalCompilerOptions);
  const program = import_typescript2.default.createProgram(fileNames, finalCompilerOptions, compilerHost);
  const diagnostics = getPreflightDiagnostics(program, options.diagnostics.preflight);
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
function getPreflightDiagnostics(program, preflight) {
  if (preflight === "off") {
    return [];
  }
  if (preflight === "full") {
    return [...import_typescript2.default.getPreEmitDiagnostics(program)];
  }
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics()
  ];
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
async function pathExists(filePath) {
  try {
    await import_fs5.default.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// src/stages/closure/run-closure.ts
var import_promises = __toESM(require("fs/promises"));
var closureCompilerPackage = __toESM(require("google-closure-compiler"));
var import_utils = require("google-closure-compiler/lib/utils.js");
var import_path5 = __toESM(require("path"));
async function runClosureStage({
  emittedOutDir,
  entryFiles,
  externPaths,
  finalCacheDir,
  graph,
  options,
  packageRoot,
  shimFiles,
  workspaceDir
}) {
  await import_promises.default.rm(finalCacheDir, { force: true, recursive: true });
  await import_promises.default.mkdir(finalCacheDir, { recursive: true });
  const rawDir = import_path5.default.join(finalCacheDir, "raw");
  const outputDir = import_path5.default.join(finalCacheDir, "outputs");
  await import_promises.default.mkdir(rawDir, { recursive: true });
  await import_promises.default.mkdir(outputDir, { recursive: true });
  const closureLibFiles = await collectJavaScriptFiles(import_path5.default.join(packageRoot, "closure-lib"));
  const chunkPlan = buildChunkPlan({
    entryFiles,
    graph,
    shimFiles,
    workspaceDir,
    emittedOutDir
  });
  const exitCode = chunkPlan.length === 1 ? await runSingleClosureCompilation({
    closureLibFiles,
    entryChunk: chunkPlan[0],
    externPaths,
    options,
    rawOutputPath: import_path5.default.join(rawDir, `${chunkPlan[0].name}.js`)
  }) : await runChunkedClosureCompilation({
    chunkPlan,
    closureLibFiles,
    externPaths,
    options,
    outputDir: rawDir
  });
  if (exitCode !== 0) {
    return exitCode;
  }
  const rawOutputs = await collectJavaScriptFiles(rawDir);
  await Promise.all(rawOutputs.map(async (rawFile) => {
    const contents = await import_promises.default.readFile(rawFile, "utf-8");
    const transformed = rewriteGccExports(contents);
    await import_promises.default.writeFile(import_path5.default.join(outputDir, import_path5.default.basename(rawFile)), transformed);
  }));
  return 0;
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
function buildChunkPlan({
  emittedOutDir,
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
      files: toEmittedPaths(topologicalSort(Array.from(reachability.get(onlyShim) ?? []), graph), emittedOutDir, workspaceDir),
      isEntryChunk: true,
      name: stripExtension(onlyEntry.outputName)
    });
    return chunks;
  }
  if (sharedFiles.size > 0) {
    chunks.push({
      dependencies: [],
      files: toEmittedPaths(topologicalSort(Array.from(sharedFiles), graph), emittedOutDir, workspaceDir),
      isEntryChunk: false,
      name: "shared"
    });
  }
  for (const shimFile of shimFiles) {
    const entry = shimToEntry.get(shimFile);
    const reachable = reachability.get(shimFile) ?? new Set;
    const uniqueFiles = Array.from(reachable).filter((filePath) => !sharedFiles.has(filePath));
    chunks.push({
      dependencies: sharedFiles.size > 0 ? ["shared"] : [],
      files: toEmittedPaths(topologicalSort(uniqueFiles, graph), emittedOutDir, workspaceDir),
      isEntryChunk: true,
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
function toEmittedPaths(files, emittedOutDir, workspaceDir) {
  return files.map((filePath) => import_path5.default.join(emittedOutDir, import_path5.default.relative(workspaceDir, filePath).replace(/\.[^/.]+$/, ".js")));
}
function stripExtension(filePath) {
  return filePath.replace(/\.[^/.]+$/, "");
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

// src/pipeline/build-pipeline.ts
async function build(options) {
  const normalizedOptions = normalizeBuildOptions(options);
  const resolved = await resolveBuild(normalizedOptions);
  try {
    const finalMetadataPath = import_path6.default.join(resolved.finalCacheDir, "meta.json");
    const finalMetadata = await readJsonIfExists(finalMetadataPath);
    if (normalizedOptions.cache.mode !== "off" && finalMetadata && (await Promise.all(finalMetadata.outputFiles.map(pathExists2))).every(Boolean)) {
      await publishOutputs(finalMetadata.outputFiles, normalizedOptions.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        options: normalizedOptions,
        outputFiles: finalMetadata.outputFiles,
        workspaceDir: resolved.workspaceDir
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
      compilerOptions: resolved.compilerOptions,
      fileNames: [...resolved.filePaths, ...resolved.shimFiles],
      metadataPath: nativeEmitMetadataPath,
      options: normalizedOptions,
      workspaceDir: resolved.workspaceDir
    });
    if (nativeEmitResult.diagnostics.length > 0 || nativeEmitResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: nativeEmitResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir
      };
    }
    const bundledExterns = await collectBundledExterns(resolved.packageRoot);
    const exitCode = await runClosureStage({
      emittedOutDir: nativeEmitResult.outDir,
      entryFiles: resolved.entryFiles,
      externPaths: [
        ...normalizedOptions.externs,
        ...bundledExterns,
        nativeEmitResult.externsPath
      ],
      finalCacheDir: resolved.finalCacheDir,
      graph: {
        ...resolved.graph,
        ...Object.fromEntries(resolved.shimFiles.map((shimFile, index) => [
          shimFile,
          [resolved.entryFiles[index].sourcePath]
        ]))
      },
      options: normalizedOptions,
      packageRoot: resolved.packageRoot,
      shimFiles: resolved.shimFiles,
      workspaceDir: resolved.workspaceDir
    });
    if (exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir
      };
    }
    const finalOutputFiles = await collectJavaScriptFiles2(import_path6.default.join(resolved.finalCacheDir, "outputs"));
    await writeJson(finalMetadataPath, {
      outputFiles: finalOutputFiles
    });
    await publishOutputs(finalOutputFiles, normalizedOptions.outDir);
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      options: normalizedOptions,
      outputFiles: finalOutputFiles,
      workspaceDir: resolved.workspaceDir
    };
  } catch (error) {
    console.error(error);
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: true,
      exitCode: 1,
      options: normalizedOptions,
      outputFiles: [],
      workspaceDir: resolved.workspaceDir
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
  const closureExternsPath = import_path6.default.join(packageRoot, "closure-externs");
  const entries = await import_fs6.default.promises.readdir(closureExternsPath);
  return entries.map((entry) => import_path6.default.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
}
async function collectJavaScriptFiles2(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await import_fs6.default.promises.readdir(currentDir, {
      withFileTypes: true
    });
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
async function publishOutputs(outputFiles, outDir) {
  await import_fs6.default.promises.rm(outDir, { force: true, recursive: true });
  await import_fs6.default.promises.mkdir(outDir, { recursive: true });
  await Promise.all(outputFiles.map((outputFile) => import_fs6.default.promises.copyFile(outputFile, import_path6.default.join(outDir, import_path6.default.basename(outputFile)))));
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
async function pathExists2(filePath) {
  try {
    await import_fs6.default.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
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
