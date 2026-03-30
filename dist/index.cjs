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

// src/entry/api.ts
var exports_api = {};
__export(exports_api, {
  runCli: () => runCli,
  resolveBuild: () => resolveBuild,
  parseCliArgs: () => parseCliArgs,
  normalizeBuildOptions: () => normalizeBuildOptions,
  main: () => main,
  cleanCache: () => cleanCache,
  build: () => build2,
  DEFAULT_BUILD_OPTIONS: () => DEFAULT_BUILD_OPTIONS
});
module.exports = __toCommonJS(exports_api);

// src/cli/usage.ts
function usage() {
  console.error(`Usage: gcc-ts-bundler [options]

Example:
  gcc-ts-bundler --project-root=. --src-dir=./src --entry=./index.ts --out-dir=./dist

Primary flags:
  --project-root        Project root used to resolve tsconfig.json and relative paths
  --src-dir             Source directory containing the entry files
  --entry               Entry file relative to --src-dir. May be provided multiple times
  --out-dir             Output directory
  --language-out        ECMASCRIPT3 | ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT_NEXT
  --compilation-level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --cache-mode          off | temp | persistent
  --cache-dir           Explicit cache directory
  --preflight           off | errors-only | full
  --post-minify         false | swc
  --no-rewrite-exports  Disable SWC export rewriting
  --verbose             Print verbose diagnostics
  --fatal-warnings      Treat tsickle warnings as fatal
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
  postProcess: {
    minify: false,
    rewriteExports: true
  },
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
    boolean: ["fatal-warnings", "help", "no-rewrite-exports", "verbose"],
    string: [
      "cache-dir",
      "cache-mode",
      "compilation-level",
      "entry",
      "entry-point",
      "language-out",
      "out-dir",
      "post-minify",
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
      postProcess: {
        minify: parsedArgs["post-minify"] === "swc" ? "swc" : false,
        rewriteExports: !parsedArgs["no-rewrite-exports"]
      },
      projectRoot: parsedArgs["project-root"] ?? parsedArgs.project_root,
      srcDir: parsedArgs["src-dir"] ?? parsedArgs.src_dir ?? parsedArgs.srcDir
    },
    showHelp: false
  };
}

// src/pipeline/build-pipeline.ts
var import_fs6 = __toESM(require("fs"));
var import_path7 = __toESM(require("path"));

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
var import_fs3 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
var import_typescript = __toESM(require("typescript"));
var import_url = require("url");
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
  const packageJsonRaw = await import_fs3.default.promises.readFile(import_path3.default.join(packageRoot, "package.json"), "utf-8");
  const packageJson = JSON.parse(packageJsonRaw);
  const runtimeSignature = await readRuntimeSignature(packageRoot);
  const packageSignature = hashContent(`${packageJsonRaw}
${runtimeSignature}`);
  const sourceRoot = import_path3.default.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);
  const compilerOptions = await loadCompilerOptions(options.projectRoot);
  const overlayEntries = options.entries.map((entry) => import_path3.default.join(sourceRoot, import_path3.default.relative(options.srcDir, entry)));
  const graphResult = await buildSourceGraph({
    compilerOptions,
    entries: overlayEntries,
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
    const exportMetadata = analyzeEntryExports({
      compilerOptions,
      entries: overlayEntries,
      files: graphResult.filePaths
    });
    resolveMetadata = {
      entryFiles: overlayEntries.map((entry, index) => ({
        chunkName: sanitizeChunkName(outputNames[index]),
        exportNames: exportMetadata[index].exportNames,
        hasDefaultExport: exportMetadata[index].hasDefaultExport,
        outputName: outputNames[index],
        sourceRelativePath: import_path3.default.relative(sourceRoot, entry)
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
  const tsickleKey = hashJson({
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
    postProcess: options.postProcess,
    resolveKey,
    tsickleKey
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
    isResolveCacheHit,
    isTsickleCacheHit: false,
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
    tsickleCacheDir: import_path3.default.join(cacheStore.projectCacheDir, "tsickle", tsickleKey),
    tsickleKey,
    workspaceDir: cacheStore.workspaceDir
  };
}
async function buildSourceGraph({
  compilerOptions,
  entries,
  workspaceDir
}) {
  const fileHashes = {};
  const graph = {};
  const fileContents = new Map;
  const visited = new Set;
  const pending = [...entries];
  while (pending.length > 0) {
    const currentFile = pending.pop();
    if (visited.has(currentFile)) {
      continue;
    }
    visited.add(currentFile);
    const contents = await import_fs3.default.promises.readFile(currentFile, "utf-8");
    fileContents.set(currentFile, contents);
    fileHashes[import_path3.default.relative(workspaceDir, currentFile)] = hashContent(contents);
    const preProcessed = import_typescript.default.preProcessFile(contents, true, true);
    const dependencies = new Set;
    const referencedPaths = [
      ...preProcessed.importedFiles.map((item) => item.fileName),
      ...preProcessed.referencedFiles.map((item) => item.fileName)
    ];
    for (const dependency of referencedPaths) {
      const resolved = import_typescript.default.resolveModuleName(dependency, currentFile, compilerOptions, import_typescript.default.sys).resolvedModule?.resolvedFileName;
      if (!resolved) {
        continue;
      }
      if (!resolved.startsWith(`${workspaceDir}${import_path3.default.sep}`)) {
        continue;
      }
      if (resolved.includes(`${import_path3.default.sep}node_modules${import_path3.default.sep}`)) {
        continue;
      }
      dependencies.add(resolved);
      pending.push(resolved);
    }
    graph[currentFile] = [...dependencies].sort((left, right) => left.localeCompare(right));
  }
  const filePaths = [...visited].sort((left, right) => left.localeCompare(right));
  return {
    fileHashes,
    filePaths,
    graph
  };
}
function analyzeEntryExports({
  compilerOptions,
  entries,
  files
}) {
  const program = import_typescript.default.createProgram(files, compilerOptions);
  const checker = program.getTypeChecker();
  return entries.map((entry) => {
    const sourceFile = program.getSourceFile(entry);
    const moduleSymbol = sourceFile ? checker.getSymbolAtLocation(sourceFile) : undefined;
    if (!moduleSymbol) {
      return { exportNames: [], hasDefaultExport: false };
    }
    const exportNames = [];
    let hasDefaultExport = false;
    for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
      const runtimeSymbol = resolveRuntimeSymbol(checker, exportSymbol);
      if (!runtimeSymbol || !(runtimeSymbol.flags & import_typescript.default.SymbolFlags.Value)) {
        continue;
      }
      if (exportSymbol.name === "default") {
        hasDefaultExport = true;
        continue;
      }
      exportNames.push(exportSymbol.name);
    }
    exportNames.sort((left, right) => left.localeCompare(right));
    return { exportNames, hasDefaultExport };
  });
}
function resolveRuntimeSymbol(checker, symbol) {
  try {
    return symbol.flags & import_typescript.default.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  } catch {
    return null;
  }
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
    const currentTarget = await import_fs3.default.promises.readlink(linkPath);
    if (import_path3.default.resolve(import_path3.default.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await import_fs3.default.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await import_fs3.default.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await import_fs3.default.promises.mkdir(import_path3.default.dirname(linkPath), { recursive: true });
  await import_fs3.default.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
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
    hash: hashContent(await import_fs3.default.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
function getPackageRoot() {
  return import_path3.default.dirname(import_path3.default.dirname(import_url.fileURLToPath("file:///Users/Blueagle/Code/gcc-ts-bundler/src/pipeline/resolve-build.ts")));
}
async function readRuntimeSignature(packageRoot) {
  try {
    return await import_fs3.default.promises.readFile(import_path3.default.join(packageRoot, "dist", "index.mjs"), "utf-8");
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
    postProcess: {
      minify: options.postProcess?.minify ?? false,
      rewriteExports: options.postProcess?.rewriteExports ?? true
    },
    projectRoot,
    srcDir
  };
}

// src/stages/pre-compile/entry-shims.ts
var import_path4 = __toESM(require("path"));

// src/utils/file-operations.ts
var import_fs4 = __toESM(require("fs"));
async function writeFileContent(filePath, contents) {
  await ensureDirectoryExistence(filePath);
  await import_fs4.default.promises.writeFile(filePath, contents, "utf-8");
}

// src/stages/pre-compile/entry-shims.ts
async function writeEntryShims({
  entries,
  shimDir
}) {
  return Promise.all(entries.map(async (entry) => {
    const shimPath = import_path4.default.join(shimDir, `${entry.chunkName}.ts`);
    const importPath = toImportPath(import_path4.default.relative(import_path4.default.dirname(shimPath), entry.sourcePath));
    const contents = createEntryShimSource({
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      importPath
    });
    await writeFileContent(shimPath, contents);
    return shimPath;
  }));
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
function createEntryShimSource({
  exportNames,
  hasDefaultExport,
  importPath
}) {
  if (!hasDefaultExport && exportNames.length === 0) {
    return `import __entry = require(${JSON.stringify(importPath)});
void __entry;
`;
  }
  const lines = [
    `import __entry = require(${JSON.stringify(importPath)});`,
    "",
    '((globalThis as Record<string, unknown>)["GCC"] =',
    '  (globalThis as Record<string, unknown>)["GCC"] || {});'
  ];
  for (const exportName of exportNames) {
    lines.push(createGccAssignment(exportName, `__entry.${exportName}`));
  }
  if (hasDefaultExport) {
    lines.push(createGccAssignment("__DEFAULT_EXPORT__", "__entry.default"));
  }
  return `${lines.join(`
`)}
`;
}
function createGccAssignment(exportName, expression) {
  const property = `[${JSON.stringify(exportName)}]`;
  return `(((globalThis as Record<string, unknown>)["GCC"]) as Record<string, unknown>)${property} = ${expression};`;
}

// src/stages/tsickle/emit.ts
var import_fs5 = __toESM(require("fs"));
var import_path5 = __toESM(require("path"));
var import_typescript2 = __toESM(require("typescript"));

// src/tsickle/index.ts
var ts17 = __toESM(require("typescript"));

// src/tsickle/path.ts
var ts2 = __toESM(require("typescript"));
function isAbsolute(path5) {
  return ts2.isRootedDiskPath(path5);
}
function join(p1, p2) {
  return ts2.combinePaths(p1, p2);
}
function dirname(path5) {
  return ts2.getDirectoryPath(path5);
}
function relative(base, rel) {
  return ts2.convertToRelativePath(rel, base, (p) => p);
}
function normalize(path5) {
  return ts2.resolvePath(path5);
}

// src/tsickle/cli-support.ts
function assertAbsolute(fileName) {
  if (!isAbsolute(fileName)) {
    throw new Error(`expected ${JSON.stringify(fileName)} to be absolute`);
  }
}
function pathToModuleName(rootModulePath, context, fileName) {
  fileName = fileName.replace(/(\.d)?\.[tj]s$/, "");
  if (fileName[0] === ".") {
    fileName = join(dirname(context), fileName);
  }
  if (!isAbsolute(fileName))
    fileName = join(rootModulePath, fileName);
  if (rootModulePath) {
    fileName = relative(rootModulePath, fileName);
  }
  const moduleName = fileName.replace(/\/|\\/g, ".").replace(/^[^a-zA-Z_$]/, "_").replace(/[^a-zA-Z0-9._$]/g, "_");
  return moduleName;
}

// src/tsickle/clutz.ts
var ts6 = __toESM(require("typescript"));

// src/tsickle/goog-module.ts
var ts4 = __toESM(require("typescript"));

// src/tsickle/transformer-util.ts
var ts3 = __toESM(require("typescript"));
function hasModifierFlag(declaration, flag) {
  return (ts3.getCombinedModifierFlags(declaration) & flag) !== 0;
}
function isAmbient(node) {
  let current = node;
  while (current) {
    if (hasModifierFlag(current, ts3.ModifierFlags.Ambient)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
function isDtsFileName(fileName) {
  return fileName.endsWith(".d.ts");
}
function getIdentifierText(identifier) {
  return unescapeName(identifier.escapedText);
}
function symbolIsValue(tc, sym) {
  if (sym.flags & ts3.SymbolFlags.Alias)
    sym = tc.getAliasedSymbol(sym);
  return (sym.flags & ts3.SymbolFlags.Value) !== 0;
}
function getEntityNameText(name) {
  if (ts3.isIdentifier(name)) {
    return getIdentifierText(name);
  }
  return getEntityNameText(name.left) + "." + getIdentifierText(name.right);
}
function unescapeName(name) {
  const str = name;
  if (str.startsWith("___"))
    return str.substring(1);
  return str;
}
function createNotEmittedStatementWithComments(sourceFile, original) {
  let replacement = ts3.factory.createNotEmittedStatement(original);
  const leading = ts3.getLeadingCommentRanges(sourceFile.text, original.pos) || [];
  const trailing = ts3.getTrailingCommentRanges(sourceFile.text, original.end) || [];
  replacement = ts3.setSyntheticLeadingComments(replacement, synthesizeCommentRanges(sourceFile, leading));
  replacement = ts3.setSyntheticTrailingComments(replacement, synthesizeCommentRanges(sourceFile, trailing));
  return replacement;
}
function synthesizeCommentRanges(sourceFile, parsedComments) {
  const synthesizedComments = [];
  parsedComments.forEach(({ end, hasTrailingNewLine, kind, pos }) => {
    let commentText = sourceFile.text.substring(pos, end).trim();
    if (kind === ts3.SyntaxKind.MultiLineCommentTrivia) {
      commentText = commentText.replace(/(^\/\*)|(\*\/$)/g, "");
    } else if (kind === ts3.SyntaxKind.SingleLineCommentTrivia) {
      if (commentText.startsWith("///")) {
        return;
      }
      commentText = commentText.replace(/(^\/\/)/g, "");
    }
    synthesizedComments.push({
      end: -1,
      hasTrailingNewLine,
      kind,
      pos: -1,
      text: commentText
    });
  });
  return synthesizedComments;
}
function visitEachChild2(node, visitor, context) {
  if (node.kind === ts3.SyntaxKind.SourceFile) {
    const sf = node;
    return updateSourceFileNode(sf, ts3.visitLexicalEnvironment(sf.statements, visitor, context));
  }
  return ts3.visitEachChild(node, visitor, context);
}
function updateSourceFileNode(sf, statements) {
  if (statements === sf.statements) {
    return sf;
  }
  sf = ts3.factory.updateSourceFile(sf, ts3.setTextRange(statements, sf.statements), sf.isDeclarationFile, sf.referencedFiles, sf.typeReferenceDirectives, sf.hasNoDefaultLib, sf.libReferenceDirectives);
  return sf;
}
function createSingleQuoteStringLiteral(text) {
  const stringLiteral = ts3.factory.createStringLiteral(text);
  stringLiteral["singleQuote"] = true;
  return stringLiteral;
}
function createSingleLineComment(original, text) {
  const comment = {
    end: -1,
    hasTrailingNewLine: true,
    kind: ts3.SyntaxKind.SingleLineCommentTrivia,
    pos: -1,
    text: " " + text
  };
  return ts3.setSyntheticTrailingComments(ts3.factory.createNotEmittedStatement(original), [comment]);
}
function createMultiLineComment(original, text) {
  const comment = {
    end: -1,
    hasTrailingNewLine: true,
    kind: ts3.SyntaxKind.MultiLineCommentTrivia,
    pos: -1,
    text: " " + text
  };
  return ts3.setSyntheticTrailingComments(ts3.factory.createNotEmittedStatement(original), [comment]);
}
function reportDebugWarning(host, node, messageText) {
  if (!host.logWarning)
    return;
  host.logWarning(createDiagnostic(node, messageText, undefined, ts3.DiagnosticCategory.Warning));
}
function reportDiagnostic(diagnostics, node, messageText, textRange, category = ts3.DiagnosticCategory.Error) {
  diagnostics.push(createDiagnostic(node, messageText, textRange, category));
}
function createDiagnostic(node, messageText, textRange, category) {
  let start;
  let length;
  node = ts3.getOriginalNode(node);
  if (textRange) {
    start = textRange.pos;
    length = textRange.end - textRange.pos;
  } else if (node) {
    start = node.pos >= 0 ? node.getStart() : 0;
    length = node.end - node.pos;
  }
  return {
    category,
    code: 0,
    file: node?.getSourceFile(),
    length,
    messageText,
    start
  };
}
function getAllLeadingComments(node) {
  const allRanges = [];
  const nodeText = node.getFullText();
  const cr = ts3.getLeadingCommentRanges(nodeText, 0);
  if (cr)
    allRanges.push(...cr.map((c) => ({ ...c, text: nodeText.substring(c.pos, c.end) })));
  const synthetic = ts3.getSyntheticLeadingComments(node);
  if (synthetic)
    allRanges.push(...synthetic);
  return allRanges;
}
function createGoogCall(methodName, literal) {
  return ts3.factory.createCallExpression(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("goog"), methodName), undefined, [literal]);
}
function getGoogFunctionName(call) {
  if (!ts3.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const propAccess = call.expression;
  if (!ts3.isIdentifier(propAccess.expression) || propAccess.expression.escapedText !== "goog") {
    return null;
  }
  return propAccess.name.text;
}
function isGoogCallExpressionOf(n, fnName) {
  return ts3.isCallExpression(n) && getGoogFunctionName(n) === fnName;
}
function isAnyTsmesCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationExportsShim") || isGoogCallExpressionOf(n, "tsMigrationDefaultExportsShim") || isGoogCallExpressionOf(n, "tsMigrationNamedExportsShim");
}
function isTsmesShorthandCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationDefaultExportsShim") || isGoogCallExpressionOf(n, "tsMigrationNamedExportsShim");
}
function isTsmesDeclareLegacyNamespaceCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationExportsShimDeclareLegacyNamespace");
}
function createGoogLoadedModulesRegistration(moduleId, exports2) {
  return ts3.factory.createExpressionStatement(ts3.factory.createAssignment(ts3.factory.createElementAccessExpression(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("goog"), ts3.factory.createIdentifier("loadedModules_")), createSingleQuoteStringLiteral(moduleId)), ts3.factory.createObjectLiteralExpression([
    ts3.factory.createPropertyAssignment("exports", exports2),
    ts3.factory.createPropertyAssignment("type", ts3.factory.createPropertyAccessExpression(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("goog"), ts3.factory.createIdentifier("ModuleType")), ts3.factory.createIdentifier("GOOG"))),
    ts3.factory.createPropertyAssignment("moduleId", createSingleQuoteStringLiteral(moduleId))
  ])));
}
function isMergedDeclaration(decl) {
  return decl.isMergedDecl === true;
}
function markAsMergedDeclaration(decl) {
  decl.isMergedDecl = true;
}
function getTransformedNs(node) {
  node = ts3.getOriginalNode(node);
  let parent = node.parent;
  while (parent) {
    if (ts3.isModuleDeclaration(parent) && isMergedDeclaration(parent)) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}
function nodeIsInTransformedNs(node) {
  return getTransformedNs(node) !== null;
}
function getPreviousDeclaration(sym, thisDecl) {
  if (!sym.declarations)
    return null;
  const sf = thisDecl.getSourceFile();
  for (const decl of sym.declarations) {
    if (!isAmbient(decl) && decl.getSourceFile() === sf && decl.pos < thisDecl.pos) {
      return decl;
    }
  }
  return null;
}

// src/tsickle/goog-module.ts
function jsPathToNamespace(host, context, diagnostics, importPath, getModuleSymbol) {
  const namespace = localJsPathToNamespace(host, context, diagnostics, importPath);
  if (namespace)
    return namespace;
  const moduleSymbol = getModuleSymbol();
  if (!moduleSymbol)
    return;
  return getGoogNamespaceFromClutzComments(context, diagnostics, importPath, moduleSymbol);
}
function localJsPathToNamespace(host, context, diagnostics, importPath) {
  if (importPath.match(/^goog:/)) {
    return importPath.substring("goog:".length);
  }
  if (host.jsPathToModuleName) {
    const module2 = host.jsPathToModuleName(importPath);
    if (!module2)
      return;
    if (module2.multipleProvides) {
      reportMultipleProvidesError(context, diagnostics, importPath);
    }
    return module2.name;
  }
  return;
}
function jsPathToStripProperty(host, importPath, getModuleSymbol) {
  if (host.jsPathToStripProperty) {
    return host.jsPathToStripProperty(importPath);
  }
  const moduleSymbol = getModuleSymbol();
  if (!moduleSymbol)
    return;
  const stripDefaultNameSymbol = findLocalInDeclarations(moduleSymbol, "__clutz_strip_property");
  if (!stripDefaultNameSymbol)
    return;
  return literalTypeOfSymbol(stripDefaultNameSymbol);
}
function isPropertyAccess(node, parent, child) {
  if (!ts4.isPropertyAccessExpression(node))
    return false;
  return ts4.isIdentifier(node.expression) && node.expression.escapedText === parent && node.name.escapedText === child;
}
function isUseStrict(node) {
  if (node.kind !== ts4.SyntaxKind.ExpressionStatement)
    return false;
  const exprStmt = node;
  const expr = exprStmt.expression;
  if (expr.kind !== ts4.SyntaxKind.StringLiteral)
    return false;
  const literal = expr;
  return literal.text === "use strict";
}
function isEsModuleProperty(stmt) {
  const expr = stmt.expression;
  if (!ts4.isCallExpression(expr))
    return false;
  if (!isPropertyAccess(expr.expression, "Object", "defineProperty")) {
    return false;
  }
  if (expr.arguments.length !== 3)
    return false;
  const [exp, esM, val] = expr.arguments;
  if (!ts4.isIdentifier(exp) || exp.escapedText !== "exports")
    return false;
  if (!ts4.isStringLiteral(esM) || esM.text !== "__esModule")
    return false;
  if (!ts4.isObjectLiteralExpression(val) || val.properties.length !== 1) {
    return false;
  }
  const prop = val.properties[0];
  if (!ts4.isPropertyAssignment(prop))
    return false;
  const ident = prop.name;
  if (!ident || !ts4.isIdentifier(ident) || ident.text !== "value")
    return false;
  return prop.initializer.kind === ts4.SyntaxKind.TrueKeyword;
}
function checkExportsVoid0Assignment(expr) {
  if (!ts4.isBinaryExpression(expr))
    return false;
  if (expr.operatorToken.kind !== ts4.SyntaxKind.EqualsToken)
    return false;
  if (!ts4.isPropertyAccessExpression(expr.left))
    return false;
  if (!ts4.isIdentifier(expr.left.expression))
    return false;
  if (expr.left.expression.escapedText !== "exports")
    return false;
  if (ts4.isBinaryExpression(expr.right)) {
    return checkExportsVoid0Assignment(expr.right);
  }
  if (!ts4.isVoidExpression(expr.right))
    return false;
  if (!ts4.isNumericLiteral(expr.right.expression))
    return false;
  if (expr.right.expression.text !== "0")
    return false;
  return true;
}
function extractRequire(call) {
  if (call.expression.kind !== ts4.SyntaxKind.Identifier)
    return null;
  const ident = call.expression;
  if (ident.escapedText !== "require")
    return null;
  if (call.arguments.length !== 1)
    return null;
  const arg = call.arguments[0];
  if (arg.kind !== ts4.SyntaxKind.StringLiteral)
    return null;
  return arg;
}
function findLocalInDeclarations(symbol, name) {
  if (!symbol.declarations) {
    return;
  }
  for (const decl of symbol.declarations) {
    const internalDecl = decl;
    const locals = internalDecl.locals;
    if (!locals)
      continue;
    const sym = locals.get(ts4.escapeLeadingUnderscores(name));
    if (sym)
      return sym;
  }
  return;
}
function literalTypeOfSymbol(symbol) {
  if (!symbol.declarations || symbol.declarations.length === 0) {
    return;
  }
  const varDecl = symbol.declarations[0];
  if (!ts4.isVariableDeclaration(varDecl))
    return;
  if (!varDecl.type || !ts4.isLiteralTypeNode(varDecl.type))
    return;
  const literal = varDecl.type.literal;
  if (ts4.isLiteralExpression(literal))
    return literal.text;
  if (literal.kind === ts4.SyntaxKind.TrueKeyword)
    return true;
  if (literal.kind === ts4.SyntaxKind.FalseKeyword)
    return false;
  return;
}
function getOriginalGoogModuleFromComment(sf) {
  const leadingComments = sf.getFullText().substring(sf.getFullStart(), sf.getLeadingTriviaWidth());
  const match = /^\/\/ Original goog.module name: (.*)$/m.exec(leadingComments);
  if (match) {
    return match[1];
  }
  return;
}
function getGoogNamespaceFromClutzComments(context, tsickleDiagnostics, tsImport, moduleSymbol) {
  if (moduleSymbol.valueDeclaration && ts4.isSourceFile(moduleSymbol.valueDeclaration)) {
    return getOriginalGoogModuleFromComment(moduleSymbol.valueDeclaration);
  }
  const actualNamespaceSymbol = findLocalInDeclarations(moduleSymbol, "__clutz_actual_namespace");
  if (!actualNamespaceSymbol)
    return;
  const hasMultipleProvides = findLocalInDeclarations(moduleSymbol, "__clutz_multiple_provides");
  if (hasMultipleProvides) {
    reportMultipleProvidesError(context, tsickleDiagnostics, tsImport);
  }
  const actualNamespace = literalTypeOfSymbol(actualNamespaceSymbol);
  if (actualNamespace === undefined || typeof actualNamespace !== "string") {
    reportDiagnostic(tsickleDiagnostics, context, `referenced module's __clutz_actual_namespace not a variable with a string literal type`);
    return;
  }
  return actualNamespace;
}
function reportMultipleProvidesError(context, diagnostics, importPath) {
  reportDiagnostic(diagnostics, context, `referenced JavaScript module ${importPath} provides multiple namespaces and cannot be imported by path.`);
}
function importPathToGoogNamespace(host, context, diagnostics, file, tsImport, getModuleSymbol) {
  const nsImport = jsPathToNamespace(host, context, diagnostics, tsImport, getModuleSymbol);
  if (nsImport != null) {
    return nsImport;
  }
  return host.pathToModuleName(file.fileName, tsImport);
}
function rewriteModuleExportsAssignment(expr) {
  if (!ts4.isBinaryExpression(expr.expression))
    return null;
  if (expr.expression.operatorToken.kind !== ts4.SyntaxKind.EqualsToken) {
    return null;
  }
  if (!isPropertyAccess(expr.expression.left, "module", "exports"))
    return null;
  return ts4.setOriginalNode(ts4.setTextRange(ts4.factory.createExpressionStatement(ts4.factory.createAssignment(ts4.factory.createIdentifier("exports"), expr.expression.right)), expr), expr);
}
function rewriteCommaExpressions(expr) {
  const isBinaryCommaExpression = (expr2) => ts4.isBinaryExpression(expr2) && expr2.operatorToken.kind === ts4.SyntaxKind.CommaToken;
  const isCommaList = (expr2) => expr2.kind === ts4.SyntaxKind.CommaListExpression;
  if (!isBinaryCommaExpression(expr) && !isCommaList(expr)) {
    return null;
  }
  return visit(expr);
  function visit(expr2) {
    if (isBinaryCommaExpression(expr2)) {
      return visit(expr2.left).concat(visit(expr2.right));
    }
    if (isCommaList(expr2)) {
      return [].concat(...expr2.elements.map(visit));
    }
    return [
      ts4.setOriginalNode(ts4.factory.createExpressionStatement(expr2), expr2)
    ];
  }
}
function getAmbientModuleSymbol(typeChecker, moduleUrl) {
  let moduleSymbol = typeChecker.getSymbolAtLocation(moduleUrl);
  if (!moduleSymbol) {
    const t = moduleUrl.text;
    moduleSymbol = typeChecker.tryFindAmbientModuleWithoutAugmentations(t);
  }
  return moduleSymbol;
}
function getExportedDeclarations(sourceFile, typeChecker) {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol)
    return [];
  const exportSymbols = typeChecker.getExportsOfModule(moduleSymbol);
  const result = [];
  for (const exportSymbol of exportSymbols) {
    const declarationSymbol = exportSymbol.flags & ts4.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(exportSymbol) : exportSymbol;
    const declarationFile = declarationSymbol.valueDeclaration?.getSourceFile();
    if (declarationFile?.fileName !== sourceFile.fileName)
      continue;
    result.push({
      declarationSymbol,
      exportName: exportSymbol.name
    });
  }
  return result;
}
function isClassDecorated(node) {
  if (hasDecorator(node))
    return true;
  const ctor = getFirstConstructorWithBody(node);
  if (!ctor)
    return false;
  return ctor.parameters.some((p) => hasDecorator(p));
}
function getFirstConstructorWithBody(node) {
  return node.members.find((member) => ts4.isConstructorDeclaration(member) && !!member.body);
}
function hasDecorator(node) {
  const decorators = ts4.getDecorators(node);
  return !!decorators && decorators.length > 0;
}
function commonJsToGoogmoduleTransformer(host, modulesManifest, typeChecker) {
  return (context) => {
    const previousOnSubstituteNode = context.onSubstituteNode;
    context.enableSubstitution(ts4.SyntaxKind.PropertyAccessExpression);
    context.onSubstituteNode = (hint, node) => {
      node = previousOnSubstituteNode(hint, node);
      if (!ts4.isPropertyAccessExpression(node))
        return node;
      if (!ts4.isIdentifier(node.expression))
        return node;
      const orig = ts4.getOriginalNode(node.expression);
      let importExportDecl;
      if (ts4.isImportDeclaration(orig) || ts4.isExportDeclaration(orig)) {
        importExportDecl = orig;
      } else {
        const sym = typeChecker.getSymbolAtLocation(node.expression);
        if (!sym)
          return node;
        const decls = sym.getDeclarations();
        if (!decls || !decls.length)
          return node;
        const decl = decls[0];
        if (decl.parent && decl.parent.parent && ts4.isImportDeclaration(decl.parent.parent)) {
          importExportDecl = decl.parent.parent;
        } else {
          return node;
        }
      }
      if (!importExportDecl.moduleSpecifier)
        return node;
      const isDefaultAccess = node.name.text === "default";
      const moduleSpecifier = importExportDecl.moduleSpecifier;
      if (isDefaultAccess && moduleSpecifier.text.startsWith("goog:")) {
        return node.expression;
      }
      const stripPropertyName = jsPathToStripProperty(host, moduleSpecifier.text, () => getAmbientModuleSymbol(typeChecker, moduleSpecifier));
      if (!stripPropertyName)
        return node;
      if (stripPropertyName === node.name.text)
        return node.expression;
      return node;
    };
    return (sf) => {
      if (sf["kind"] !== ts4.SyntaxKind.SourceFile)
        return sf;
      const exportedDeclarations = getExportedDeclarations(sf, typeChecker);
      let moduleVarCounter = 1;
      function nextModuleVar() {
        return `tsickle_module_${moduleVarCounter++}_`;
      }
      const namespaceToModuleVarName = new Map;
      function maybeCreateGoogRequire(original, call, newIdent) {
        const importedUrl = extractRequire(call);
        if (!importedUrl)
          return null;
        const ignoredDiagnostics = [];
        const imp = importPathToGoogNamespace(host, importedUrl, ignoredDiagnostics, sf, importedUrl.text, () => getAmbientModuleSymbol(typeChecker, importedUrl));
        modulesManifest.addReferencedModule(sf.fileName, imp);
        const existingImport = namespaceToModuleVarName.get(imp);
        let initializer;
        if (!existingImport) {
          if (newIdent)
            namespaceToModuleVarName.set(imp, newIdent);
          initializer = createGoogCall("require", createSingleQuoteStringLiteral(imp));
        } else {
          initializer = existingImport;
        }
        if (newIdent && newIdent.escapedText === "goog" && imp === "google3.javascript.closure.goog") {
          return createNotEmittedStatementWithComments(sf, original);
        }
        const useConst = host.options.target !== ts4.ScriptTarget.ES5;
        if (newIdent) {
          const varDecl = ts4.factory.createVariableDeclaration(newIdent, undefined, undefined, initializer);
          const newStmt = ts4.factory.createVariableStatement(undefined, ts4.factory.createVariableDeclarationList([varDecl], useConst ? ts4.NodeFlags.Const : undefined));
          return ts4.setOriginalNode(ts4.setTextRange(newStmt, original), original);
        } else if (!newIdent && !existingImport) {
          const newStmt = ts4.factory.createExpressionStatement(initializer);
          return ts4.setOriginalNode(ts4.setTextRange(newStmt, original), original);
        }
        return createNotEmittedStatementWithComments(sf, original);
      }
      function maybeRewriteDeclareModuleId(original, call) {
        if (!ts4.isPropertyAccessExpression(call.expression)) {
          return null;
        }
        const propAccess = call.expression;
        if (propAccess.name.escapedText !== "declareModuleId") {
          return null;
        }
        if (!ts4.isIdentifier(propAccess.expression) || propAccess.expression.escapedText !== "goog") {
          return null;
        }
        if (call.arguments.length !== 1) {
          return null;
        }
        const arg = call.arguments[0];
        if (!ts4.isStringLiteral(arg)) {
          return null;
        }
        const newStmt = createGoogLoadedModulesRegistration(arg.text, ts4.factory.createIdentifier("exports"));
        return ts4.setOriginalNode(ts4.setTextRange(newStmt, original), original);
      }
      function maybeRewriteDecoratedClassChainInitializer(stmt, decl) {
        const originalNode = ts4.getOriginalNode(stmt);
        if (!originalNode || !ts4.isClassDeclaration(originalNode) || !isClassDecorated(originalNode)) {
          return null;
        }
        if (!ts4.isIdentifier(decl.name) || !decl.initializer || !ts4.isBinaryExpression(decl.initializer) || decl.initializer.operatorToken.kind !== ts4.SyntaxKind.EqualsToken || !ts4.isPropertyAccessExpression(decl.initializer.left) || !ts4.isIdentifier(decl.initializer.left.expression) || decl.initializer.left.expression.text !== "exports") {
          return null;
        }
        const updatedDecl = ts4.factory.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, decl.initializer.right);
        const newStmt = ts4.factory.updateVariableStatement(stmt, stmt.modifiers, ts4.factory.updateVariableDeclarationList(stmt.declarationList, [
          updatedDecl
        ]));
        return {
          exports: [
            ts4.factory.createExpressionStatement(ts4.factory.createAssignment(decl.initializer.left, decl.name))
          ],
          statement: newStmt
        };
      }
      function isExportsAssignmentForDecoratedClass(stmt) {
        if (!ts4.isBinaryExpression(stmt.expression) || stmt.expression.operatorToken.kind !== ts4.SyntaxKind.EqualsToken || !ts4.isPropertyAccessExpression(stmt.expression.left) || !ts4.isIdentifier(stmt.expression.left.expression) || stmt.expression.left.expression.escapedText !== "exports" || !ts4.isIdentifier(stmt.expression.right)) {
          return false;
        }
        if (ts4.isVariableStatement(ts4.getOriginalNode(stmt)))
          return false;
        const nameSymbol = typeChecker.getSymbolAtLocation(stmt.expression.right);
        if (!nameSymbol || !nameSymbol.valueDeclaration)
          return false;
        return ts4.isClassDeclaration(nameSymbol.valueDeclaration) && isClassDecorated(nameSymbol.valueDeclaration);
      }
      function maybeRewriteDecoratedClassDecorateCall(stmt) {
        if (!ts4.isBinaryExpression(stmt.expression) || stmt.expression.operatorToken.kind !== ts4.SyntaxKind.EqualsToken || !ts4.isIdentifier(stmt.expression.left)) {
          return null;
        }
        const originalNode = ts4.getOriginalNode(stmt);
        if (!ts4.isClassDeclaration(originalNode) || !isClassDecorated(originalNode)) {
          return null;
        }
        ts4.setEmitFlags(stmt.expression, ts4.EmitFlags.NoSubstitution);
        return stmt;
      }
      function maybeRewriteExportsAssignmentInIifeArguments(stmt) {
        if (!ts4.isCallExpression(stmt.expression))
          return null;
        const call = stmt.expression;
        if (!ts4.isParenthesizedExpression(call.expression) || !ts4.isFunctionExpression(call.expression.expression) || call.arguments.length !== 1) {
          return null;
        }
        const arg = call.arguments[0];
        if (!ts4.isBinaryExpression(arg) || !ts4.isIdentifier(arg.left) || arg.operatorToken.kind !== ts4.SyntaxKind.BarBarToken || !ts4.isParenthesizedExpression(arg.right) || !ts4.isBinaryExpression(arg.right.expression) || arg.right.expression.operatorToken.kind !== ts4.SyntaxKind.EqualsToken || !ts4.isIdentifier(arg.right.expression.left) || !ts4.isObjectLiteralExpression(arg.right.expression.right)) {
          return null;
        }
        const name = arg.right.expression.left;
        const nameSymbol = typeChecker.getSymbolAtLocation(name);
        const matchingExports = exportedDeclarations.filter((decl) => decl.declarationSymbol === nameSymbol);
        if (matchingExports.length === 0)
          return null;
        ts4.setEmitFlags(arg.right.expression, ts4.EmitFlags.NoSubstitution);
        const notAlreadyExported = matchingExports.filter((decl) => !ts4.isClassDeclaration(decl.declarationSymbol.valueDeclaration) && !ts4.isFunctionDeclaration(decl.declarationSymbol.valueDeclaration) && !(host.transformTypesToClosure && ts4.isEnumDeclaration(decl.declarationSymbol.valueDeclaration)));
        const exportNames = notAlreadyExported.map((decl) => decl.exportName);
        return {
          exports: exportNames.map((exportName) => ts4.factory.createExpressionStatement(ts4.factory.createAssignment(ts4.factory.createPropertyAccessExpression(ts4.factory.createIdentifier("exports"), ts4.factory.createIdentifier(exportName)), name))),
          statement: stmt
        };
      }
      function maybeRewriteExportStarAsNs(stmt) {
        if (!ts4.isExpressionStatement(stmt))
          return null;
        if (!ts4.isBinaryExpression(stmt.expression))
          return null;
        if (stmt.expression.operatorToken.kind !== ts4.SyntaxKind.EqualsToken) {
          return null;
        }
        if (!ts4.isPropertyAccessExpression(stmt.expression.left))
          return null;
        if (!ts4.isIdentifier(stmt.expression.left.expression))
          return null;
        if (stmt.expression.left.expression.escapedText !== "exports") {
          return null;
        }
        if (!ts4.isCallExpression(stmt.expression.right))
          return null;
        const ident = ts4.factory.createIdentifier(nextModuleVar());
        const require2 = maybeCreateGoogRequire(stmt, stmt.expression.right, ident);
        if (!require2)
          return null;
        const exportedName = stmt.expression.left.name;
        const exportStmt = ts4.setOriginalNode(ts4.setTextRange(ts4.factory.createExpressionStatement(ts4.factory.createAssignment(ts4.factory.createPropertyAccessExpression(ts4.factory.createIdentifier("exports"), exportedName), ident)), stmt), stmt);
        ts4.addSyntheticLeadingComment(exportStmt, ts4.SyntaxKind.MultiLineCommentTrivia, "* @const ", true);
        return [require2, exportStmt];
      }
      function rewriteObjectDefinePropertyOnExports(stmt) {
        if (!ts4.isCallExpression(stmt.expression))
          return null;
        const callExpr = stmt.expression;
        if (!ts4.isPropertyAccessExpression(callExpr.expression))
          return null;
        const propAccess = callExpr.expression;
        if (!ts4.isIdentifier(propAccess.expression))
          return null;
        if (propAccess.expression.text !== "Object")
          return null;
        if (propAccess.name.text !== "defineProperty")
          return null;
        if (callExpr.arguments.length !== 3)
          return null;
        const [objDefArg1, objDefArg2, objDefArg3] = callExpr.arguments;
        if (!ts4.isIdentifier(objDefArg1))
          return null;
        if (objDefArg1.text !== "exports")
          return null;
        if (!ts4.isStringLiteral(objDefArg2))
          return null;
        if (!ts4.isObjectLiteralExpression(objDefArg3))
          return null;
        function findPropNamed(name) {
          return (p) => {
            return ts4.isPropertyAssignment(p) && ts4.isIdentifier(p.name) && p.name.text === name;
          };
        }
        const enumerableConfig = objDefArg3.properties.find(findPropNamed("enumerable"));
        if (!enumerableConfig)
          return null;
        if (!ts4.isPropertyAssignment(enumerableConfig))
          return null;
        if (enumerableConfig.initializer.kind !== ts4.SyntaxKind.TrueKeyword) {
          return null;
        }
        const getConfig = objDefArg3.properties.find(findPropNamed("get"));
        if (!getConfig)
          return null;
        if (!ts4.isPropertyAssignment(getConfig))
          return null;
        if (!ts4.isFunctionExpression(getConfig.initializer))
          return null;
        const getterFunc = getConfig.initializer;
        if (getterFunc.body.statements.length !== 1)
          return null;
        const getterReturn = getterFunc.body.statements[0];
        if (!ts4.isReturnStatement(getterReturn))
          return null;
        const realExportValue = getterReturn.expression;
        if (!realExportValue)
          return null;
        const exportStmt = ts4.setOriginalNode(ts4.setTextRange(ts4.factory.createExpressionStatement(ts4.factory.createAssignment(ts4.factory.createPropertyAccessExpression(ts4.factory.createIdentifier("exports"), objDefArg2.text), realExportValue)), stmt), stmt);
        return exportStmt;
      }
      const seenNamespaceOrEnumExports = new Set;
      const delayedDecoratedClassExports = new Map;
      function visitTopLevelStatement(stmts2, sf2, node) {
        switch (node.kind) {
          case ts4.SyntaxKind.ExpressionStatement: {
            const exprStmt = node;
            if (isUseStrict(exprStmt) || isEsModuleProperty(exprStmt)) {
              stmts2.push(createNotEmittedStatementWithComments(sf2, exprStmt));
              return;
            }
            if (checkExportsVoid0Assignment(exprStmt.expression)) {
              stmts2.push(createNotEmittedStatementWithComments(sf2, exprStmt));
              return;
            }
            const modExports = rewriteModuleExportsAssignment(exprStmt);
            if (modExports) {
              stmts2.push(modExports);
              return;
            }
            const commaExpanded = rewriteCommaExpressions(exprStmt.expression);
            if (commaExpanded) {
              stmts2.push(...commaExpanded);
              return;
            }
            const exportStarAsNs = maybeRewriteExportStarAsNs(exprStmt);
            if (exportStarAsNs) {
              stmts2.push(...exportStarAsNs);
              return;
            }
            const exportFromObjDefProp = rewriteObjectDefinePropertyOnExports(exprStmt);
            if (exportFromObjDefProp) {
              stmts2.push(exportFromObjDefProp);
              return;
            }
            const exportInIifeArguments = maybeRewriteExportsAssignmentInIifeArguments(exprStmt);
            if (exportInIifeArguments) {
              stmts2.push(exportInIifeArguments.statement);
              for (const newExport of exportInIifeArguments.exports) {
                const exportName = newExport.expression.left.name.text;
                if (!seenNamespaceOrEnumExports.has(exportName)) {
                  stmts2.push(newExport);
                  seenNamespaceOrEnumExports.add(exportName);
                }
              }
              return;
            }
            if (isExportsAssignmentForDecoratedClass(exprStmt)) {
              delayedDecoratedClassExports.set(exprStmt.expression.left.name.text, exprStmt);
              return;
            }
            const newStmt = maybeRewriteDecoratedClassDecorateCall(exprStmt);
            if (newStmt) {
              stmts2.push(newStmt);
              return;
            }
            const expr = exprStmt.expression;
            if (!ts4.isCallExpression(expr))
              break;
            let callExpr = expr;
            const declaredModuleId = maybeRewriteDeclareModuleId(exprStmt, callExpr);
            if (declaredModuleId) {
              stmts2.push(declaredModuleId);
              return;
            }
            const isExportStar = ts4.isIdentifier(expr.expression) && (expr.expression.text === "__exportStar" || expr.expression.text === "__export");
            let newIdent;
            if (isExportStar) {
              callExpr = expr.arguments[0];
              newIdent = ts4.factory.createIdentifier(nextModuleVar());
            }
            const require2 = maybeCreateGoogRequire(exprStmt, callExpr, newIdent);
            if (!require2)
              break;
            stmts2.push(require2);
            if (isExportStar) {
              const args = [newIdent];
              if (expr.arguments.length > 1)
                args.push(expr.arguments[1]);
              stmts2.push(ts4.factory.createExpressionStatement(ts4.factory.createCallExpression(expr.expression, undefined, args)));
            }
            return;
          }
          case ts4.SyntaxKind.VariableStatement: {
            const varStmt = node;
            if (varStmt.declarationList.declarations.length !== 1)
              break;
            const decl = varStmt.declarationList.declarations[0];
            if (decl.name.kind !== ts4.SyntaxKind.Identifier)
              break;
            if (decl.initializer && ts4.isCallExpression(decl.initializer)) {
              const require2 = maybeCreateGoogRequire(varStmt, decl.initializer, decl.name);
              if (require2) {
                stmts2.push(require2);
                return;
              }
            }
            const declWithChainInitializer = maybeRewriteDecoratedClassChainInitializer(varStmt, decl);
            if (declWithChainInitializer) {
              stmts2.push(declWithChainInitializer.statement);
              for (const newExport of declWithChainInitializer.exports) {
                delayedDecoratedClassExports.set(newExport.expression.left.name.text, newExport);
              }
              return;
            }
            break;
          }
          default:
            break;
        }
        stmts2.push(node);
      }
      const moduleName = host.pathToModuleName("", sf.fileName);
      modulesManifest.addModule(sf.fileName, moduleName);
      function rewriteDynamicRequire(node) {
        if (!ts4.isCallExpression(node) || node.arguments.length !== 1) {
          return null;
        }
        let importedUrl = null;
        if (ts4.isArrowFunction(node.arguments[0]) && ts4.isCallExpression(node.arguments[0].body)) {
          importedUrl = extractRequire(node.arguments[0].body);
        }
        if (ts4.isFunctionExpression(node.arguments[0]) && ts4.isBlock(node.arguments[0].body) && node.arguments[0].body.statements.length === 1 && ts4.isReturnStatement(node.arguments[0].body.statements[0]) && node.arguments[0].body.statements[0].expression != null && ts4.isCallExpression(node.arguments[0].body.statements[0].expression)) {
          importedUrl = extractRequire(node.arguments[0].body.statements[0].expression);
        }
        if (!importedUrl) {
          return null;
        }
        const callee = node.expression;
        if (!ts4.isPropertyAccessExpression(callee) || callee.name.escapedText !== "then" || !ts4.isCallExpression(callee.expression)) {
          return null;
        }
        const resolveCall = callee.expression;
        if (resolveCall.arguments.length !== 0 || !ts4.isPropertyAccessExpression(resolveCall.expression) || !ts4.isIdentifier(resolveCall.expression.expression) || resolveCall.expression.expression.escapedText !== "Promise" || !ts4.isIdentifier(resolveCall.expression.name) || resolveCall.expression.name.escapedText !== "resolve") {
          return null;
        }
        const ignoredDiagnostics = [];
        const imp = importPathToGoogNamespace(host, importedUrl, ignoredDiagnostics, sf, importedUrl.text, () => getAmbientModuleSymbol(typeChecker, importedUrl));
        modulesManifest.addReferencedModule(sf.fileName, imp);
        return createGoogCall("requireDynamic", createSingleQuoteStringLiteral(imp));
      }
      const visitForDynamicImport = (node) => {
        const replacementNode = rewriteDynamicRequire(node);
        if (replacementNode) {
          return replacementNode;
        }
        return ts4.visitEachChild(node, visitForDynamicImport, context);
      };
      if (host.transformDynamicImport === "closure") {
        sf = ts4.visitNode(sf, visitForDynamicImport, ts4.isSourceFile);
      }
      const stmts = [];
      for (const stmt of sf.statements) {
        visitTopLevelStatement(stmts, sf, stmt);
      }
      stmts.push(...delayedDecoratedClassExports.values());
      const headerStmts = [];
      const googModule = ts4.factory.createExpressionStatement(createGoogCall("module", createSingleQuoteStringLiteral(moduleName)));
      headerStmts.push(googModule);
      maybeAddModuleId(host, typeChecker, sf, headerStmts);
      const resolvedModuleNames = [...namespaceToModuleVarName.keys()];
      const tslibModuleName = host.pathToModuleName(sf.fileName, "tslib");
      if (resolvedModuleNames.indexOf(tslibModuleName) === -1) {
        const tslibImport = ts4.factory.createExpressionStatement(createGoogCall("require", createSingleQuoteStringLiteral(tslibModuleName)));
        headerStmts.push(tslibImport);
      }
      const insertionIdx = stmts.findIndex((s) => s.kind !== ts4.SyntaxKind.NotEmittedStatement);
      if (insertionIdx === -1) {
        stmts.push(...headerStmts);
      } else {
        stmts.splice(insertionIdx, 0, ...headerStmts);
      }
      return ts4.factory.updateSourceFile(sf, ts4.setTextRange(ts4.factory.createNodeArray(stmts), sf.statements));
    };
  };
}
function maybeAddModuleId(host, typeChecker, sourceFile, headerStmts) {
  const moduleSymbol = typeChecker.getSymbolsInScope(sourceFile, ts4.SymbolFlags.ModuleMember).find((s) => s.name === "module");
  if (moduleSymbol) {
    const declaration = moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];
    if (sourceFile.fileName === declaration?.getSourceFile().fileName)
      return;
  }
  const moduleId = host.fileNameToModuleId(sourceFile.fileName);
  const moduleVarInitializer = ts4.factory.createBinaryExpression(ts4.factory.createIdentifier("module"), ts4.SyntaxKind.BarBarToken, ts4.factory.createObjectLiteralExpression([
    ts4.factory.createPropertyAssignment("id", createSingleQuoteStringLiteral(moduleId))
  ]));
  const modAssign = ts4.factory.createVariableStatement(undefined, ts4.factory.createVariableDeclarationList([
    ts4.factory.createVariableDeclaration("module", undefined, undefined, moduleVarInitializer)
  ]));
  headerStmts.push(modAssign);
}

// src/tsickle/type-translator.ts
var ts5 = __toESM(require("typescript"));

// src/tsickle/annotator-host.ts
function moduleNameAsIdentifier(host, fileName, context = "") {
  return host.pathToModuleName(context, fileName).replace(/\./g, "$");
}

// src/tsickle/type-translator.ts
function isValidClosurePropertyName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
function isDeclaredInBuiltinLibDTS(node) {
  const fileName = node?.getSourceFile().fileName;
  return !!fileName && fileName.match(/\blib\.(?:[^/]+\.)?d\.ts$/) != null;
}
function isDeclaredInClutzDts(node) {
  const sourceFile = node?.getSourceFile();
  if (!sourceFile)
    return false;
  const clutz1Header = "//!! generated by clutz.";
  const clutz2Header = "//!! generated by clutz2";
  return sourceFile.text.startsWith(clutz1Header) || sourceFile.text.startsWith(clutz2Header);
}
function typeValueConflictHandled(symbol) {
  return symbol.declarations != null && symbol.declarations.some((n) => isDeclaredInBuiltinLibDTS(n) || isDeclaredInClutzDts(n));
}
function typeToDebugString(type) {
  let debugString = `flags:0x${type.flags.toString(16)}`;
  if (type.aliasSymbol) {
    debugString += ` alias:${symbolToDebugString(type.aliasSymbol)}`;
  }
  if (type.aliasTypeArguments) {
    debugString += ` aliasArgs:<${type.aliasTypeArguments.map(typeToDebugString).join(",")}>`;
  }
  const basicTypes = [
    ts5.TypeFlags.Any,
    ts5.TypeFlags.String,
    ts5.TypeFlags.Number,
    ts5.TypeFlags.Boolean,
    ts5.TypeFlags.Enum,
    ts5.TypeFlags.StringLiteral,
    ts5.TypeFlags.NumberLiteral,
    ts5.TypeFlags.BooleanLiteral,
    ts5.TypeFlags.EnumLiteral,
    ts5.TypeFlags.BigIntLiteral,
    ts5.TypeFlags.ESSymbol,
    ts5.TypeFlags.UniqueESSymbol,
    ts5.TypeFlags.Void,
    ts5.TypeFlags.Undefined,
    ts5.TypeFlags.Null,
    ts5.TypeFlags.Never,
    ts5.TypeFlags.TypeParameter,
    ts5.TypeFlags.Object,
    ts5.TypeFlags.Union,
    ts5.TypeFlags.Intersection,
    ts5.TypeFlags.Index,
    ts5.TypeFlags.IndexedAccess,
    ts5.TypeFlags.Conditional,
    ts5.TypeFlags.Substitution
  ];
  for (const flag of basicTypes) {
    if ((type.flags & flag) !== 0) {
      debugString += ` ${ts5.TypeFlags[flag]}`;
    }
  }
  if (type.flags === ts5.TypeFlags.Object) {
    const objType = type;
    debugString += ` objectFlags:0x${objType.objectFlags.toString(16)}`;
    const objectFlags = [
      ts5.ObjectFlags.Class,
      ts5.ObjectFlags.Interface,
      ts5.ObjectFlags.Reference,
      ts5.ObjectFlags.Tuple,
      ts5.ObjectFlags.Anonymous,
      ts5.ObjectFlags.Mapped,
      ts5.ObjectFlags.Instantiated,
      ts5.ObjectFlags.ObjectLiteral,
      ts5.ObjectFlags.EvolvingArray,
      ts5.ObjectFlags.ObjectLiteralPatternWithComputedProperties
    ];
    for (const flag of objectFlags) {
      if ((objType.objectFlags & flag) !== 0) {
        debugString += ` object:${ts5.ObjectFlags[flag]}`;
      }
    }
  }
  if (type.symbol && type.symbol.name !== "__type") {
    debugString += ` symbol.name:${JSON.stringify(type.symbol.name)}`;
  }
  if (type.pattern) {
    debugString += ` destructuring:true`;
  }
  return `{type ${debugString}}`;
}
function symbolToDebugString(sym) {
  let debugString = `${JSON.stringify(sym.name)} flags:0x${sym.flags.toString(16)}`;
  const symbolFlags = [
    ts5.SymbolFlags.FunctionScopedVariable,
    ts5.SymbolFlags.BlockScopedVariable,
    ts5.SymbolFlags.Property,
    ts5.SymbolFlags.EnumMember,
    ts5.SymbolFlags.Function,
    ts5.SymbolFlags.Class,
    ts5.SymbolFlags.Interface,
    ts5.SymbolFlags.ConstEnum,
    ts5.SymbolFlags.RegularEnum,
    ts5.SymbolFlags.ValueModule,
    ts5.SymbolFlags.NamespaceModule,
    ts5.SymbolFlags.TypeLiteral,
    ts5.SymbolFlags.ObjectLiteral,
    ts5.SymbolFlags.Method,
    ts5.SymbolFlags.Constructor,
    ts5.SymbolFlags.GetAccessor,
    ts5.SymbolFlags.SetAccessor,
    ts5.SymbolFlags.Signature,
    ts5.SymbolFlags.TypeParameter,
    ts5.SymbolFlags.TypeAlias,
    ts5.SymbolFlags.ExportValue,
    ts5.SymbolFlags.Alias,
    ts5.SymbolFlags.Prototype,
    ts5.SymbolFlags.ExportStar,
    ts5.SymbolFlags.Optional,
    ts5.SymbolFlags.Transient
  ];
  for (const flag of symbolFlags) {
    if ((sym.flags & flag) !== 0) {
      debugString += ` ${ts5.SymbolFlags[flag]}`;
    }
  }
  return debugString;
}
function getContainingAmbientModuleDeclaration(declarations) {
  for (const declaration of declarations) {
    let parent = declaration.parent;
    while (parent) {
      if (ts5.isModuleDeclaration(parent) && ts5.isStringLiteral(parent.name)) {
        return parent;
      }
      parent = parent.parent;
    }
  }
  return null;
}
function isTopLevelExternal(declarations) {
  for (const declaration of declarations) {
    if (declaration.parent === undefined)
      continue;
    if (ts5.isSourceFile(declaration.parent) && ts5.isExternalModule(declaration.parent)) {
      return true;
    }
  }
  return false;
}
function isDeclaredInSameFile(a, b) {
  return ts5.getOriginalNode(a).getSourceFile() === ts5.getOriginalNode(b).getSourceFile();
}

class TypeTranslator {
  host;
  typeChecker;
  node;
  pathUnknownSymbolsSet;
  symbolsToAliasedNames;
  symbolToNameCache;
  ensureSymbolDeclared;
  seenTypes = [];
  dropFinalTypeArgument = false;
  isForExterns = false;
  useInternalNamespaceForExterns = false;
  constructor(host, typeChecker, node, pathUnknownSymbolsSet, symbolsToAliasedNames, symbolToNameCache, ensureSymbolDeclared = () => {}) {
    this.host = host;
    this.typeChecker = typeChecker;
    this.node = node;
    this.pathUnknownSymbolsSet = pathUnknownSymbolsSet;
    this.symbolsToAliasedNames = symbolsToAliasedNames;
    this.symbolToNameCache = symbolToNameCache;
    this.ensureSymbolDeclared = ensureSymbolDeclared;
    this.pathUnknownSymbolsSet = new Set(Array.from(this.pathUnknownSymbolsSet.values()).map((p) => normalize(p)));
  }
  convertParams(sig, paramDecls) {
    const paramTypes = [];
    for (let i = 0;i < sig.parameters.length; i++) {
      const param = sig.parameters[i];
      const paramDecl = paramDecls[i];
      const optional = !!paramDecl.questionToken || !!paramDecl.initializer;
      const varArgs = !!paramDecl.dotDotDotToken;
      const paramType = this.typeChecker.getTypeOfSymbolAtLocation(param, this.node);
      let typeStr;
      if (varArgs) {
        const argType = restParameterType(this.typeChecker, paramType);
        if (argType) {
          typeStr = "..." + this.translate(argType);
        } else {
          this.warn("unable to translate rest args type");
          typeStr = "...?";
        }
      } else {
        typeStr = this.translate(paramType);
      }
      if (optional)
        typeStr = typeStr + "=";
      paramTypes.push(typeStr);
    }
    return paramTypes;
  }
  signatureToClosure(sig) {
    if (!sig.declaration) {
      this.warn("signature without declaration");
      return "Function";
    }
    if (sig.declaration.kind === ts5.SyntaxKind.JSDocSignature) {
      this.warn("signature with JSDoc declaration");
      return "Function";
    }
    this.markTypeParameterAsUnknown(this.symbolsToAliasedNames, sig.declaration.typeParameters);
    let typeStr = `function(`;
    let paramDecls = sig.declaration.parameters || [];
    const maybeThisParam = paramDecls[0];
    if (maybeThisParam && maybeThisParam.name.getText() === "this") {
      if (maybeThisParam.type) {
        const thisType = this.typeChecker.getTypeAtLocation(maybeThisParam.type);
        typeStr += `this: (${this.translate(thisType)})`;
        if (paramDecls.length > 1)
          typeStr += ", ";
      } else {
        this.warn("this type without type");
      }
      paramDecls = paramDecls.slice(1);
    }
    const params = this.convertParams(sig, paramDecls);
    typeStr += `${params.join(", ")})`;
    const retType = this.translate(this.typeChecker.getReturnTypeOfSignature(sig));
    if (retType) {
      typeStr += `: ${retType}`;
    }
    return typeStr;
  }
  stripClutzNamespace(name) {
    if (name.startsWith("ಠ_ಠ.clutz."))
      return name.substring("ಠ_ಠ.clutz.".length);
    return name;
  }
  translateAnonymousType(type) {
    this.seenTypes.push(type);
    try {
      if (!type.symbol) {
        this.warn("anonymous type has no symbol");
        return "?";
      }
      if (type.symbol.flags & ts5.SymbolFlags.Function || type.symbol.flags & ts5.SymbolFlags.Method) {
        const sigs = this.typeChecker.getSignaturesOfType(type, ts5.SignatureKind.Call);
        if (sigs.length === 1) {
          return this.signatureToClosure(sigs[0]);
        }
        const declWithBody = type.symbol.declarations?.filter((d) => isFunctionLikeDeclaration(d) && d.body != null);
        if (declWithBody?.length === 1) {
          const sig = this.typeChecker.getSignatureFromDeclaration(declWithBody[0]);
          if (sig) {
            return this.signatureToClosure(sig);
          }
        }
        const translatedSignatures = sigs.map((sig) => {
          try {
            return this.signatureToClosure(sig);
          } catch {
            return;
          }
        }).filter((signature) => signature !== undefined);
        const uniqueSignatures = new Set(translatedSignatures);
        if (uniqueSignatures.size === 1) {
          return uniqueSignatures.values().next().value;
        }
        return "function(...*): ?";
      }
      let callable = false;
      let indexable = false;
      const fields = [];
      if (!type.symbol.members) {
        this.warn("anonymous type has no symbol");
        return "?";
      }
      const ctors = type.getConstructSignatures();
      if (ctors.length) {
        const decl = ctors[0].declaration;
        if (!decl) {
          this.warn("unhandled anonymous type with constructor signature but no declaration");
          return "?";
        }
        if (decl.kind === ts5.SyntaxKind.JSDocSignature) {
          this.warn("unhandled JSDoc based constructor signature");
          return "?";
        }
        this.markTypeParameterAsUnknown(this.symbolsToAliasedNames, decl.typeParameters);
        const params = this.convertParams(ctors[0], decl.parameters);
        const paramsStr = params.length ? ", " + params.join(", ") : "";
        const constructedType = this.translate(ctors[0].getReturnType());
        let constructedTypeStr = constructedType[0] === "!" ? constructedType.substring(1) : constructedType;
        if (constructedTypeStr === "*") {
          constructedTypeStr = "?";
        }
        return `function(new:${constructedTypeStr}${paramsStr})`;
      }
      for (const field of type.symbol.members.keys()) {
        const fieldName = ts5.unescapeLeadingUnderscores(field);
        switch (field) {
          case ts5.InternalSymbolName.Call:
            callable = true;
            break;
          case ts5.InternalSymbolName.Index:
            indexable = true;
            break;
          default:
            if (!isValidClosurePropertyName(fieldName)) {
              this.warn(`omitting inexpressible property name: ${field}`);
              continue;
            }
            const member = type.symbol.members.get(field);
            const memberType = this.translate(this.typeChecker.getTypeOfSymbolAtLocation(member, this.node));
            fields.push(`${fieldName}: ${memberType}`);
            break;
        }
      }
      if (fields.length === 0) {
        if (callable && !indexable) {
          const sigs = this.typeChecker.getSignaturesOfType(type, ts5.SignatureKind.Call);
          if (sigs.length === 1) {
            return this.signatureToClosure(sigs[0]);
          }
        } else if (indexable && !callable) {
          let keyType = "string";
          let valType = this.typeChecker.getIndexTypeOfType(type, ts5.IndexKind.String);
          if (!valType) {
            keyType = "number";
            valType = this.typeChecker.getIndexTypeOfType(type, ts5.IndexKind.Number);
          }
          if (!valType) {
            this.warn("unknown index key type");
            return `!Object<?,?>`;
          }
          return `!Object<${keyType},${this.translate(valType)}>`;
        } else if (!callable && !indexable) {
          return "*";
        }
      }
      if (!callable && !indexable) {
        return `{${fields.join(", ")}}`;
      }
      this.warn("unhandled anonymous type");
      return "?";
    } finally {
      this.seenTypes.pop();
    }
  }
  translateEnumLiteral(type) {
    const enumLiteralBaseType = this.typeChecker.getBaseTypeOfLiteralType(type);
    if (!enumLiteralBaseType.symbol) {
      this.warn(`EnumLiteralType without a symbol`);
      return "?";
    }
    let symbol = enumLiteralBaseType.symbol;
    if (enumLiteralBaseType === type) {
      const parent = symbol["parent"];
      if (!parent)
        return "?";
      symbol = parent;
    }
    const name = this.symbolToString(symbol);
    if (!name)
      return "?";
    return "!" + name;
  }
  translateObject(type) {
    if (type.symbol && this.isAlwaysUnknownSymbol(type.symbol))
      return "?";
    const translatedBuiltinAlias = this.translateBuiltinUtilityAlias(type);
    if (translatedBuiltinAlias) {
      return translatedBuiltinAlias;
    }
    if (type.objectFlags & ts5.ObjectFlags.Class) {
      if (!type.symbol) {
        this.warn("class has no symbol");
        return "?";
      }
      const name = this.symbolToString(type.symbol);
      if (!name) {
        return "?";
      }
      return "!" + name;
    } else if (type.objectFlags & ts5.ObjectFlags.Interface) {
      if (!type.symbol) {
        this.warn("interface has no symbol");
        return "?";
      }
      if (type.symbol.flags & ts5.SymbolFlags.Value) {
        if (!typeValueConflictHandled(type.symbol)) {
          this.warn(`type/symbol conflict for ${type.symbol.name}, using {?} for now`);
          return "?";
        }
      }
      return "!" + this.symbolToString(type.symbol);
    } else if (type.objectFlags & ts5.ObjectFlags.Reference) {
      const referenceType = type;
      if (referenceType.target.objectFlags & ts5.ObjectFlags.Tuple) {
        return "!Array<?>";
      }
      let typeStr = "";
      if (referenceType.target === referenceType) {
        throw new Error(`reference loop in ${typeToDebugString(referenceType)} ${referenceType.flags}`);
      }
      typeStr += this.translate(referenceType.target);
      if (typeStr === "?")
        return "?";
      let typeArgs = this.typeChecker.getTypeArguments(referenceType) ?? [];
      const outerTypeParameters = referenceType.target.outerTypeParameters;
      if (outerTypeParameters) {
        typeArgs = typeArgs.slice(outerTypeParameters.length);
      }
      if (this.dropFinalTypeArgument) {
        typeArgs = typeArgs.slice(0, typeArgs.length - 1);
      }
      const localTypeParameters = referenceType.target.localTypeParameters;
      const maxExpectedTypeArgs = (localTypeParameters?.length ?? 0) + 1;
      if (typeArgs.length > maxExpectedTypeArgs) {
        this.warn(`more type args (${typeArgs.length}) than expected (${maxExpectedTypeArgs})`);
      }
      if (localTypeParameters && typeArgs.length > 0) {
        typeArgs = typeArgs.slice(0, localTypeParameters.length);
        this.seenTypes.push(referenceType);
        const params = typeArgs.map((t) => this.translate(t));
        this.seenTypes.pop();
        typeStr += `<${params.join(", ")}>`;
      }
      return typeStr;
    } else if (type.objectFlags & ts5.ObjectFlags.Anonymous) {
      return this.translateAnonymousType(type);
    }
    this.warn(`unhandled type ${typeToDebugString(type)}`);
    return "?";
  }
  translateBuiltinUtilityAlias(type) {
    const aliasSymbol = type.aliasSymbol;
    if (!aliasSymbol || !isDeclaredInBuiltinLibDTS(aliasSymbol.declarations?.[0]) || !type.aliasTypeArguments) {
      return;
    }
    switch (aliasSymbol.escapedName.toString()) {
      case "Partial":
      case "Pick":
      case "Omit":
      case "Readonly":
      case "Required":
        return this.translate(type.aliasTypeArguments[0]);
      case "Record":
        return this.translateRecordAlias(type.aliasTypeArguments);
      default:
        return;
    }
  }
  translateRecordAlias(typeArguments) {
    if (typeArguments.length < 2) {
      return;
    }
    return `!Object<${this.translateRecordKeyType(typeArguments[0])},${this.translate(typeArguments[1])}>`;
  }
  translateRecordKeyType(type) {
    if (type.flags & ts5.TypeFlags.Union) {
      const unionType = type;
      const memberKeyTypes = new Set(unionType.types.map((member) => this.translateRecordKeyType(member)));
      return memberKeyTypes.size === 1 ? memberKeyTypes.values().next().value : "string";
    }
    if (type.flags & (ts5.TypeFlags.Number | ts5.TypeFlags.NumberLiteral | ts5.TypeFlags.Enum | ts5.TypeFlags.EnumLiteral)) {
      return "number";
    }
    return "string";
  }
  translateUnion(type) {
    return this.translateUnionMembers(type.types);
  }
  translateUnionMembers(types) {
    const parts = new Set(types.map((t) => this.translate(t)));
    if (parts.size === 1)
      return parts.values().next().value ?? "?";
    return `(${Array.from(parts.values()).join("|")})`;
  }
  isAlwaysUnknownSymbol(symbol) {
    return isAlwaysUnknownSymbol(this.pathUnknownSymbolsSet, symbol);
  }
  markTypeParameterAsUnknown(unknownSymbolsMap, decls) {
    if (!decls || !decls.length)
      return;
    for (const tpd of decls) {
      const sym = this.typeChecker.getSymbolAtLocation(tpd.name);
      if (!sym) {
        this.warn(`type parameter with no symbol`);
        continue;
      }
      unknownSymbolsMap.set(sym, "?");
    }
  }
  maybeGetMangledNamePrefix(symbol) {
    if (!symbol.declarations)
      return "";
    const declarations = symbol.declarations;
    let ambientModuleDeclaration = null;
    if (!isTopLevelExternal(declarations)) {
      ambientModuleDeclaration = getContainingAmbientModuleDeclaration(declarations);
      if (!ambientModuleDeclaration)
        return "";
    }
    if (!this.isForExterns && !declarations.every((d) => isDeclaredInSameFile(this.node, d) && isAmbient(d) && hasModifierFlag(d, ts5.ModifierFlags.Export))) {
      return "";
    }
    let fileName;
    let context;
    if (ambientModuleDeclaration) {
      fileName = ambientModuleDeclaration.name.text;
      context = ambientModuleDeclaration.getSourceFile().fileName;
    } else {
      fileName = ts5.getOriginalNode(declarations[0]).getSourceFile().fileName;
      context = "";
    }
    const mangled = moduleNameAsIdentifier(this.host, fileName, context);
    if (this.isForExterns && this.useInternalNamespaceForExterns && !ambientModuleDeclaration && isDeclaredInSameFile(this.node, declarations[0])) {
      return mangled + "_.";
    }
    return mangled + ".";
  }
  symbolToString(sym) {
    const cachedName = this.symbolToNameCache.get(sym);
    if (cachedName)
      return cachedName;
    if (!this.isForExterns && (sym.flags & ts5.SymbolFlags.TypeParameter) === 0) {
      this.ensureSymbolDeclared(sym);
    }
    const context = nodeIsInTransformedNs(this.node) ? this.node.getSourceFile() : this.node;
    const name = this.typeChecker.symbolToEntityName(sym, ts5.SymbolFlags.Type, context, ts5.NodeBuilderFlags.UseFullyQualifiedType | ts5.NodeBuilderFlags.UseOnlyExternalAliasing);
    if (!name)
      return;
    let str = "";
    const writeEntityWithSymbols = (name2) => {
      let identifier;
      if (ts5.isQualifiedName(name2)) {
        writeEntityWithSymbols(name2.left);
        str += ".";
        identifier = name2.right;
      } else {
        identifier = name2;
      }
      let symbol = identifier.symbol;
      if (symbol.flags & ts5.SymbolFlags.Alias) {
        symbol = this.typeChecker.getAliasedSymbol(symbol);
      }
      const alias = this.symbolsToAliasedNames.get(symbol);
      if (alias) {
        str = alias;
        return;
      }
      let text = getIdentifierText(identifier);
      if (str.length === 0) {
        const mangledPrefix = this.maybeGetMangledNamePrefix(symbol);
        text = mangledPrefix + text;
      }
      str += text;
    };
    writeEntityWithSymbols(name);
    str = this.stripClutzNamespace(str);
    this.symbolToNameCache.set(sym, str);
    return str;
  }
  translate(type) {
    if (type.flags === ts5.TypeFlags.NonPrimitive)
      return "!Object";
    if (type.flags === ts5.TypeFlags.TemplateLiteral)
      return "string";
    if (this.seenTypes.indexOf(type) !== -1)
      return "?";
    let isAmbient2 = false;
    let isInUnsupportedNamespace = false;
    let isModule = false;
    if (type.symbol) {
      for (const decl of type.symbol.declarations || []) {
        if (ts5.isExternalModule(decl.getSourceFile()))
          isModule = true;
        if (decl.getSourceFile().isDeclarationFile)
          isAmbient2 = true;
        let current = decl;
        while (current) {
          if (ts5.getCombinedModifierFlags(current) & ts5.ModifierFlags.Ambient)
            isAmbient2 = true;
          if (current.kind === ts5.SyntaxKind.ModuleDeclaration && !isMergedDeclaration(current)) {
            isInUnsupportedNamespace = true;
          }
          current = current.parent;
        }
      }
    }
    if (isInUnsupportedNamespace && !isAmbient2) {
      return "?";
    }
    if (this.isForExterns && isModule && !isAmbient2)
      return "?";
    const lastFlag = ts5.TypeFlags.StringMapping;
    const mask = (lastFlag << 1) - 1;
    switch (type.flags & mask) {
      case ts5.TypeFlags.Any:
        return "?";
      case ts5.TypeFlags.Unknown:
        return "*";
      case ts5.TypeFlags.String:
      case ts5.TypeFlags.StringLiteral:
      case ts5.TypeFlags.StringMapping:
        return "string";
      case ts5.TypeFlags.Number:
      case ts5.TypeFlags.NumberLiteral:
        return "number";
      case ts5.TypeFlags.BigInt:
      case ts5.TypeFlags.BigIntLiteral:
        return "bigint";
      case ts5.TypeFlags.Boolean:
      case ts5.TypeFlags.BooleanLiteral:
        return "boolean";
      case ts5.TypeFlags.Enum:
        if (!type.symbol) {
          this.warn(`EnumType without a symbol`);
          return "?";
        }
        if (type.symbol.flags & ts5.SymbolFlags.EnumMember) {
          return this.translateEnumLiteral(type);
        }
        return this.symbolToString(type.symbol) || "?";
      case ts5.TypeFlags.ESSymbol:
      case ts5.TypeFlags.UniqueESSymbol:
        return "symbol";
      case ts5.TypeFlags.Void:
        return "void";
      case ts5.TypeFlags.Undefined:
        return "undefined";
      case ts5.TypeFlags.Null:
        return "null";
      case ts5.TypeFlags.Never:
        this.warn(`should not emit a 'never' type`);
        return "?";
      case ts5.TypeFlags.TypeParameter:
        if (!type.symbol) {
          this.warn(`TypeParameter without a symbol`);
          return "?";
        }
        let prefix = "";
        if ((type.symbol.flags & ts5.SymbolFlags.TypeParameter) === 0) {
          prefix = "!";
        }
        const name = this.symbolToString(type.symbol);
        if (!name)
          return "?";
        return prefix + name;
      case ts5.TypeFlags.Object:
        return this.translateObject(type);
      case ts5.TypeFlags.Union:
        return this.translateUnion(type);
      case ts5.TypeFlags.Conditional:
      case ts5.TypeFlags.Substitution:
        if (type.aliasSymbol?.escapedName === "NonNullable" && isDeclaredInBuiltinLibDTS(type.aliasSymbol.declarations?.[0])) {
          let innerSymbol = undefined;
          if (type.aliasTypeArguments?.[0]) {
            innerSymbol = this.translate(type.aliasTypeArguments[0]);
          } else {
            const srcFile = this.node.getSourceFile().fileName;
            const start = this.node.getStart();
            const end = this.node.getEnd();
            throw new Error(`NonNullable missing expected type argument:
                ${srcFile}(${start}-${end})`);
          }
          return innerSymbol ?? "?";
        }
        this.warn(`emitting ? for conditional/substitution type`);
        return "?";
      case ts5.TypeFlags.Intersection:
        if (type.aliasSymbol?.escapedName === "NonNullable" && isDeclaredInBuiltinLibDTS(type.aliasSymbol.declarations?.[0])) {
          let innerSymbol = undefined;
          if (type.aliasTypeArguments?.[0]) {
            innerSymbol = this.translate(type.aliasTypeArguments[0]);
          } else {
            const srcFile = this.node.getSourceFile().fileName;
            const start = this.node.getStart();
            const end = this.node.getEnd();
            throw new Error(`NonNullable missing expected type argument:
                ${srcFile}(${start}-${end})`);
          }
          return innerSymbol ?? "?";
        }
        if (type.aliasSymbol?.escapedName === "gbigint") {
          return "!gbigint";
        }
        this.warn(`unhandled type flags: ${ts5.TypeFlags[type.flags]}`);
        return "?";
      case ts5.TypeFlags.Index:
      case ts5.TypeFlags.IndexedAccess:
        this.warn(`unhandled type flags: ${ts5.TypeFlags[type.flags]}`);
        return "?";
      default:
        if (type.flags & ts5.TypeFlags.Union) {
          if (type.flags === (ts5.TypeFlags.EnumLiteral | ts5.TypeFlags.Union) && type.symbol) {
            const name2 = this.symbolToString(type.symbol);
            return name2 ? "!" + name2 : this.translateUnion(type);
          }
          return this.translateUnion(type);
        }
        if (type.flags & ts5.TypeFlags.EnumLiteral) {
          return this.translateEnumLiteral(type);
        }
        throw new Error(`unknown type flags ${type.flags} on ${typeToDebugString(type)}`);
    }
  }
  warn(msg) {}
}
function isAlwaysUnknownSymbol(pathUnknownSymbolsSet, symbol) {
  if (pathUnknownSymbolsSet === undefined)
    return false;
  if (symbol.declarations === undefined)
    return false;
  return symbol.declarations.every((n) => {
    const fileName = normalize(n.getSourceFile().fileName);
    return pathUnknownSymbolsSet.has(fileName);
  });
}
function restParameterType(typeChecker, type) {
  if ((type.flags & ts5.TypeFlags.Object) === 0 && type.flags & ts5.TypeFlags.TypeParameter) {
    const baseConstraint = typeChecker.getBaseConstraintOfType(type);
    if (baseConstraint)
      type = baseConstraint;
  }
  if ((type.flags & ts5.TypeFlags.Object) === 0) {
    return;
  }
  const objType = type;
  if ((objType.objectFlags & ts5.ObjectFlags.Reference) === 0) {
    return;
  }
  const typeRef = objType;
  const typeArgs = typeChecker.getTypeArguments(typeRef);
  if (typeArgs.length < 1) {
    return;
  }
  return typeArgs[0];
}
function isFunctionLikeDeclaration(node) {
  return ts5.isFunctionDeclaration(node) || ts5.isMethodDeclaration(node) || ts5.isConstructorDeclaration(node) || ts5.isGetAccessorDeclaration(node) || ts5.isSetAccessorDeclaration(node) || ts5.isFunctionExpression(node) || ts5.isArrowFunction(node);
}

// src/tsickle/clutz.ts
function makeDeclarationTransformerFactory(typeChecker, host) {
  return (context) => {
    return {
      transformBundle() {
        throw new Error("did not expect to transform a bundle");
      },
      transformSourceFile(file) {
        const options = context.getCompilerOptions();
        const imports = gatherNecessaryClutzImports(host, typeChecker, file);
        let importStmts;
        if (imports.length > 0) {
          importStmts = imports.map((fileName) => {
            fileName = relative(options.rootDir, fileName);
            return ts6.factory.createImportDeclaration(undefined, undefined, ts6.factory.createStringLiteral(fileName));
          });
        }
        const globalBlock = generateClutzAliases(file, host.pathToModuleName("", file.fileName), typeChecker, options);
        if (!importStmts && !globalBlock)
          return file;
        return ts6.factory.updateSourceFile(file, ts6.setTextRange(ts6.factory.createNodeArray([
          ...importStmts ?? [],
          ...file.statements,
          ...globalBlock ? [globalBlock] : []
        ]), file.statements), file.isDeclarationFile, file.referencedFiles.map((f) => fixRelativeReference(f, file, options, host)), []);
      }
    };
  };
}
function fixRelativeReference(reference, origin, options, host) {
  if (!options.outDir || !options.rootDir) {
    return reference;
  }
  const originDir = dirname(origin.fileName);
  const expectedOutDir = join(options.outDir, relative(options.rootDir, originDir));
  const referencedFile = join(expectedOutDir, reference.fileName);
  const actualOutDir = join(options.outDir, host.rootDirsRelative(originDir));
  const fixedReference = relative(actualOutDir, referencedFile);
  reference.fileName = fixedReference;
  return reference;
}
function stringCompare(a, b) {
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
function generateClutzAliases(sourceFile, moduleName, typeChecker, options) {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
  const moduleExports = moduleSymbol && typeChecker.getExportsOfModule(moduleSymbol);
  if (!moduleExports)
    return;
  const origSourceFile = ts6.getOriginalNode(sourceFile);
  const localExports = moduleExports.filter((e) => {
    if (!e.declarations)
      return false;
    if (e.name === "default")
      return false;
    for (const d of e.declarations) {
      if (d.getSourceFile() !== origSourceFile) {
        return false;
      }
      const isInternalDeclaration2 = ts6.isInternalDeclaration;
      const node = ts6.isVariableDeclaration(d) ? d.parent.parent : d;
      if (options.stripInternal && isInternalDeclaration2(node, origSourceFile)) {
        return false;
      }
      if (!ts6.isExportSpecifier(d)) {
        return true;
      }
      const localSymbol = typeChecker.getExportSpecifierLocalTargetSymbol(d);
      if (!localSymbol)
        return false;
      if (!localSymbol.declarations)
        return false;
      for (const localD of localSymbol.declarations) {
        if (localD.getSourceFile() !== origSourceFile) {
          return false;
        }
      }
    }
    return true;
  });
  if (!localExports.length)
    return;
  localExports.sort((a, b) => stringCompare(a.name, b.name));
  const clutzModuleName = moduleName.replace(/\./g, "$");
  const globalExports = [];
  const nestedExports = [];
  for (const symbol of localExports) {
    let localName = symbol.name;
    const declaration = symbol.declarations?.find((d) => d.getSourceFile() === origSourceFile);
    if (declaration && ts6.isExportSpecifier(declaration) && declaration.propertyName) {
      localName = declaration.propertyName.text;
    }
    const mangledName = `module$contents$${clutzModuleName}_${symbol.name}`;
    globalExports.push(ts6.factory.createExportSpecifier(false, ts6.factory.createIdentifier(localName), ts6.factory.createIdentifier(mangledName)));
    nestedExports.push(ts6.factory.createExportSpecifier(false, localName === symbol.name ? undefined : localName, ts6.factory.createIdentifier(symbol.name)));
  }
  const globalDeclarations = [
    ts6.factory.createExportDeclaration(undefined, false, ts6.factory.createNamedExports(globalExports)),
    ts6.factory.createModuleDeclaration([ts6.factory.createModifier(ts6.SyntaxKind.ExportKeyword)], ts6.factory.createIdentifier(`module$exports$${clutzModuleName}`), ts6.factory.createModuleBlock([
      ts6.factory.createExportDeclaration(undefined, false, ts6.factory.createNamedExports(nestedExports))
    ]), ts6.NodeFlags.Namespace)
  ];
  return ts6.factory.createModuleDeclaration([ts6.factory.createModifier(ts6.SyntaxKind.DeclareKeyword)], ts6.factory.createIdentifier("global"), ts6.factory.createModuleBlock([
    ts6.factory.createModuleDeclaration(undefined, ts6.factory.createIdentifier("ಠ_ಠ.clutz"), ts6.factory.createModuleBlock(globalDeclarations), ts6.NodeFlags.Namespace | ts6.NodeFlags.NestedNamespace)
  ]), ts6.NodeFlags.GlobalAugmentation);
}
function ambientModuleSymbolFromClutz(googmoduleHost, typeChecker, stmt) {
  if (!ts6.isImportDeclaration(stmt) && !ts6.isExportDeclaration(stmt)) {
    return;
  }
  if (!stmt.moduleSpecifier) {
    return;
  }
  const moduleSymbol = typeChecker.getSymbolAtLocation(stmt.moduleSpecifier);
  if (moduleSymbol?.valueDeclaration && ts6.isSourceFile(moduleSymbol.valueDeclaration)) {
    return;
  }
  const ignoredDiagnostics = [];
  const namespace = jsPathToNamespace(googmoduleHost, stmt, ignoredDiagnostics, stmt.moduleSpecifier.text, () => moduleSymbol);
  if (namespace === null)
    return;
  return moduleSymbol;
}
function clutzSymbolFromQualifiedName(typeChecker, name) {
  const node = ts6.isQualifiedName(name) ? name.right : name;
  let sym = typeChecker.getSymbolAtLocation(node);
  if (!sym) {
    sym = node["symbol"];
  }
  if (!sym || !sym.declarations || sym.declarations.length === 0 || !isDeclaredInClutzDts(sym.declarations[0])) {
    return;
  }
  return sym;
}
function clutzSymbolFromNode(typeChecker, node) {
  if (ts6.isTypeReferenceNode(node)) {
    return clutzSymbolFromQualifiedName(typeChecker, node.typeName);
  }
  if (ts6.isTypeQueryNode(node)) {
    return clutzSymbolFromQualifiedName(typeChecker, node.exprName);
  }
  return;
}
function importPathForSymbol(sym) {
  if (!sym.declarations || sym.declarations.length === 0) {
    return;
  }
  const clutzFileName = sym.declarations[0].getSourceFile().fileName;
  if (!clutzFileName.endsWith(".d.ts")) {
    throw new Error(`Expected d.ts file for ${sym} but found ${clutzFileName}`);
  }
  return clutzFileName.substring(0, clutzFileName.length - ".d.ts".length);
}
function gatherNecessaryClutzImports(googmoduleHost, typeChecker, sf) {
  const imports = new Set;
  for (const stmt of sf.statements) {
    ts6.forEachChild(stmt, visit);
    const moduleSymbol = ambientModuleSymbolFromClutz(googmoduleHost, typeChecker, stmt);
    if (!moduleSymbol)
      continue;
    const importPath = importPathForSymbol(moduleSymbol);
    if (importPath)
      imports.add(importPath);
  }
  return Array.from(imports);
  function visit(node) {
    const sym = clutzSymbolFromNode(typeChecker, node);
    if (sym) {
      const importPath = importPathForSymbol(sym);
      if (importPath)
        imports.add(importPath);
    }
    ts6.forEachChild(node, visit);
  }
}

// src/tsickle/decorator-downlevel-transformer.ts
var ts9 = __toESM(require("typescript"));

// src/tsickle/decorators.ts
var ts8 = __toESM(require("typescript"));

// src/tsickle/jsdoc.ts
var ts7 = __toESM(require("typescript"));
var CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT = new Set([
  "abstract",
  "alternateMessageId",
  "author",
  "const",
  "constant",
  "constructor",
  "copyright",
  "define",
  "deprecated",
  "desc",
  "dict",
  "disposes",
  "enhance",
  "enhanceable",
  "enum",
  "export",
  "expose",
  "extends",
  "externs",
  "fileoverview",
  "final",
  "hassoydelcall",
  "hassoydeltemplate",
  "hidden",
  "id",
  "idGenerator",
  "ignore",
  "implements",
  "implicitCast",
  "inheritDoc",
  "interface",
  "jaggerInject",
  "jaggerModule",
  "jaggerProvide",
  "jaggerProvidePromise",
  "lends",
  "license",
  "link",
  "logTypeInCompiler",
  "meaning",
  "modifies",
  "modName",
  "mods",
  "ngInject",
  "noalias",
  "nocollapse",
  "nocompile",
  "noinline",
  "nosideeffects",
  "override",
  "owner",
  "package",
  "param",
  "pintomodule",
  "polymer",
  "polymerBehavior",
  "preserve",
  "preserveTry",
  "private",
  "protected",
  "public",
  "pureOrBreakMyCode",
  "record",
  "requirecss",
  "requires",
  "return",
  "returns",
  "sassGeneratedCssTs",
  "see",
  "struct",
  "suppress",
  "template",
  "this",
  "throws",
  "type",
  "typedef",
  "unrestricted",
  "version",
  "wizaction",
  "wizcallback",
  "wizmodule"
]);
var BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS = new Set(CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT);
BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS.delete("license");
var BANNED_JSDOC_TAGS_INPUT = new Set([
  "augments",
  "class",
  "constructs",
  "constructor",
  "enum",
  "extends",
  "field",
  "function",
  "implements",
  "interface",
  "lends",
  "namespace",
  "private",
  "protected",
  "public",
  "record",
  "static",
  "template",
  "this",
  "type",
  "typedef"
]);
var TAGS_CONFLICTING_WITH_TYPE = new Set(["param", "return"]);
var JSDOC_TAGS_WITH_TYPES = new Set([
  "const",
  "define",
  "export",
  ...TAGS_CONFLICTING_WITH_TYPE
]);
var ONE_LINER_TAGS = new Set([
  "type",
  "typedef",
  "nocollapse",
  "const",
  "enum"
]);
function parse(comment) {
  if (comment.kind !== ts7.SyntaxKind.MultiLineCommentTrivia)
    return null;
  if (comment.text[0] !== "*")
    return null;
  const text = comment.text.substring(1).trim();
  return parseContents(text);
}
function normalizeLineEndings(input) {
  return input.replace(/\r\n/g, `
`);
}
function parseContents(commentText) {
  commentText = normalizeLineEndings(commentText);
  commentText = commentText.replace(/^\s*\*? ?/gm, "");
  const lines = commentText.split(`
`);
  const tags = [];
  const warnings = [];
  for (const line of lines) {
    let match = line.match(/^\s*@([^\s{]+) *({?.*)/);
    if (match) {
      let [, tagName, text] = match;
      if (tagName === "returns") {
        tagName = "return";
      }
      let type;
      if (BANNED_JSDOC_TAGS_INPUT.has(tagName)) {
        if (tagName !== "template") {
          warnings.push(`@${tagName} annotations are redundant with TypeScript equivalents`);
          continue;
        } else {
          continue;
        }
      } else if (JSDOC_TAGS_WITH_TYPES.has(tagName)) {
        if (text[0] === "{") {
          warnings.push(`the type annotation on @${tagName} is redundant with its TypeScript type, ` + `remove the {...} part`);
          continue;
        }
      } else if (tagName === "suppress") {
        const typeMatch = text.match(/^\{(.*)\}(.*)$/);
        if (typeMatch) {
          [, type, text] = typeMatch;
        } else {
          warnings.push(`malformed @${tagName} tag: "${text}"`);
        }
      } else if (tagName === "dict") {
        warnings.push("use index signatures (`[k: string]: type`) instead of @dict");
        continue;
      }
      let parameterName;
      if (tagName === "param") {
        match = text.match(/^(\S+) ?(.*)/);
        if (match)
          [, parameterName, text] = match;
      }
      const tag = { tagName };
      if (parameterName)
        tag.parameterName = parameterName;
      if (text)
        tag.text = text;
      if (type)
        tag.type = type;
      tags.push(tag);
    } else {
      if (tags.length === 0) {
        tags.push({ tagName: "", text: line });
      } else {
        const lastTag = tags[tags.length - 1];
        lastTag.text = (lastTag.text || "") + `
` + line;
      }
    }
  }
  if (warnings.length > 0) {
    return { tags, warnings };
  }
  return { tags };
}
function tagToString(tag, escapeExtraTags = new Set) {
  let out = "";
  if (tag.tagName) {
    if (!CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT.has(tag.tagName) || escapeExtraTags.has(tag.tagName)) {
      out += ` \\@${tag.tagName}`;
    } else {
      out += ` @${tag.tagName}`;
    }
  }
  if (tag.type) {
    out += " {";
    if (tag.restParam) {
      out += "...";
    }
    out += tag.type;
    if (tag.optional) {
      out += "=";
    }
    out += "}";
  }
  if (tag.parameterName) {
    out += " " + tag.parameterName;
  }
  if (tag.text) {
    out += " " + tag.text.replace(/@/g, "\\@");
  }
  return out;
}
var SINGLETON_TAGS = new Set(["deprecated"]);
function synthesizeLeadingComments(node) {
  const existing = ts7.getSyntheticLeadingComments(node);
  if (existing && hasLeadingCommentsSuppressed(node))
    return existing;
  const text = ts7.getOriginalNode(node).getFullText();
  const synthComments = getLeadingCommentRangesSynthesized(text, node.getFullStart());
  if (synthComments.length) {
    ts7.setSyntheticLeadingComments(node, synthComments);
    suppressLeadingCommentsRecursively(node);
  }
  return synthComments;
}
function hasLeadingCommentsSuppressed(node) {
  const internalNode = node;
  if (!internalNode.emitNode)
    return false;
  return (internalNode.emitNode.flags & ts7.EmitFlags.NoLeadingComments) === ts7.EmitFlags.NoLeadingComments;
}
function getLeadingCommentRangesSynthesized(text, offset = 0) {
  const comments = ts7.getLeadingCommentRanges(text, 0) || [];
  return comments.map((cr) => {
    const commentText = cr.kind === ts7.SyntaxKind.SingleLineCommentTrivia ? text.substring(cr.pos + 2, cr.end) : text.substring(cr.pos + 2, cr.end - 2);
    return {
      ...cr,
      end: -1,
      originalRange: { end: cr.end + offset, pos: cr.pos + offset },
      pos: -1,
      text: commentText
    };
  });
}
function suppressLeadingCommentsRecursively(node) {
  const originalStart = node.getFullStart();
  function suppressCommentsInternal(node2) {
    ts7.setEmitFlags(node2, ts7.EmitFlags.NoLeadingComments);
    return !!ts7.forEachChild(node2, (child) => {
      if (child.pos !== originalStart)
        return true;
      return suppressCommentsInternal(child);
    });
  }
  suppressCommentsInternal(node);
}
function toSynthesizedComment(tags, escapeExtraTags, hasTrailingNewLine = true) {
  return {
    end: -1,
    hasTrailingNewLine,
    kind: ts7.SyntaxKind.MultiLineCommentTrivia,
    pos: -1,
    text: toStringWithoutStartEnd(tags, escapeExtraTags)
  };
}
function toStringWithoutStartEnd(tags, escapeExtraTags = new Set) {
  return serialize(tags, false, escapeExtraTags);
}
function toString(tags, escapeExtraTags = new Set) {
  return serialize(tags, true, escapeExtraTags);
}
function serialize(tags, includeStartEnd, escapeExtraTags = new Set) {
  if (tags.length === 0)
    return "";
  if (tags.length === 1) {
    const tag = tags[0];
    if (ONE_LINER_TAGS.has(tag.tagName) && (!tag.text || !tag.text.match(`
`))) {
      const text = tagToString(tag, escapeExtraTags);
      return includeStartEnd ? `/**${text} */` : `*${text} `;
    }
  }
  let out = includeStartEnd ? `/**
` : `*
`;
  const emitted = new Set;
  for (const tag of tags) {
    if (emitted.has(tag.tagName) && SINGLETON_TAGS.has(tag.tagName)) {
      continue;
    }
    emitted.add(tag.tagName);
    out += " *";
    out += tagToString(tag, escapeExtraTags).split(`
`).join(`
 * `);
    out += `
`;
  }
  out += includeStartEnd ? ` */
` : " ";
  return out;
}
function merge(tags) {
  const tagNames = new Set;
  const parameterNames = new Set;
  const types = new Set;
  const texts = new Set;
  let optional = false;
  let restParam = false;
  for (const tag2 of tags) {
    tagNames.add(tag2.tagName);
    if (tag2.parameterName !== undefined)
      parameterNames.add(tag2.parameterName);
    if (tag2.type !== undefined)
      types.add(tag2.type);
    if (tag2.text !== undefined)
      texts.add(tag2.text);
    if (tag2.optional)
      optional = true;
    if (tag2.restParam)
      restParam = true;
  }
  if (tagNames.size !== 1) {
    throw new Error(`cannot merge differing tags: ${JSON.stringify(tags)}`);
  }
  const tagName = tagNames.values().next().value;
  const parameterName = parameterNames.size > 0 ? Array.from(parameterNames).join("_or_") : undefined;
  const type = types.size > 0 ? Array.from(types).join("|") : undefined;
  const isTemplateTag = tagName === "template";
  const text = texts.size > 0 ? Array.from(texts).join(isTemplateTag ? "," : " / ") : undefined;
  const tag = { parameterName, tagName };
  if (text !== undefined) {
    tag.text = text;
  }
  if (type !== undefined) {
    tag.type = type;
  }
  if (restParam) {
    tag.restParam = true;
  } else if (optional) {
    tag.optional = true;
  }
  return tag;
}
function createGeneratedFromComment(file) {
  return `Generated from: ${file}`;
}

class MutableJSDoc {
  node;
  allComments;
  sourceComment;
  tags;
  sanitizedOtherComments = false;
  constructor(node, allComments, sourceComment, tags) {
    this.node = node;
    this.allComments = allComments;
    this.sourceComment = sourceComment;
    this.tags = tags;
  }
  updateComment(escapeExtraTags) {
    if (!this.sanitizedOtherComments) {
      for (let i = 0;i < this.allComments.length; i++) {
        if (i === this.sourceComment)
          continue;
        const comment2 = this.allComments[i];
        const parsed = parse(comment2);
        if (!parsed)
          continue;
        comment2.text = toStringWithoutStartEnd(parsed.tags, BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS);
      }
      this.sanitizedOtherComments = true;
    }
    const text = toStringWithoutStartEnd(this.tags, escapeExtraTags);
    if (this.sourceComment >= 0) {
      if (!text) {
        this.allComments.splice(this.sourceComment, 1);
        this.sourceComment = -1;
        return;
      }
      this.allComments[this.sourceComment].text = text;
      return;
    }
    if (!text)
      return;
    const comment = {
      end: -1,
      hasTrailingNewLine: true,
      kind: ts7.SyntaxKind.MultiLineCommentTrivia,
      pos: -1,
      text
    };
    this.allComments.push(comment);
    this.sourceComment = this.allComments.length - 1;
    ts7.setSyntheticLeadingComments(this.node, this.allComments);
  }
}
function getJSDocTags(node, diagnostics, sourceFile) {
  if (!ts7.getParseTreeNode(node))
    return [];
  const [, , tags] = parseJSDoc(node, diagnostics, sourceFile);
  return tags;
}
function getMutableJSDoc(node, diagnostics, sourceFile) {
  const [comments, i, tags] = parseJSDoc(node, diagnostics, sourceFile);
  return new MutableJSDoc(node, comments, i, tags);
}
function parseJSDoc(node, diagnostics, sourceFile) {
  let nodeCommentRange;
  if (diagnostics !== undefined) {
    const pos = node.getFullStart();
    const length = node.getLeadingTriviaWidth(sourceFile);
    nodeCommentRange = { end: pos + length, pos };
  }
  const comments = synthesizeLeadingComments(node);
  if (!comments || comments.length === 0)
    return [[], -1, []];
  for (let i = comments.length - 1;i >= 0; i--) {
    const comment = comments[i];
    const parsed = parse(comment);
    if (parsed) {
      if (diagnostics !== undefined && parsed.warnings) {
        const range = comment.originalRange || nodeCommentRange;
        reportDiagnostic(diagnostics, node, parsed.warnings.join(`
`), range, ts7.DiagnosticCategory.Warning);
      }
      return [comments, i, parsed.tags];
    }
  }
  return [comments, -1, []];
}

// src/tsickle/decorators.ts
function getDecoratorDeclarations(decorator, typeChecker) {
  let node = decorator;
  while (node.kind !== ts8.SyntaxKind.Identifier) {
    if (node.kind === ts8.SyntaxKind.Decorator || node.kind === ts8.SyntaxKind.CallExpression) {
      node = node.expression;
    } else {
      return [];
    }
  }
  let decSym = typeChecker.getSymbolAtLocation(node);
  if (!decSym)
    return [];
  if (decSym.flags & ts8.SymbolFlags.Alias) {
    decSym = typeChecker.getAliasedSymbol(decSym);
  }
  return decSym.getDeclarations() || [];
}
function hasExportingDecorator(node, typeChecker) {
  const decorators = ts8.canHaveDecorators(node) ? ts8.getDecorators(node) : [];
  return decorators && decorators.some((decorator) => isExportingDecorator(decorator, typeChecker));
}
function isExportingDecorator(decorator, typeChecker) {
  return getDecoratorDeclarations(decorator, typeChecker).some((declaration) => {
    const range = getAllLeadingComments(declaration);
    if (!range) {
      return false;
    }
    for (const { text } of range) {
      if (/@ExportDecoratedItems\b/.test(text)) {
        return true;
      }
    }
    return false;
  });
}
function transformDecoratorsOutputForClosurePropertyRenaming(diagnostics) {
  return (context) => {
    const result = (sourceFile) => {
      let nodeNeedingGoogReflect = undefined;
      const visitor = (node) => {
        const replacementNode = rewriteDecorator(node);
        if (replacementNode) {
          nodeNeedingGoogReflect = node;
          return replacementNode;
        }
        return ts8.visitEachChild(node, visitor, context);
      };
      let updatedSourceFile = ts8.visitNode(sourceFile, visitor, ts8.isSourceFile);
      if (nodeNeedingGoogReflect !== undefined) {
        const statements = [...updatedSourceFile.statements];
        const googModuleIndex = statements.findIndex(isGoogModuleStatement);
        if (googModuleIndex === -1) {
          reportDiagnostic(diagnostics, nodeNeedingGoogReflect, "Internal tsickle error: could not find goog.module statement to import __tsickle_googReflect for decorator compilation.");
          return sourceFile;
        }
        const googRequireReflectObjectProperty = ts8.factory.createVariableStatement(undefined, ts8.factory.createVariableDeclarationList([
          ts8.factory.createVariableDeclaration("__tsickle_googReflect", undefined, undefined, ts8.factory.createCallExpression(ts8.factory.createPropertyAccessExpression(ts8.factory.createIdentifier("goog"), "require"), undefined, [ts8.factory.createStringLiteral("goog.reflect")]))
        ], ts8.NodeFlags.Const));
        statements.splice(googModuleIndex + 3, 0, googRequireReflectObjectProperty);
        updatedSourceFile = ts8.factory.updateSourceFile(updatedSourceFile, ts8.setTextRange(ts8.factory.createNodeArray(statements), updatedSourceFile.statements), updatedSourceFile.isDeclarationFile, updatedSourceFile.referencedFiles, updatedSourceFile.typeReferenceDirectives, updatedSourceFile.hasNoDefaultLib, updatedSourceFile.libReferenceDirectives);
      }
      return updatedSourceFile;
    };
    return result;
  };
}
function rewriteDecorator(node) {
  if (!ts8.isCallExpression(node)) {
    return;
  }
  const identifier = node.expression;
  if (!ts8.isIdentifier(identifier) || identifier.text !== "__decorate") {
    return;
  }
  const args = [...node.arguments];
  if (args.length !== 4) {
    return;
  }
  const untypedFieldNameLiteral = args[2];
  if (!ts8.isStringLiteral(untypedFieldNameLiteral)) {
    return;
  }
  const fieldNameLiteral = untypedFieldNameLiteral;
  args[2] = ts8.factory.createCallExpression(ts8.factory.createPropertyAccessExpression(ts8.factory.createIdentifier("__tsickle_googReflect"), "objectProperty"), undefined, [ts8.factory.createStringLiteral(fieldNameLiteral.text), args[1]]);
  return ts8.factory.updateCallExpression(node, node.expression, node.typeArguments, args);
}
function isGoogModuleStatement(statement) {
  if (!ts8.isExpressionStatement(statement)) {
    return false;
  }
  const expr = statement.expression;
  if (!ts8.isCallExpression(expr)) {
    return false;
  }
  if (!ts8.isPropertyAccessExpression(expr.expression)) {
    return false;
  }
  const goog = expr.expression.expression;
  if (!ts8.isIdentifier(goog)) {
    return false;
  }
  return goog.text === "goog" && expr.expression.name.text === "module";
}
var TAGS_CONFLICTING_WITH_DECORATE = new Set(["template", "abstract"]);
function sanitizeDecorateComments(comments) {
  const sanitized = [];
  for (const comment of comments) {
    const parsedComment = parse(comment);
    if (parsedComment && parsedComment.tags.length !== 0) {
      const filteredTags = parsedComment.tags.filter((t) => !TAGS_CONFLICTING_WITH_DECORATE.has(t.tagName));
      if (filteredTags.length !== 0) {
        sanitized.push(toSynthesizedComment(filteredTags));
      }
    }
  }
  return sanitized;
}
function transformDecoratorJsdoc() {
  return () => {
    const transformer = (sourceFile) => {
      for (const stmt of sourceFile.statements) {
        if (!ts8.isExpressionStatement(stmt))
          continue;
        const expr = stmt.expression;
        if (!ts8.isBinaryExpression(expr))
          continue;
        if (expr.operatorToken.kind !== ts8.SyntaxKind.EqualsToken)
          continue;
        const rhs = expr.right;
        if (!ts8.isCallExpression(rhs))
          continue;
        if (ts8.isIdentifier(rhs.expression) && rhs.expression.text === "__decorate") {
          const comments = ts8.getSyntheticLeadingComments(stmt);
          if (!comments || comments.length === 0) {
            ts8.addSyntheticLeadingComment(stmt, ts8.SyntaxKind.MultiLineCommentTrivia, "* @suppress {visibility} ", true);
          } else {
            ts8.setSyntheticLeadingComments(stmt, sanitizeDecorateComments(comments));
          }
        }
      }
      return sourceFile;
    };
    return transformer;
  };
}

// src/tsickle/decorator-downlevel-transformer.ts
function shouldLower(decorator, typeChecker) {
  for (const d of getDecoratorDeclarations(decorator, typeChecker)) {
    let commentNode = d;
    if (commentNode.kind === ts9.SyntaxKind.VariableDeclaration) {
      if (!commentNode.parent)
        continue;
      commentNode = commentNode.parent;
    }
    if (commentNode.kind === ts9.SyntaxKind.VariableDeclarationList) {
      if (!commentNode.parent)
        continue;
      commentNode = commentNode.parent;
    }
    const range = getAllLeadingComments(commentNode);
    if (!range)
      continue;
    for (const { text } of range) {
      if (text.includes("@Annotation"))
        return true;
    }
  }
  return false;
}
var DECORATOR_INVOCATION_JSDOC_TYPE = "!Array<{type: !Function, args: (undefined|!Array<?>)}>";
function addJSDocTypeAnnotation(node, jsdocType) {
  ts9.setSyntheticLeadingComments(node, [
    toSynthesizedComment([
      {
        tagName: "type",
        type: jsdocType
      }
    ])
  ]);
}
function extractMetadataFromSingleDecorator(decorator, diagnostics) {
  const metadataProperties = [];
  const expr = decorator.expression;
  switch (expr.kind) {
    case ts9.SyntaxKind.Identifier:
      metadataProperties.push(ts9.factory.createPropertyAssignment("type", expr));
      break;
    case ts9.SyntaxKind.CallExpression:
      const call = expr;
      metadataProperties.push(ts9.factory.createPropertyAssignment("type", call.expression));
      if (call.arguments.length) {
        const args = [];
        for (const arg of call.arguments) {
          args.push(arg);
        }
        const argsArrayLiteral = ts9.factory.createArrayLiteralExpression(ts9.factory.createNodeArray(args, true));
        metadataProperties.push(ts9.factory.createPropertyAssignment("args", argsArrayLiteral));
      }
      break;
    default:
      diagnostics.push({
        category: ts9.DiagnosticCategory.Error,
        code: 0,
        file: decorator.getSourceFile(),
        length: decorator.getEnd() - decorator.getStart(),
        messageText: `${ts9.SyntaxKind[decorator.kind]} not implemented in gathering decorator metadata`,
        start: decorator.getStart()
      });
      break;
  }
  return ts9.factory.createObjectLiteralExpression(metadataProperties);
}
function createDecoratorClassProperty(decoratorList) {
  const modifier = ts9.factory.createToken(ts9.SyntaxKind.StaticKeyword);
  const initializer = ts9.factory.createArrayLiteralExpression(ts9.factory.createNodeArray(decoratorList, true), true);
  const prop = ts9.factory.createPropertyDeclaration([modifier], "decorators", undefined, undefined, initializer);
  addJSDocTypeAnnotation(prop, DECORATOR_INVOCATION_JSDOC_TYPE);
  return prop;
}
function createCtorParametersClassProperty(diagnostics, entityNameToExpression, ctorParameters) {
  const params = [];
  for (const ctorParam of ctorParameters) {
    if (!ctorParam.type && ctorParam.decorators.length === 0) {
      params.push(ts9.factory.createNull());
      continue;
    }
    const paramType = ctorParam.type ? typeReferenceToExpression(entityNameToExpression, ctorParam.type) : undefined;
    const members = [
      ts9.factory.createPropertyAssignment("type", paramType || ts9.factory.createIdentifier("undefined"))
    ];
    const decorators = [];
    for (const deco of ctorParam.decorators) {
      decorators.push(extractMetadataFromSingleDecorator(deco, diagnostics));
    }
    if (decorators.length) {
      members.push(ts9.factory.createPropertyAssignment("decorators", ts9.factory.createArrayLiteralExpression(decorators)));
    }
    params.push(ts9.factory.createObjectLiteralExpression(members));
  }
  const initializer = ts9.factory.createArrowFunction(undefined, undefined, [], undefined, ts9.factory.createToken(ts9.SyntaxKind.EqualsGreaterThanToken), ts9.factory.createArrayLiteralExpression(params, true));
  const ctorProp = ts9.factory.createPropertyDeclaration([ts9.factory.createToken(ts9.SyntaxKind.StaticKeyword)], "ctorParameters", undefined, undefined, initializer);
  ts9.setSyntheticLeadingComments(ctorProp, [
    toSynthesizedComment([
      {
        tagName: "type",
        type: lines(`function(): !Array<(null|{`, `  type: ?,`, `  decorators: (undefined|${DECORATOR_INVOCATION_JSDOC_TYPE}),`, `})>`)
      },
      { tagName: "nocollapse" }
    ])
  ]);
  return ctorProp;
}
function createPropDecoratorsClassProperty(diagnostics, properties) {
  const entries = [];
  for (const [name, decorators] of properties.entries()) {
    entries.push(ts9.factory.createPropertyAssignment(name, ts9.factory.createArrayLiteralExpression(decorators.map((deco) => extractMetadataFromSingleDecorator(deco, diagnostics)))));
  }
  const initializer = ts9.factory.createObjectLiteralExpression(entries, true);
  const prop = ts9.factory.createPropertyDeclaration([ts9.factory.createToken(ts9.SyntaxKind.StaticKeyword)], "propDecorators", undefined, undefined, initializer);
  addJSDocTypeAnnotation(prop, `!Object<string, ${DECORATOR_INVOCATION_JSDOC_TYPE}>`);
  return prop;
}
function typeReferenceToExpression(entityNameToExpression, node) {
  let kind = node.kind;
  if (ts9.isLiteralTypeNode(node)) {
    kind = node.literal.kind;
  }
  switch (kind) {
    case ts9.SyntaxKind.FunctionType:
    case ts9.SyntaxKind.ConstructorType:
      return ts9.factory.createIdentifier("Function");
    case ts9.SyntaxKind.ArrayType:
    case ts9.SyntaxKind.TupleType:
      return ts9.factory.createIdentifier("Array");
    case ts9.SyntaxKind.TypePredicate:
    case ts9.SyntaxKind.TrueKeyword:
    case ts9.SyntaxKind.FalseKeyword:
    case ts9.SyntaxKind.BooleanKeyword:
      return ts9.factory.createIdentifier("Boolean");
    case ts9.SyntaxKind.StringLiteral:
    case ts9.SyntaxKind.StringKeyword:
      return ts9.factory.createIdentifier("String");
    case ts9.SyntaxKind.ObjectKeyword:
      return ts9.factory.createIdentifier("Object");
    case ts9.SyntaxKind.NumberKeyword:
    case ts9.SyntaxKind.NumericLiteral:
      return ts9.factory.createIdentifier("Number");
    case ts9.SyntaxKind.TypeReference:
      const typeRef = node;
      return entityNameToExpression(typeRef.typeName);
    default:
      return;
  }
}
function decoratorDownlevelTransformer(typeChecker, diagnostics) {
  return (context) => {
    let importNamesBySymbol = new Map;
    function entityNameToExpression(name) {
      const sym = typeChecker.getSymbolAtLocation(name);
      if (!sym)
        return;
      if (!symbolIsValue(typeChecker, sym))
        return;
      if (ts9.isIdentifier(name)) {
        if (importNamesBySymbol.has(sym))
          return importNamesBySymbol.get(sym);
        return name;
      }
      const ref = entityNameToExpression(name.left);
      if (!ref)
        return;
      return ts9.factory.createPropertyAccessExpression(ref, name.right);
    }
    function transformClassElement(element) {
      element = ts9.visitEachChild(element, visitor, context);
      const modifiersToKeep = [];
      const toLower = [];
      for (const modifier of element.modifiers || []) {
        if (ts9.isDecorator(modifier)) {
          if (shouldLower(modifier, typeChecker)) {
            toLower.push(modifier);
            continue;
          }
        }
        modifiersToKeep.push(modifier);
      }
      if (!toLower.length)
        return [undefined, element, []];
      if (!element.name || element.name.kind !== ts9.SyntaxKind.Identifier) {
        diagnostics.push({
          category: ts9.DiagnosticCategory.Error,
          code: 0,
          file: element.getSourceFile(),
          length: element.getEnd() - element.getStart(),
          messageText: `cannot process decorators on strangely named method`,
          start: element.getStart()
        });
        return [undefined, element, []];
      }
      const name = element.name.text;
      let newNode;
      const modifiers = modifiersToKeep.length ? ts9.setTextRange(ts9.factory.createNodeArray(modifiersToKeep), ts9.factory.createNodeArray(element.modifiers ?? [])) : undefined;
      switch (element.kind) {
        case ts9.SyntaxKind.PropertyDeclaration:
          newNode = ts9.factory.updatePropertyDeclaration(element, modifiers, element.name, element.questionToken ?? element.exclamationToken, element.type, element.initializer);
          break;
        case ts9.SyntaxKind.GetAccessor:
          newNode = ts9.factory.updateGetAccessorDeclaration(element, modifiers, element.name, element.parameters, element.type, element.body);
          break;
        case ts9.SyntaxKind.SetAccessor:
          newNode = ts9.factory.updateSetAccessorDeclaration(element, modifiers, element.name, element.parameters, element.body);
          break;
        case ts9.SyntaxKind.MethodDeclaration:
          newNode = ts9.factory.updateMethodDeclaration(element, modifiers, element.asteriskToken, element.name, element.questionToken, element.typeParameters, element.parameters, element.type, element.body);
          break;
        default:
          throw new Error(`unexpected element: ${element}`);
      }
      return [name, newNode, toLower];
    }
    function transformConstructor(ctor) {
      ctor = ts9.visitEachChild(ctor, visitor, context);
      const newParameters = [];
      const oldParameters = ts9.visitParameterList(ctor.parameters, visitor, context);
      const parametersInfo = [];
      for (const param of oldParameters) {
        const modifiersToKeep = [];
        const paramInfo = {
          decorators: [],
          type: null
        };
        for (const modifier of param.modifiers || []) {
          if (ts9.isDecorator(modifier)) {
            if (shouldLower(modifier, typeChecker)) {
              paramInfo.decorators.push(modifier);
              continue;
            }
          }
          modifiersToKeep.push(modifier);
        }
        if (param.type) {
          paramInfo.type = param.type;
        }
        parametersInfo.push(paramInfo);
        const newParam = ts9.factory.updateParameterDeclaration(param, modifiersToKeep, param.dotDotDotToken, param.name, param.questionToken, param.type, param.initializer);
        newParameters.push(newParam);
      }
      const updated = ts9.factory.updateConstructorDeclaration(ctor, ctor.modifiers, newParameters, ts9.visitFunctionBody(ctor.body, visitor, context));
      return [updated, parametersInfo];
    }
    function transformClassDeclaration(classDecl) {
      const newMembers = [];
      const decoratedProperties = new Map;
      let classParameters = null;
      for (const member of classDecl.members) {
        switch (member.kind) {
          case ts9.SyntaxKind.PropertyDeclaration:
          case ts9.SyntaxKind.GetAccessor:
          case ts9.SyntaxKind.SetAccessor:
          case ts9.SyntaxKind.MethodDeclaration: {
            const [name, newMember, decorators] = transformClassElement(member);
            newMembers.push(newMember);
            if (name)
              decoratedProperties.set(name, decorators);
            continue;
          }
          case ts9.SyntaxKind.Constructor: {
            const ctor = member;
            if (!ctor.body)
              break;
            const [newMember, parametersInfo] = transformConstructor(member);
            classParameters = parametersInfo;
            newMembers.push(newMember);
            continue;
          }
          default:
            break;
        }
        newMembers.push(ts9.visitEachChild(member, visitor, context));
      }
      const decoratorsToLower = [];
      const modifiersToKeep = [];
      for (const modifier of classDecl.modifiers || []) {
        if (ts9.isDecorator(modifier)) {
          if (shouldLower(modifier, typeChecker)) {
            decoratorsToLower.push(extractMetadataFromSingleDecorator(modifier, diagnostics));
            continue;
          }
        }
        modifiersToKeep.push(modifier);
      }
      if (decoratorsToLower.length) {
        newMembers.push(createDecoratorClassProperty(decoratorsToLower));
      }
      if (classParameters) {
        if (decoratorsToLower.length || classParameters.some((p) => !!p.decorators.length)) {
          newMembers.push(createCtorParametersClassProperty(diagnostics, entityNameToExpression, classParameters));
        }
      }
      if (decoratedProperties.size) {
        newMembers.push(createPropDecoratorsClassProperty(diagnostics, decoratedProperties));
      }
      return ts9.factory.updateClassDeclaration(classDecl, modifiersToKeep.length ? modifiersToKeep : undefined, classDecl.name, classDecl.typeParameters, classDecl.heritageClauses, ts9.setTextRange(ts9.factory.createNodeArray(newMembers, classDecl.members.hasTrailingComma), classDecl.members));
    }
    function visitor(node) {
      switch (node.kind) {
        case ts9.SyntaxKind.SourceFile: {
          importNamesBySymbol = new Map;
          return ts9.visitEachChild(node, visitor, context);
        }
        case ts9.SyntaxKind.ImportDeclaration: {
          const impDecl = node;
          if (impDecl.importClause) {
            const importClause = impDecl.importClause;
            const names = [];
            if (importClause.name) {
              names.push(importClause.name);
            }
            if (importClause.namedBindings && importClause.namedBindings.kind === ts9.SyntaxKind.NamedImports) {
              names.push(...importClause.namedBindings.elements.map((e) => e.name));
            }
            for (const name of names) {
              const sym = typeChecker.getSymbolAtLocation(name);
              importNamesBySymbol.set(sym, name);
            }
          }
          return ts9.visitEachChild(node, visitor, context);
        }
        case ts9.SyntaxKind.ClassDeclaration: {
          return transformClassDeclaration(node);
        }
        default:
          return visitEachChild2(node, visitor, context);
      }
    }
    return (sf) => visitor(sf);
  };
}
function lines(...s) {
  return s.join(`
`);
}

// src/tsickle/enum-transformer.ts
var ts10 = __toESM(require("typescript"));
function isInUnsupportedNamespace(node) {
  let parent = ts10.getOriginalNode(node).parent;
  while (parent) {
    if (parent.kind === ts10.SyntaxKind.ModuleDeclaration) {
      return !isMergedDeclaration(parent);
    }
    parent = parent.parent;
  }
  return false;
}
function getEnumMemberType(typeChecker, member) {
  if (!member.initializer) {
    return "number";
  }
  const type = typeChecker.getTypeAtLocation(member.initializer);
  if (type.flags & ts10.TypeFlags.NumberLike) {
    return "number";
  }
  return "string";
}
function getEnumType(typeChecker, enumDecl) {
  let hasNumber = false;
  let hasString = false;
  for (const member of enumDecl.members) {
    const type = getEnumMemberType(typeChecker, member);
    if (type === "string") {
      hasString = true;
    } else if (type === "number") {
      hasNumber = true;
    }
  }
  if (hasNumber && hasString) {
    return "?";
  } else if (hasNumber) {
    return "number";
  } else if (hasString) {
    return "string";
  } else {
    return "?";
  }
}
function enumTransformer(host, typeChecker) {
  return (context) => {
    function visitor(node) {
      if (!ts10.isEnumDeclaration(node))
        return ts10.visitEachChild(node, visitor, context);
      if (isInUnsupportedNamespace(node)) {
        return ts10.visitEachChild(node, visitor, context);
      }
      if (isAmbient(node))
        return ts10.visitEachChild(node, visitor, context);
      const isExported = hasModifierFlag(node, ts10.ModifierFlags.Export);
      const enumType = getEnumType(typeChecker, node);
      const values = [];
      let enumIndex = 0;
      for (const member of node.members) {
        let enumValue;
        if (member.initializer) {
          const enumConstValue = typeChecker.getConstantValue(member);
          if (typeof enumConstValue === "number") {
            enumIndex = enumConstValue + 1;
            if (enumConstValue < 0) {
              enumValue = ts10.factory.createPrefixUnaryExpression(ts10.SyntaxKind.MinusToken, ts10.factory.createNumericLiteral(-enumConstValue));
            } else {
              enumValue = ts10.factory.createNumericLiteral(enumConstValue);
            }
          } else if (typeof enumConstValue === "string") {
            enumValue = ts10.factory.createStringLiteral(enumConstValue);
          } else {
            enumValue = visitor(member.initializer);
          }
        } else {
          enumValue = ts10.factory.createNumericLiteral(enumIndex);
          enumIndex++;
        }
        values.push(ts10.setOriginalNode(ts10.setTextRange(ts10.factory.createPropertyAssignment(member.name, enumValue), member), member));
      }
      const varDecl = ts10.factory.createVariableDeclaration(node.name, undefined, undefined, ts10.factory.createObjectLiteralExpression(ts10.setTextRange(ts10.factory.createNodeArray(values, true), node.members), true));
      const varDeclStmt = ts10.setOriginalNode(ts10.setTextRange(ts10.factory.createVariableStatement(undefined, ts10.factory.createVariableDeclarationList([varDecl], host.useDeclarationMergingTransformation ? ts10.NodeFlags.Const : undefined)), node), node);
      const tags = getJSDocTags(ts10.getOriginalNode(node));
      tags.push({ tagName: "enum", type: enumType });
      const comment = toSynthesizedComment(tags);
      ts10.setSyntheticLeadingComments(varDeclStmt, [comment]);
      const name = getIdentifierText(node.name);
      const resultNodes = [varDeclStmt];
      if (isExported) {
        resultNodes.push(ts10.factory.createExportDeclaration(undefined, false, ts10.factory.createNamedExports([
          ts10.factory.createExportSpecifier(false, undefined, name)
        ])));
      }
      if (hasModifierFlag(node, ts10.ModifierFlags.Const)) {
        return resultNodes;
      }
      for (const member of node.members) {
        const memberName = member.name;
        const memberType = getEnumMemberType(typeChecker, member);
        if (memberType !== "number" || ts10.isPrivateIdentifier(memberName)) {
          continue;
        }
        let nameExpr;
        let memberAccess;
        if (ts10.isIdentifier(memberName)) {
          nameExpr = createSingleQuoteStringLiteral(memberName.text);
          const ident = ts10.factory.createIdentifier(getIdentifierText(memberName));
          memberAccess = ts10.factory.createPropertyAccessExpression(ts10.factory.createIdentifier(name), ident);
        } else {
          nameExpr = ts10.isComputedPropertyName(memberName) ? memberName.expression : memberName;
          memberAccess = ts10.factory.createElementAccessExpression(ts10.factory.createIdentifier(name), nameExpr);
        }
        resultNodes.push(ts10.factory.createExpressionStatement(ts10.factory.createAssignment(ts10.factory.createElementAccessExpression(ts10.factory.createIdentifier(name), memberAccess), nameExpr)));
      }
      return resultNodes;
    }
    return (sf) => visitor(sf);
  };
}

// src/tsickle/externs.ts
var ts13 = __toESM(require("typescript"));

// src/tsickle/jsdoc-transformer.ts
var ts12 = __toESM(require("typescript"));

// src/tsickle/module-type-translator.ts
var ts11 = __toESM(require("typescript"));
function getDefinedModule(symbol) {
  while (symbol) {
    if (symbol.flags & ts11.SymbolFlags.Module) {
      return symbol;
    }
    symbol = symbol.parent;
  }
  return;
}
function getParameterName(param, index) {
  switch (param.name.kind) {
    case ts11.SyntaxKind.Identifier:
      let name = getIdentifierText(param.name);
      if (name === "arguments")
        name = "tsickle_arguments";
      return name;
    case ts11.SyntaxKind.ArrayBindingPattern:
    case ts11.SyntaxKind.ObjectBindingPattern:
      return `__${index}`;
    default:
      const paramName = param.name;
      throw new Error(`unhandled function parameter kind: ${ts11.SyntaxKind[paramName.kind]}`);
  }
}

class ModuleTypeTranslator {
  sourceFile;
  typeChecker;
  host;
  diagnostics;
  isForExterns;
  useInternalNamespaceForExterns;
  additionalImports = [];
  requireTypeModules = new Set;
  symbolToNameCache = new Map;
  symbolsToAliasedNames = new Map;
  constructor(sourceFile, typeChecker, host, diagnostics, isForExterns, useInternalNamespaceForExterns = false) {
    this.sourceFile = sourceFile;
    this.typeChecker = typeChecker;
    this.host = host;
    this.diagnostics = diagnostics;
    this.isForExterns = isForExterns;
    this.useInternalNamespaceForExterns = useInternalNamespaceForExterns;
    this.host.unknownTypesPaths = this.host.unknownTypesPaths ?? this.host.typeBlackListPaths;
  }
  addRequireTypeIfIsExported(decl, sym) {
    if (!hasModifierFlag(decl, ts11.ModifierFlags.ExportDefault))
      return false;
    if (isGlobalAugmentation(decl))
      return false;
    const sourceFile = decl.getSourceFile();
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      return false;
    }
    if (this.isForExterns) {
      this.error(decl, `declaration from module used in ambient type: ${sym.name}`);
    } else if (sourceFile.isDeclarationFile && !sourceFile.text.match(/^\/\/!! generated by (clutz|tsickle|clutz2)/)) {
      this.registerExternSymbolAliases(sourceFile.fileName, moduleSymbol);
    } else {
      this.requireType(decl, sourceFile.fileName, moduleSymbol);
    }
    return true;
  }
  generateModulePrefix(importPath) {
    const modulePrefix = importPath.replace(/(\/index)?(\.d)?\.[tj]sx?$/, "").replace(/^.*[/.](.+?)/, "$1").replace(/\W/g, "_");
    return `tsickle_${modulePrefix || "reqType"}_`;
  }
  getTypeSymbolOfSymbolIfClassOrInterface(symbol) {
    const type = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
    const typeSymbol = type.getSymbol();
    if (!typeSymbol) {
      return;
    }
    if (!(type.flags & ts11.TypeFlags.Object)) {
      return;
    }
    const objectFlags = type.objectFlags;
    return objectFlags & ts11.ObjectFlags.ClassOrInterface ? typeSymbol : undefined;
  }
  qualifiedNameFromSymbolChain(leafSymbol, googNamespace, isDefaultImport, aliasPrefix, namedDefaultImport) {
    if (googNamespace && (isDefaultImport || namedDefaultImport)) {
      return aliasPrefix;
    }
    let typeSymbol = leafSymbol;
    const symbols = [typeSymbol];
    while (typeSymbol.parent && typeSymbol.parent.flags & ts11.SymbolFlags.NamespaceModule) {
      typeSymbol = typeSymbol.parent;
      symbols.push(typeSymbol);
    }
    let qualifiedName = "";
    let aliasResolved = false;
    for (const symbol of symbols.reverse()) {
      const alias = this.symbolsToAliasedNames.get(symbol);
      if (alias) {
        qualifiedName = alias;
        aliasResolved = true;
        continue;
      }
      qualifiedName = qualifiedName ? qualifiedName + "." + symbol.name : symbol.name;
    }
    if (!aliasResolved && leafSymbol.parent) {
      qualifiedName = aliasPrefix + "." + qualifiedName;
    }
    return qualifiedName.replace("ಠ_ಠ.clutz.", "");
  }
  registerImportTypeSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, aliasPrefix) {
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const namedDefaultImport = sym.name === "default";
      if (sym.flags & ts11.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      const typeSymbol = this.getTypeSymbolOfSymbolIfClassOrInterface(sym);
      if (!typeSymbol)
        continue;
      if (typeSymbol.parent && getDefinedModule(sym) !== getDefinedModule(typeSymbol)) {
        continue;
      }
      const qualifiedName = this.qualifiedNameFromSymbolChain(typeSymbol, googNamespace, isDefaultImport, aliasPrefix, namedDefaultImport);
      const cache = this.symbolToNameCache.get(typeSymbol);
      if (!cache || cache.length > qualifiedName.length) {
        this.symbolToNameCache.set(typeSymbol, qualifiedName);
      }
    }
  }
  resolveRestParameterType(newTag, fnDecl, paramNode) {
    const type = restParameterType(this.typeChecker, this.typeChecker.getTypeAtLocation(paramNode));
    newTag.restParam = true;
    if (!type) {
      this.debugWarn(paramNode, "failed to resolve rest parameter type, emitting ?");
      newTag.type = "?";
      return;
    }
    newTag.type = this.typeToClosure(fnDecl, type);
  }
  debugWarn(context, messageText) {
    reportDebugWarning(this.host, context, messageText);
  }
  ensureSymbolDeclared(sym) {
    if (this.symbolsToAliasedNames.has(sym))
      return;
    const declarations = sym.declarations;
    const thisSourceFile = ts11.getOriginalNode(this.sourceFile);
    if (declarations.some((d) => d.getSourceFile() === thisSourceFile)) {
      return;
    }
    for (const decl of declarations) {
      if (this.addRequireTypeIfIsExported(decl, sym))
        return;
    }
    const clutzDecl = declarations.find(isDeclaredInClutzDts);
    if (!clutzDecl)
      return;
    const clutzDts = clutzDecl.getSourceFile();
    const clutzModule = this.typeChecker.getSymbolsInScope(clutzDts, ts11.SymbolFlags.Module).find((module2) => module2.getName().startsWith('"goog:') && module2.valueDeclaration?.getSourceFile() === clutzDts && this.typeChecker.getExportsOfModule(module2).some((exported) => {
      if (exported.flags & ts11.SymbolFlags.Alias) {
        exported = this.typeChecker.getAliasedSymbol(exported);
      }
      if (exported === sym) {
        return true;
      }
      if (exported.exports) {
        let found = false;
        exported.exports.forEach((symbol, key) => {
          found = found || symbol === sym;
        });
        return found;
      }
      return false;
    }));
    if (clutzModule) {
      this.requireType(clutzDecl, clutzModule.getName().slice(1, -1), clutzModule);
    }
  }
  error(node, messageText) {
    reportDiagnostic(this.diagnostics, node, messageText);
  }
  getFunctionTypeJSDoc(fnDecls, extraTags = []) {
    const typeChecker = this.typeChecker;
    const tagsByName = new Map;
    function addTag(tag) {
      if (tag.tagName === "implements")
        return;
      const existing = tagsByName.get(tag.tagName);
      tagsByName.set(tag.tagName, existing ? merge([existing, tag]) : tag);
    }
    for (const extraTag of extraTags)
      addTag(extraTag);
    const isConstructor = fnDecls.find((d) => d.kind === ts11.SyntaxKind.Constructor) !== undefined;
    const paramTags = [];
    const returnTags = [];
    const thisTags = [];
    const typeParameterNames = new Set;
    const argCounts = [];
    let thisReturnType = null;
    for (const fnDecl of fnDecls) {
      const tags = this.getJSDoc(fnDecl, false);
      for (const tag of tags) {
        if (tag.tagName === "param" || tag.tagName === "return")
          continue;
        addTag(tag);
      }
      const flags = ts11.getCombinedModifierFlags(fnDecl);
      if (flags & ts11.ModifierFlags.Abstract) {
        addTag({ tagName: "abstract" });
      }
      if (fnDecls.every((d) => !ts11.isFunctionDeclaration(d) && !ts11.isFunctionExpression(d) && !ts11.isArrowFunction(d))) {
        if (flags & ts11.ModifierFlags.Protected) {
          addTag({ tagName: "protected" });
        } else if (flags & ts11.ModifierFlags.Private) {
          addTag({ tagName: "private" });
        } else if (!tagsByName.has("export") && !tagsByName.has("package")) {
          addTag({ tagName: "public" });
        }
      }
      if (fnDecl.typeParameters) {
        for (const tp of fnDecl.typeParameters) {
          typeParameterNames.add(getIdentifierText(tp.name));
        }
      }
      const sig = typeChecker.getSignatureFromDeclaration(fnDecl);
      if (!sig || !sig.declaration) {
        throw new Error(`invalid signature ${fnDecl.name}`);
      }
      if (sig.declaration.kind === ts11.SyntaxKind.JSDocSignature) {
        throw new Error(`JSDoc signature ${fnDecl.name}`);
      }
      let hasThisParam = false;
      for (let i = 0;i < sig.declaration.parameters.length; i++) {
        const paramNode = sig.declaration.parameters[i];
        const name = getParameterName(paramNode, i);
        const isThisParam = name === "this";
        if (isThisParam)
          hasThisParam = true;
        const newTag = {
          optional: paramNode.initializer !== undefined || paramNode.questionToken !== undefined,
          parameterName: isThisParam ? undefined : name,
          tagName: isThisParam ? "this" : "param"
        };
        if (paramNode.dotDotDotToken === undefined) {
          newTag.type = this.typeToClosure(fnDecl, this.typeChecker.getTypeAtLocation(paramNode));
        } else {
          this.resolveRestParameterType(newTag, fnDecl, paramNode);
        }
        for (const { parameterName, tagName, text } of tags) {
          if (tagName === "param" && parameterName === newTag.parameterName) {
            newTag.text = text;
            break;
          }
        }
        if (!isThisParam) {
          const paramIdx = hasThisParam ? i - 1 : i;
          if (!paramTags[paramIdx])
            paramTags.push([]);
          paramTags[paramIdx].push(newTag);
        } else {
          thisTags.push(newTag);
        }
      }
      argCounts.push(hasThisParam ? sig.declaration.parameters.length - 1 : sig.declaration.parameters.length);
      if (!isConstructor) {
        const returnTag = {
          tagName: "return"
        };
        const retType = typeChecker.getReturnTypeOfSignature(sig);
        if (retType["isThisType"] && !hasThisParam) {
          thisReturnType = retType;
          addTag({ tagName: "template", text: "THIS" });
          addTag({ tagName: "this", type: "THIS" });
          returnTag.type = "THIS";
        } else {
          returnTag.type = this.typeToClosure(fnDecl, retType);
          for (const { tagName, text } of tags) {
            if (tagName === "return") {
              returnTag.text = text;
              break;
            }
          }
        }
        returnTags.push(returnTag);
      }
    }
    if (typeParameterNames.size > 0) {
      addTag({
        tagName: "template",
        text: Array.from(typeParameterNames.values()).join(", ")
      });
    }
    const newDoc = Array.from(tagsByName.values());
    for (const extraTag of extraTags) {
      if (extraTag.tagName === "implements")
        newDoc.push(extraTag);
    }
    if (thisTags.length > 0) {
      newDoc.push(merge(thisTags));
    }
    const minArgsCount = Math.min(...argCounts);
    const maxArgsCount = Math.max(...argCounts);
    const paramNames = new Set;
    let foundOptional = false;
    for (let i = 0;i < maxArgsCount; i++) {
      const paramTag = merge(paramTags[i]);
      if (paramTag.parameterName) {
        if (paramNames.has(paramTag.parameterName)) {
          paramTag.parameterName += i.toString();
        }
        paramNames.add(paramTag.parameterName);
      }
      if (!paramTag.restParam && (paramTag.optional || foundOptional || i >= minArgsCount)) {
        foundOptional = true;
        paramTag.optional = true;
      }
      newDoc.push(paramTag);
      if (paramTag.restParam) {
        break;
      }
    }
    if (!isConstructor) {
      newDoc.push(merge(returnTags));
    }
    return {
      parameterNames: newDoc.filter((t) => t.tagName === "param").map((t) => t.parameterName),
      tags: newDoc,
      thisReturnType
    };
  }
  getJSDoc(node, reportWarnings) {
    return getJSDocTags(node, reportWarnings ? this.diagnostics : undefined, this.sourceFile);
  }
  getMutableJSDoc(node) {
    return getMutableJSDoc(node, this.diagnostics, this.sourceFile);
  }
  insertAdditionalImports(sourceFile) {
    let insertion = 0;
    if (sourceFile.statements.length && sourceFile.statements[0].kind === ts11.SyntaxKind.NotEmittedStatement) {
      insertion++;
    }
    return ts11.factory.updateSourceFile(sourceFile, [
      ...sourceFile.statements.slice(0, insertion),
      ...this.additionalImports,
      ...sourceFile.statements.slice(insertion)
    ]);
  }
  isAlwaysUnknownSymbol(context) {
    const type = this.typeChecker.getTypeAtLocation(context);
    let sym = type.symbol;
    if (!sym)
      return false;
    if (sym.flags & ts11.SymbolFlags.Alias) {
      sym = this.typeChecker.getAliasedSymbol(sym);
    }
    return this.newTypeTranslator(context).isAlwaysUnknownSymbol(sym);
  }
  mustGetSymbolAtLocation(node) {
    const sym = this.typeChecker.getSymbolAtLocation(node);
    if (!sym)
      throw new Error("no symbol");
    return sym;
  }
  newTypeTranslator(context) {
    const translationContext = this.isForExterns ? this.sourceFile : context;
    const translator = new TypeTranslator(this.host, this.typeChecker, translationContext, this.host.unknownTypesPaths || new Set, this.symbolsToAliasedNames, this.symbolToNameCache, (sym) => {
      this.ensureSymbolDeclared(sym);
    });
    translator.isForExterns = this.isForExterns;
    translator.useInternalNamespaceForExterns = this.useInternalNamespaceForExterns;
    translator.warn = (msg) => {
      this.debugWarn(context, msg);
    };
    return translator;
  }
  registerExternSymbolAliases(importPath, moduleSymbol) {
    const moduleNamespace = moduleNameAsIdentifier(this.host, importPath, this.sourceFile.fileName);
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const namedDefaultImport = sym.name === "default";
      let qualifiedName;
      if (moduleNamespace) {
        if (namedDefaultImport) {
          qualifiedName = moduleNamespace;
        } else {
          qualifiedName = moduleNamespace + "." + sym.name;
        }
      } else {
        qualifiedName = sym.name;
      }
      if (sym.flags & ts11.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      this.symbolsToAliasedNames.set(sym, qualifiedName);
    }
  }
  registerImportSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, getAliasPrefix) {
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const aliasPrefix = getAliasPrefix(sym);
      const namedDefaultImport = sym.name === "default";
      const qualifiedName = googNamespace && (isDefaultImport || namedDefaultImport) ? aliasPrefix : aliasPrefix + "." + sym.name;
      if (sym.flags & ts11.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      this.symbolsToAliasedNames.set(sym, qualifiedName);
    }
  }
  requireType(context, importPath, moduleSymbol, isDefaultImport = false) {
    if (this.host.untyped)
      return;
    if (this.requireTypeModules.has(moduleSymbol))
      return;
    if (isAlwaysUnknownSymbol(this.host.unknownTypesPaths, moduleSymbol)) {
      return;
    }
    const nsImport = jsPathToNamespace(this.host, context, this.diagnostics, importPath, () => moduleSymbol);
    const requireTypePrefix = this.generateModulePrefix(importPath) + String(this.requireTypeModules.size + 1);
    const moduleNamespace = nsImport != null ? nsImport : this.host.pathToModuleName(this.sourceFile.fileName, importPath);
    if (jsPathToStripProperty(this.host, importPath, () => moduleSymbol)) {
      isDefaultImport = true;
    }
    this.additionalImports.push(ts11.factory.createVariableStatement(undefined, ts11.factory.createVariableDeclarationList([
      ts11.factory.createVariableDeclaration(requireTypePrefix, undefined, undefined, ts11.factory.createCallExpression(ts11.factory.createPropertyAccessExpression(ts11.factory.createIdentifier("goog"), "requireType"), undefined, [ts11.factory.createStringLiteral(moduleNamespace)]))
    ], ts11.NodeFlags.Const)));
    this.requireTypeModules.add(moduleSymbol);
    this.registerImportSymbolAliases(nsImport, isDefaultImport, moduleSymbol, () => requireTypePrefix);
    this.registerImportTypeSymbolAliases(nsImport, isDefaultImport, moduleSymbol, requireTypePrefix);
  }
  typeToClosure(context, type) {
    if (this.host.untyped) {
      return "?";
    }
    context = ts11.getOriginalNode(context);
    const typeChecker = this.typeChecker;
    if (!type) {
      type = typeChecker.getTypeAtLocation(context);
    }
    try {
      return this.newTypeTranslator(context).translate(type);
    } catch (e) {
      if (!(e instanceof Error))
        throw e;
      const sourceFile = context.getSourceFile();
      const { character, line } = context.pos !== -1 ? sourceFile.getLineAndCharacterOfPosition(context.pos) : { character: 0, line: 0 };
      e.message = `internal error converting type at ${sourceFile.fileName}:${line}:${character}:

` + e.message;
      throw e;
    }
  }
}
function isGlobalAugmentation(decl) {
  let current = decl;
  while (current) {
    if (current.flags & ts11.NodeFlags.GlobalAugmentation)
      return true;
    current = current.parent;
  }
  return false;
}

// src/tsickle/jsdoc-transformer.ts
function addCommentOn(node, tags, escapeExtraTags, hasTrailingNewLine = true) {
  const comment = toSynthesizedComment(tags, escapeExtraTags, hasTrailingNewLine);
  const comments = ts12.getSyntheticLeadingComments(node) || [];
  comments.push(comment);
  ts12.setSyntheticLeadingComments(node, comments);
  return comment;
}
function maybeAddTemplateClause(docTags, decl) {
  if (!decl.typeParameters)
    return;
  docTags.push({
    tagName: "template",
    text: decl.typeParameters.map((tp) => getIdentifierText(tp.name)).join(", ")
  });
}
function maybeAddHeritageClauses(docTags, mtt, decl) {
  if (!decl.heritageClauses)
    return;
  const isClass = decl.kind === ts12.SyntaxKind.ClassDeclaration;
  const hasAnyExtends = decl.heritageClauses.some((c) => c.token === ts12.SyntaxKind.ExtendsKeyword);
  for (const heritage of decl.heritageClauses) {
    const isExtends = heritage.token === ts12.SyntaxKind.ExtendsKeyword;
    for (const expr of heritage.types) {
      addHeritage(isExtends ? "extends" : "implements", expr);
    }
  }
  function addHeritage(relation, expr) {
    const supertype = mtt.typeChecker.getTypeAtLocation(expr);
    if (!supertype.symbol) {
      warn(`type without symbol`);
      return;
    }
    if (!supertype.symbol.name) {
      warn(`type without symbol name`);
      return;
    }
    if (supertype.symbol.flags & ts12.SymbolFlags.TypeLiteral) {
      warn(`dropped ${relation} of a type literal: ${expr.getText()}`);
      return;
    }
    const typeTranslator = mtt.newTypeTranslator(expr);
    typeTranslator.dropFinalTypeArgument = true;
    let closureType = typeTranslator.translate(supertype);
    if (closureType === "?") {
      warn(`{?} type`);
      return;
    }
    closureType = closureType.replace(/^!/, "");
    let tagName = relation;
    if (supertype.symbol.flags & ts12.SymbolFlags.Class) {
      if (!isClass) {
        warn(`interface cannot extend/implement class`);
        return;
      }
      if (relation !== "extends") {
        if (!hasAnyExtends) {
          tagName = "extends";
        } else {
          warn(`cannot implements a class`);
          return;
        }
      }
    }
    docTags.push({
      tagName,
      type: closureType
    });
    function warn(message) {
      message = `dropped ${relation}: ${message}`;
      docTags.push({ tagName: "", text: `tsickle: ${message}` });
      mtt.debugWarn(decl, message);
    }
  }
}
function createMemberTypeDeclaration(mtt, typeDecl) {
  const ctors = [];
  let paramProps = [];
  const nonStaticProps = [];
  const staticProps = [];
  const unhandled = [];
  const abstractMethods = [];
  for (const member of typeDecl.members) {
    if (member.kind === ts12.SyntaxKind.Constructor) {
      ctors.push(member);
    } else if (ts12.isPropertyDeclaration(member) || ts12.isPropertySignature(member) || ts12.isMethodDeclaration(member) && member.questionToken) {
      const isStatic = hasModifierFlag(member, ts12.ModifierFlags.Static);
      if (isStatic) {
        staticProps.push(member);
      } else {
        nonStaticProps.push(member);
      }
    } else if (member.kind === ts12.SyntaxKind.MethodDeclaration || member.kind === ts12.SyntaxKind.MethodSignature || member.kind === ts12.SyntaxKind.GetAccessor || member.kind === ts12.SyntaxKind.SetAccessor) {
      if (hasModifierFlag(member, ts12.ModifierFlags.Abstract) || ts12.isInterfaceDeclaration(typeDecl)) {
        abstractMethods.push(member);
      }
    } else {
      unhandled.push(member);
    }
  }
  if (ctors.length > 0) {
    const ctor = ctors[ctors.length - 1];
    paramProps = ctor.parameters.filter((p) => hasModifierFlag(p, ts12.ModifierFlags.ParameterPropertyModifier));
  }
  if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0 && abstractMethods.length === 0) {
    return null;
  }
  if (!typeDecl.name) {
    mtt.debugWarn(typeDecl, "cannot add types on unnamed declarations");
    return null;
  }
  const className = getIdentifierText(typeDecl.name);
  const staticPropAccess = ts12.factory.createIdentifier(className);
  const instancePropAccess = ts12.factory.createPropertyAccessExpression(staticPropAccess, "prototype");
  const isInterface = ts12.isInterfaceDeclaration(typeDecl);
  const propertyDecls = staticProps.map((p) => createClosurePropertyDeclaration(mtt, staticPropAccess, p, isInterface && !!p.questionToken));
  propertyDecls.push(...[...nonStaticProps, ...paramProps].map((p) => createClosurePropertyDeclaration(mtt, instancePropAccess, p, isInterface && !!p.questionToken)));
  propertyDecls.push(...unhandled.map((p) => createMultiLineComment(p, `Skipping unhandled member: ${escapeForComment(p.getText())}`)));
  for (const fnDecl of abstractMethods) {
    const name = fnDecl.name && ts12.isComputedPropertyName(fnDecl.name) ? fnDecl.name.expression : propertyName(fnDecl);
    if (!name) {
      mtt.error(fnDecl, "anonymous abstract function");
      continue;
    }
    const { parameterNames, tags } = mtt.getFunctionTypeJSDoc([fnDecl], []);
    if (hasExportingDecorator(fnDecl, mtt.typeChecker))
      tags.push({ tagName: "export" });
    const lhs = typeof name === "string" ? ts12.factory.createPropertyAccessExpression(instancePropAccess, name) : ts12.factory.createElementAccessExpression(instancePropAccess, name);
    const abstractFnDecl = ts12.factory.createExpressionStatement(ts12.factory.createAssignment(lhs, ts12.factory.createFunctionExpression(undefined, undefined, undefined, undefined, parameterNames.map((n) => ts12.factory.createParameterDeclaration(undefined, undefined, n)), undefined, ts12.factory.createBlock([]))));
    ts12.setSyntheticLeadingComments(abstractFnDecl, [
      toSynthesizedComment(tags)
    ]);
    propertyDecls.push(ts12.setSourceMapRange(abstractFnDecl, fnDecl));
  }
  const ifStmt = ts12.factory.createIfStatement(ts12.factory.createFalse(), ts12.factory.createBlock(propertyDecls, true));
  ts12.addSyntheticLeadingComment(ifStmt, ts12.SyntaxKind.MultiLineCommentTrivia, " istanbul ignore if ", true);
  return ifStmt;
}
function propertyName(prop) {
  if (!prop.name)
    return null;
  switch (prop.name.kind) {
    case ts12.SyntaxKind.Identifier:
      return getIdentifierText(prop.name);
    case ts12.SyntaxKind.StringLiteral:
      const text = prop.name.text;
      if (!isValidClosurePropertyName(text))
        return null;
      return text;
    default:
      return null;
  }
}
function escapeForComment(str) {
  return str.replace(/\/\*/g, "__").replace(/\*\//g, "__");
}
function createClosurePropertyDeclaration(mtt, expr, prop, optional) {
  const name = propertyName(prop);
  if (!name) {
    if (ts12.isPrivateIdentifier(prop.name)) {
      return createMultiLineComment(prop, `Skipping private member:
${escapeForComment(prop.getText())}`);
    } else {
      mtt.debugWarn(prop, `handle unnamed member:
${escapeForComment(prop.getText())}`);
      return createMultiLineComment(prop, `Skipping unnamed member:
${escapeForComment(prop.getText())}`);
    }
  }
  if (name === "prototype") {
    return createMultiLineComment(prop, `Skipping illegal member name:
${escapeForComment(prop.getText())}`);
  }
  let type = mtt.typeToClosure(prop);
  if (optional && type === "?")
    type += "|undefined";
  const tags = mtt.getJSDoc(prop, false);
  const flags = ts12.getCombinedModifierFlags(prop);
  const isReadonly = !!(flags & ts12.ModifierFlags.Readonly);
  tags.push({ tagName: isReadonly ? "const" : "type", type });
  if (hasExportingDecorator(prop, mtt.typeChecker)) {
    tags.push({ tagName: "export" });
  } else if (flags & ts12.ModifierFlags.Protected) {
    tags.push({ tagName: "protected" });
  } else if (flags & ts12.ModifierFlags.Private) {
    tags.push({ tagName: "private" });
  } else if (!tags.find((t) => t.tagName === "export" || t.tagName === "package")) {
    tags.push({ tagName: "public" });
  }
  const declStmt = ts12.setSourceMapRange(ts12.factory.createExpressionStatement(ts12.factory.createPropertyAccessExpression(expr, name)), prop);
  addCommentOn(declStmt, tags, TAGS_CONFLICTING_WITH_TYPE);
  return declStmt;
}
function removeTypeAssertions() {
  return (context) => {
    return (sourceFile) => {
      function visitor(node) {
        switch (node.kind) {
          case ts12.SyntaxKind.TypeAssertionExpression:
          case ts12.SyntaxKind.AsExpression:
            return ts12.visitNode(node.expression, visitor);
          case ts12.SyntaxKind.NonNullExpression:
            return ts12.visitNode(node.expression, visitor);
          default:
            break;
        }
        return ts12.visitEachChild(node, visitor, context);
      }
      return visitor(sourceFile);
    };
  };
}
function containsAsync(node) {
  if (ts12.isFunctionLike(node) && hasModifierFlag(node, ts12.ModifierFlags.Async)) {
    return true;
  }
  return ts12.forEachChild(node, containsAsync) || false;
}
function containsOptionalChainingOperator(node) {
  let maybePropertyAccessChain = node;
  while (ts12.isPropertyAccessExpression(maybePropertyAccessChain) || ts12.isNonNullExpression(maybePropertyAccessChain) || ts12.isCallExpression(maybePropertyAccessChain) || ts12.isElementAccessExpression(maybePropertyAccessChain)) {
    if (!ts12.isNonNullExpression(maybePropertyAccessChain) && maybePropertyAccessChain.questionDotToken != null) {
      return true;
    }
    maybePropertyAccessChain = maybePropertyAccessChain.expression;
  }
  return false;
}
function jsdocTransformer(host, tsOptions, typeChecker, diagnostics) {
  return (context) => {
    return (sourceFile) => {
      const moduleTypeTranslator = new ModuleTypeTranslator(sourceFile, typeChecker, host, diagnostics, false);
      const expandedStarImports = new Set;
      let contextThisType = null;
      let emitNarrowedTypes = true;
      function visitClassDeclaration(classDecl) {
        const contextThisTypeBackup = contextThisType;
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(classDecl);
        if (hasModifierFlag(classDecl, ts12.ModifierFlags.Abstract)) {
          mjsdoc.tags.push({ tagName: "abstract" });
        }
        maybeAddTemplateClause(mjsdoc.tags, classDecl);
        if (!host.untyped) {
          maybeAddHeritageClauses(mjsdoc.tags, moduleTypeTranslator, classDecl);
        }
        mjsdoc.updateComment(TAGS_CONFLICTING_WITH_TYPE);
        const decls = [];
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, classDecl);
        decls.push(ts12.visitEachChild(classDecl, visitor, context));
        if (memberDecl)
          decls.push(memberDecl);
        contextThisType = contextThisTypeBackup;
        return decls;
      }
      function visitHeritageClause(heritageClause) {
        if (heritageClause.token !== ts12.SyntaxKind.ExtendsKeyword || !heritageClause.parent || heritageClause.parent.kind === ts12.SyntaxKind.InterfaceDeclaration) {
          return ts12.visitEachChild(heritageClause, visitor, context);
        }
        if (heritageClause.types.length !== 1) {
          moduleTypeTranslator.error(heritageClause, `expected exactly one type in class extension clause`);
        }
        const type = heritageClause.types[0];
        let expr = type.expression;
        while (ts12.isParenthesizedExpression(expr) || ts12.isNonNullExpression(expr) || ts12.isAssertionExpression(expr)) {
          expr = expr.expression;
        }
        return ts12.factory.updateHeritageClause(heritageClause, [
          ts12.factory.updateExpressionWithTypeArguments(type, expr, type.typeArguments || [])
        ]);
      }
      function visitInterfaceDeclaration(iface) {
        const sym = typeChecker.getSymbolAtLocation(iface.name);
        if (!sym) {
          moduleTypeTranslator.error(iface, "interface with no symbol");
          return [];
        }
        if (symbolIsValue(typeChecker, sym) && !isMergedDeclaration(iface)) {
          moduleTypeTranslator.debugWarn(iface, `type/symbol conflict for ${sym.name}, using {?} for now`);
          return [
            createSingleLineComment(iface, "WARNING: interface has both a type and a value, skipping emit")
          ];
        }
        const tags = moduleTypeTranslator.getJSDoc(iface, true) || [];
        tags.push({ tagName: "record" });
        maybeAddTemplateClause(tags, iface);
        if (!host.untyped) {
          maybeAddHeritageClauses(tags, moduleTypeTranslator, iface);
        }
        const name = getIdentifierText(iface.name);
        const modifiers = hasModifierFlag(iface, ts12.ModifierFlags.Export) ? [ts12.factory.createToken(ts12.SyntaxKind.ExportKeyword)] : undefined;
        const decl = ts12.setSourceMapRange(ts12.factory.createFunctionDeclaration(modifiers, undefined, name, undefined, [], undefined, ts12.factory.createBlock([])), iface);
        addCommentOn(decl, tags, TAGS_CONFLICTING_WITH_TYPE);
        const isFirstOccurrence = getPreviousDeclaration(sym, iface) === null;
        const declarations = [];
        if (isFirstOccurrence)
          declarations.push(decl);
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, iface);
        if (memberDecl)
          declarations.push(memberDecl);
        return declarations;
      }
      function visitFunctionLikeDeclaration(fnDecl) {
        if (!fnDecl.body) {
          return ts12.visitEachChild(fnDecl, visitor, context);
        }
        const extraTags = [];
        if (hasExportingDecorator(fnDecl, typeChecker))
          extraTags.push({ tagName: "export" });
        const { tags, thisReturnType } = moduleTypeTranslator.getFunctionTypeJSDoc([fnDecl], extraTags);
        const isDownlevellingAsync = tsOptions.target !== undefined && tsOptions.target <= ts12.ScriptTarget.ES2018;
        const isFunction = fnDecl.kind === ts12.SyntaxKind.FunctionDeclaration;
        const hasExistingThisTag = tags.some((t) => t.tagName === "this");
        if (isDownlevellingAsync && isFunction && !hasExistingThisTag && containsAsync(fnDecl)) {
          tags.push({ tagName: "this", type: "*" });
        }
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(fnDecl);
        mjsdoc.tags = tags;
        mjsdoc.updateComment();
        const contextThisTypeBackup = contextThisType;
        if (!ts12.isArrowFunction(fnDecl))
          contextThisType = thisReturnType;
        fnDecl = ts12.visitEachChild(fnDecl, visitor, context);
        contextThisType = contextThisTypeBackup;
        if (!fnDecl.body) {
          return fnDecl;
        }
        const bindingAliases = [];
        const updatedParams = [];
        let hasUpdatedParams = false;
        for (const param of fnDecl.parameters) {
          if (!ts12.isArrayBindingPattern(param.name)) {
            updatedParams.push(param);
            continue;
          }
          const updatedParamName = renameArrayBindings(param.name, bindingAliases);
          if (!updatedParamName) {
            updatedParams.push(param);
            continue;
          }
          hasUpdatedParams = true;
          updatedParams.push(ts12.factory.updateParameterDeclaration(param, param.modifiers, param.dotDotDotToken, updatedParamName, param.questionToken, param.type, param.initializer));
        }
        if (!hasUpdatedParams || bindingAliases.length === 0)
          return fnDecl;
        let body = fnDecl.body;
        const stmts = createArrayBindingAliases(ts12.NodeFlags.Let, bindingAliases);
        if (!ts12.isBlock(body)) {
          stmts.push(ts12.factory.createReturnStatement(ts12.factory.createParenthesizedExpression(body)));
          body = ts12.factory.createBlock(stmts, true);
        } else {
          stmts.push(...body.statements);
          body = ts12.factory.updateBlock(body, stmts);
        }
        switch (fnDecl.kind) {
          case ts12.SyntaxKind.FunctionDeclaration:
            fnDecl = ts12.factory.updateFunctionDeclaration(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts12.SyntaxKind.MethodDeclaration:
            fnDecl = ts12.factory.updateMethodDeclaration(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.questionToken, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts12.SyntaxKind.SetAccessor:
            fnDecl = ts12.factory.updateSetAccessorDeclaration(fnDecl, fnDecl.modifiers, fnDecl.name, updatedParams, body);
            break;
          case ts12.SyntaxKind.Constructor:
            fnDecl = ts12.factory.updateConstructorDeclaration(fnDecl, fnDecl.modifiers, updatedParams, body);
            break;
          case ts12.SyntaxKind.FunctionExpression:
            fnDecl = ts12.factory.updateFunctionExpression(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts12.SyntaxKind.ArrowFunction:
            fnDecl = ts12.factory.updateArrowFunction(fnDecl, fnDecl.modifiers, fnDecl.name, updatedParams, fnDecl.type, fnDecl.equalsGreaterThanToken, body);
            break;
          case ts12.SyntaxKind.GetAccessor:
            moduleTypeTranslator.error(fnDecl, `get accessors cannot have parameters`);
            break;
          default:
            moduleTypeTranslator.error(fnDecl, `unexpected function like declaration`);
            break;
        }
        return fnDecl;
      }
      function visitThisExpression(node) {
        if (!contextThisType)
          return ts12.visitEachChild(node, visitor, context);
        return createClosureCast(node, node, contextThisType);
      }
      function visitVariableStatement(varStmt) {
        const stmts = [];
        const flags = ts12.getCombinedNodeFlags(varStmt.declarationList);
        let tags = moduleTypeTranslator.getJSDoc(varStmt, true);
        const leading = ts12.getSyntheticLeadingComments(varStmt);
        if (leading) {
          const commentHolder = ts12.factory.createNotEmittedStatement(varStmt);
          ts12.setSyntheticLeadingComments(commentHolder, leading.filter((c) => c.text[0] !== "*"));
          stmts.push(commentHolder);
        }
        const isExported = varStmt.modifiers?.some((modifier) => modifier.kind === ts12.SyntaxKind.ExportKeyword);
        for (const decl of varStmt.declarationList.declarations) {
          const localTags = [];
          if (tags) {
            localTags.push(...tags);
            tags = null;
          }
          if (ts12.isIdentifier(decl.name)) {
            const initializersMarkedAsUnknown = !!decl.initializer && moduleTypeTranslator.isAlwaysUnknownSymbol(decl);
            if (!initializersMarkedAsUnknown && decl.initializer?.kind !== ts12.SyntaxKind.ClassExpression) {
              const typeStr = moduleTypeTranslator.typeToClosure(decl);
              const defineTag = localTags.find(({ tagName }) => tagName === "define");
              if (defineTag) {
                defineTag.type = typeStr;
              } else {
                localTags.push({ tagName: "type", type: typeStr });
              }
            }
          } else if (ts12.isArrayBindingPattern(decl.name)) {
            const aliases = [];
            const updatedBinding = renameArrayBindings(decl.name, aliases);
            if (updatedBinding && aliases.length > 0) {
              const declVisited = ts12.visitNode(decl, visitor, ts12.isVariableDeclaration);
              const newDecl2 = ts12.factory.updateVariableDeclaration(declVisited, updatedBinding, declVisited.exclamationToken, declVisited.type, declVisited.initializer);
              const newStmt2 = ts12.factory.createVariableStatement(varStmt.modifiers?.filter((modifier) => modifier.kind !== ts12.SyntaxKind.ExportKeyword), ts12.factory.createVariableDeclarationList([newDecl2], flags));
              if (localTags.length) {
                addCommentOn(newStmt2, localTags, TAGS_CONFLICTING_WITH_TYPE);
              }
              stmts.push(newStmt2);
              stmts.push(...createArrayBindingAliases(varStmt.declarationList.flags, aliases, isExported));
              continue;
            }
          }
          const newDecl = ts12.setEmitFlags(ts12.visitNode(decl, visitor, ts12.isVariableDeclaration), ts12.EmitFlags.NoComments);
          const newStmt = ts12.factory.createVariableStatement(varStmt.modifiers, ts12.factory.createVariableDeclarationList([newDecl], flags));
          if (localTags.length)
            addCommentOn(newStmt, localTags, TAGS_CONFLICTING_WITH_TYPE);
          stmts.push(newStmt);
        }
        return stmts;
      }
      function shouldEmitExportsAssignments() {
        return tsOptions.module === ts12.ModuleKind.CommonJS;
      }
      function visitTypeAliasDeclaration(typeAlias) {
        const sym = moduleTypeTranslator.mustGetSymbolAtLocation(typeAlias.name);
        if (symbolIsValue(typeChecker, sym))
          return [];
        if (!shouldEmitExportsAssignments())
          return [];
        const typeName = getIdentifierText(typeAlias.name);
        moduleTypeTranslator.newTypeTranslator(typeAlias).markTypeParameterAsUnknown(moduleTypeTranslator.symbolsToAliasedNames, typeAlias.typeParameters);
        const typeStr = host.untyped ? "?" : moduleTypeTranslator.typeToClosure(typeAlias, undefined);
        const tags = moduleTypeTranslator.getJSDoc(typeAlias, true);
        tags.push({ tagName: "typedef", type: typeStr });
        let propertyBase = null;
        if (hasModifierFlag(typeAlias, ts12.ModifierFlags.Export)) {
          propertyBase = "exports";
        }
        const ns = getTransformedNs(typeAlias);
        if (ns !== null && ts12.getOriginalNode(typeAlias).parent.parent === ns && ts12.isIdentifier(ns.name)) {
          propertyBase = getIdentifierText(ns.name);
        }
        let decl;
        if (propertyBase !== null) {
          decl = ts12.factory.createExpressionStatement(ts12.factory.createPropertyAccessExpression(ts12.factory.createIdentifier(propertyBase), ts12.factory.createIdentifier(typeName)));
        } else {
          decl = ts12.factory.createVariableStatement(undefined, ts12.factory.createVariableDeclarationList([
            ts12.factory.createVariableDeclaration(ts12.factory.createIdentifier(typeName))
          ]));
        }
        decl = ts12.setSourceMapRange(decl, typeAlias);
        addCommentOn(decl, tags, TAGS_CONFLICTING_WITH_TYPE);
        return [decl];
      }
      function createClosureCast(context2, expression, type) {
        const inner = ts12.factory.createParenthesizedExpression(expression);
        const comment = addCommentOn(inner, [
          {
            tagName: "type",
            type: moduleTypeTranslator.typeToClosure(context2, type)
          }
        ]);
        comment.hasTrailingNewLine = false;
        return ts12.setSourceMapRange(ts12.factory.createParenthesizedExpression(inner), context2);
      }
      function visitAssertionExpression(assertion) {
        const type = typeChecker.getTypeAtLocation(assertion.type);
        return createClosureCast(assertion, ts12.visitEachChild(assertion, visitor, context), type);
      }
      function visitNonNullExpression(nonNull) {
        if (containsOptionalChainingOperator(nonNull)) {
          return nonNull.expression;
        }
        const type = typeChecker.getTypeAtLocation(nonNull.expression);
        const nonNullType = typeChecker.getNonNullableType(type);
        return createClosureCast(nonNull, ts12.visitEachChild(nonNull, visitor, context), nonNullType);
      }
      function getNarrowedType(node) {
        if (node.kind === ts12.SyntaxKind.SuperKeyword)
          return;
        if (node.kind === ts12.SyntaxKind.ThisKeyword)
          return;
        const symbol = typeChecker.getSymbolAtLocation(node);
        if (symbol?.declarations === undefined || symbol.declarations.length === 0 || symbol.declarations.some((decl) => ts12.isClassDeclaration(decl) || ts12.isInterfaceDeclaration(decl) || ts12.isModuleDeclaration(decl))) {
          return;
        }
        const typeAtUsage = typeChecker.getTypeAtLocation(node);
        const notNullableType = typeChecker.getNonNullableType(typeAtUsage);
        for (const decl of symbol.declarations) {
          const declaredType = typeChecker.getTypeOfSymbolAtLocation(symbol, decl);
          if (typeAtUsage !== declaredType && notNullableType !== typeChecker.getNonNullableType(declaredType) && moduleTypeTranslator.typeToClosure(node, typeAtUsage) !== "?") {
            return typeAtUsage;
          }
        }
        return;
      }
      function visitPropertyAccessExpression(node) {
        if (!emitNarrowedTypes || containsOptionalChainingOperator(node)) {
          return ts12.visitEachChild(node, visitor, context);
        }
        const objType = getNarrowedType(node.expression);
        if (objType === undefined) {
          return ts12.visitEachChild(node, visitor, context);
        }
        const propertyAccessWithCast = ts12.factory.updatePropertyAccessExpression(node, createClosureCast(node.expression, ts12.visitEachChild(node.expression, visitor, context), objType), node.name);
        const propType = getNarrowedType(node);
        if (propType === undefined) {
          return propertyAccessWithCast;
        }
        return createClosureCast(node, propertyAccessWithCast, propType);
      }
      function visitImportDeclaration(importDecl) {
        if (!importDecl.importClause)
          return importDecl;
        const sym = typeChecker.getSymbolAtLocation(importDecl.moduleSpecifier);
        if (!sym)
          return importDecl;
        const importPath = importDecl.moduleSpecifier.text;
        moduleTypeTranslator.requireType(importDecl.moduleSpecifier, importPath, sym, !!importDecl.importClause.name);
        return importDecl;
      }
      function escapeIllegalJSDoc(node) {
        if (!ts12.getParseTreeNode(node))
          return;
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(node);
        mjsdoc.updateComment(TAGS_CONFLICTING_WITH_TYPE);
      }
      function shouldEmitValueExportForSymbol(sym) {
        if (sym.flags & ts12.SymbolFlags.Alias) {
          sym = typeChecker.getAliasedSymbol(sym);
        }
        if ((sym.flags & ts12.SymbolFlags.Value) === 0) {
          return false;
        }
        if (sym.flags & ts12.SymbolFlags.ConstEnum) {
          if (tsOptions.preserveConstEnums) {
            return !sym.valueDeclaration.getSourceFile().isDeclarationFile;
          } else {
            return false;
          }
        }
        return true;
      }
      function visitExportDeclaration(exportDecl) {
        const importedModuleSymbol = exportDecl.moduleSpecifier && typeChecker.getSymbolAtLocation(exportDecl.moduleSpecifier);
        if (importedModuleSymbol) {
          moduleTypeTranslator.requireType(exportDecl.moduleSpecifier, exportDecl.moduleSpecifier.text, importedModuleSymbol, false);
        }
        const typesToExport = [];
        if (!exportDecl.exportClause) {
          const currentModuleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
          const currentModuleExports = currentModuleSymbol && currentModuleSymbol.exports;
          if (!importedModuleSymbol) {
            moduleTypeTranslator.error(exportDecl, `export * without module symbol`);
            return exportDecl;
          }
          const exportedSymbols = typeChecker.getExportsOfModule(importedModuleSymbol);
          const exportSpecifiers = [];
          for (const sym of exportedSymbols) {
            if (currentModuleExports && currentModuleExports.has(sym.escapedName))
              continue;
            if (expandedStarImports.has(sym.name))
              continue;
            expandedStarImports.add(sym.name);
            if (shouldEmitValueExportForSymbol(sym)) {
              exportSpecifiers.push(ts12.factory.createExportSpecifier(false, undefined, sym.name));
            } else {
              typesToExport.push([sym.name, sym]);
            }
          }
          const isTypeOnlyExport = false;
          exportDecl = ts12.factory.updateExportDeclaration(exportDecl, exportDecl.modifiers, isTypeOnlyExport, ts12.factory.createNamedExports(exportSpecifiers), exportDecl.moduleSpecifier, exportDecl.attributes);
        } else if (ts12.isNamedExports(exportDecl.exportClause)) {
          for (const exp of exportDecl.exportClause.elements) {
            const exportedName = ts12.isIdentifier(exp.name) ? getIdentifierText(exp.name) : exp.name.text;
            typesToExport.push([
              exportedName,
              moduleTypeTranslator.mustGetSymbolAtLocation(exp.name)
            ]);
          }
        }
        if (host.untyped)
          return exportDecl;
        const result = [exportDecl];
        for (const [exportedName, sym] of typesToExport) {
          let aliasedSymbol = sym;
          if (sym.flags & ts12.SymbolFlags.Alias) {
            aliasedSymbol = typeChecker.getAliasedSymbol(sym);
          }
          const isTypeAlias = (aliasedSymbol.flags & ts12.SymbolFlags.Value) === 0 && (aliasedSymbol.flags & (ts12.SymbolFlags.TypeAlias | ts12.SymbolFlags.Interface)) !== 0;
          const isConstEnum = (aliasedSymbol.flags & ts12.SymbolFlags.ConstEnum) !== 0;
          if (!isTypeAlias && !isConstEnum)
            continue;
          const typeName = moduleTypeTranslator.symbolsToAliasedNames.get(aliasedSymbol) || aliasedSymbol.name;
          const stmt = ts12.factory.createExpressionStatement(ts12.factory.createPropertyAccessExpression(ts12.factory.createIdentifier("exports"), exportedName));
          addCommentOn(stmt, [{ tagName: "typedef", type: "!" + typeName }]);
          ts12.addSyntheticTrailingComment(stmt, ts12.SyntaxKind.SingleLineCommentTrivia, " re-export typedef", true);
          result.push(stmt);
        }
        return result;
      }
      function getExportDeclarationNames(node) {
        switch (node.kind) {
          case ts12.SyntaxKind.VariableStatement:
            const varDecl = node;
            return varDecl.declarationList.declarations.map((d) => getExportDeclarationNames(d)[0]);
          case ts12.SyntaxKind.VariableDeclaration:
          case ts12.SyntaxKind.FunctionDeclaration:
          case ts12.SyntaxKind.InterfaceDeclaration:
          case ts12.SyntaxKind.ClassDeclaration:
          case ts12.SyntaxKind.ModuleDeclaration:
          case ts12.SyntaxKind.EnumDeclaration:
            const decl = node;
            if (!decl.name || decl.name.kind !== ts12.SyntaxKind.Identifier) {
              break;
            }
            return [decl.name];
          case ts12.SyntaxKind.TypeAliasDeclaration:
            const typeAlias = node;
            return [typeAlias.name];
          default:
            break;
        }
        moduleTypeTranslator.error(node, `unsupported export declaration ${ts12.SyntaxKind[node.kind]}: ${node.getText()}`);
        return [];
      }
      function visitExportedAmbient(node) {
        if (host.untyped || !shouldEmitExportsAssignments())
          return [node];
        const declNames = getExportDeclarationNames(node);
        const result = [node];
        for (const decl of declNames) {
          const sym = typeChecker.getSymbolAtLocation(decl);
          if (!symbolIsValue(typeChecker, sym)) {
            if (node.kind === ts12.SyntaxKind.ModuleDeclaration)
              continue;
            const mangledName = moduleNameAsIdentifier(host, sourceFile.fileName);
            const declName = getIdentifierText(decl);
            const stmt = ts12.factory.createExpressionStatement(ts12.factory.createPropertyAccessExpression(ts12.factory.createIdentifier("exports"), declName));
            addCommentOn(stmt, [
              { tagName: "typedef", type: `!${mangledName}.${declName}` }
            ]);
            result.push(stmt);
          }
        }
        return result;
      }
      let aliasCounter = 1;
      function renameArrayBindings(node, aliases) {
        const updatedElements = [];
        for (const e of node.elements) {
          if (ts12.isOmittedExpression(e)) {
            updatedElements.push(e);
            continue;
          } else if (ts12.isObjectBindingPattern(e.name)) {
            return;
          }
          let updatedBindingName;
          if (ts12.isArrayBindingPattern(e.name)) {
            updatedBindingName = renameArrayBindings(e.name, aliases);
            if (!updatedBindingName)
              return;
          } else {
            const aliasName = ts12.factory.createIdentifier(`${e.name.text}__tsickle_destructured_${aliasCounter++}`);
            aliases.push([e.name, aliasName]);
            updatedBindingName = aliasName;
          }
          updatedElements.push(ts12.factory.updateBindingElement(e, e.dotDotDotToken, ts12.visitNode(e.propertyName, visitor, ts12.isPropertyName), updatedBindingName, ts12.visitNode(e.initializer, visitor)));
        }
        return ts12.factory.updateArrayBindingPattern(node, updatedElements);
      }
      function createArrayBindingAliases(flags, aliases, needsExport = false) {
        const aliasDecls = [];
        for (const [oldName, aliasName] of aliases) {
          const typeStr = moduleTypeTranslator.typeToClosure(ts12.getOriginalNode(oldName));
          const closureCastExpr = ts12.factory.createParenthesizedExpression(aliasName);
          addCommentOn(closureCastExpr, [{ tagName: "type", type: typeStr }], undefined, false);
          const varDeclList = ts12.factory.createVariableDeclarationList([
            ts12.factory.createVariableDeclaration(oldName, undefined, undefined, closureCastExpr)
          ], flags);
          const varStmt = ts12.factory.createVariableStatement(needsExport ? [ts12.factory.createModifier(ts12.SyntaxKind.ExportKeyword)] : undefined, varDeclList);
          aliasDecls.push(varStmt);
        }
        return aliasDecls;
      }
      function visitForOfStatement(node) {
        const varDecls = node.initializer;
        if (!ts12.isVariableDeclarationList(varDecls)) {
          return ts12.visitEachChild(node, visitor, context);
        }
        if (varDecls.declarations.length !== 1) {
          return ts12.visitEachChild(node, visitor, context);
        }
        const varDecl = varDecls.declarations[0];
        if (!ts12.isArrayBindingPattern(varDecl.name)) {
          return ts12.visitEachChild(node, visitor, context);
        }
        const aliases = [];
        const updatedPattern = renameArrayBindings(varDecl.name, aliases);
        if (!updatedPattern || aliases.length === 0) {
          return ts12.visitEachChild(node, visitor, context);
        }
        const updatedInitializer = ts12.factory.updateVariableDeclarationList(varDecls, [
          ts12.factory.updateVariableDeclaration(varDecl, updatedPattern, varDecl.exclamationToken, varDecl.type, varDecl.initializer)
        ]);
        const aliasDecls = createArrayBindingAliases(varDecls.flags, aliases);
        let updatedStatement;
        if (ts12.isBlock(node.statement)) {
          updatedStatement = ts12.factory.updateBlock(node.statement, [
            ...aliasDecls,
            ...ts12.visitNode(node.statement, visitor, ts12.isBlock).statements
          ]);
        } else {
          updatedStatement = ts12.factory.createBlock([
            ...aliasDecls,
            ts12.visitNode(node.statement, visitor)
          ]);
        }
        return ts12.factory.updateForOfStatement(node, node.awaitModifier, updatedInitializer, ts12.visitNode(node.expression, visitor), updatedStatement);
      }
      function visitor(node) {
        if (isAmbient(node)) {
          if (!hasModifierFlag(node, ts12.ModifierFlags.Export)) {
            return node;
          }
          return visitExportedAmbient(node);
        }
        switch (node.kind) {
          case ts12.SyntaxKind.ImportDeclaration:
            return visitImportDeclaration(node);
          case ts12.SyntaxKind.ExportDeclaration:
            return visitExportDeclaration(node);
          case ts12.SyntaxKind.ClassDeclaration:
            return visitClassDeclaration(node);
          case ts12.SyntaxKind.InterfaceDeclaration:
            return visitInterfaceDeclaration(node);
          case ts12.SyntaxKind.HeritageClause:
            return visitHeritageClause(node);
          case ts12.SyntaxKind.ArrowFunction:
          case ts12.SyntaxKind.FunctionExpression:
            return ts12.factory.createParenthesizedExpression(visitFunctionLikeDeclaration(node));
          case ts12.SyntaxKind.Constructor:
          case ts12.SyntaxKind.FunctionDeclaration:
          case ts12.SyntaxKind.MethodDeclaration:
          case ts12.SyntaxKind.GetAccessor:
          case ts12.SyntaxKind.SetAccessor:
            return visitFunctionLikeDeclaration(node);
          case ts12.SyntaxKind.ThisKeyword:
            return visitThisExpression(node);
          case ts12.SyntaxKind.VariableStatement:
            return visitVariableStatement(node);
          case ts12.SyntaxKind.ExpressionStatement:
          case ts12.SyntaxKind.PropertyAssignment:
          case ts12.SyntaxKind.PropertyDeclaration:
          case ts12.SyntaxKind.ModuleDeclaration:
          case ts12.SyntaxKind.EnumMember:
          case ts12.SyntaxKind.EnumDeclaration:
            escapeIllegalJSDoc(node);
            break;
          case ts12.SyntaxKind.Parameter:
            const paramDecl = node;
            if (hasModifierFlag(paramDecl, ts12.ModifierFlags.ParameterPropertyModifier)) {
              ts12.setSyntheticLeadingComments(paramDecl, []);
              suppressLeadingCommentsRecursively(paramDecl);
            }
            break;
          case ts12.SyntaxKind.TypeAliasDeclaration:
            return visitTypeAliasDeclaration(node);
          case ts12.SyntaxKind.AsExpression:
          case ts12.SyntaxKind.TypeAssertionExpression:
            return visitAssertionExpression(node);
          case ts12.SyntaxKind.NonNullExpression:
            return visitNonNullExpression(node);
          case ts12.SyntaxKind.PropertyAccessExpression:
            return visitPropertyAccessExpression(node);
          case ts12.SyntaxKind.ForOfStatement:
            return visitForOfStatement(node);
          case ts12.SyntaxKind.DeleteExpression:
            emitNarrowedTypes = false;
            const visited = ts12.visitEachChild(node, visitor, context);
            emitNarrowedTypes = true;
            return visited;
          default:
            break;
        }
        return ts12.visitEachChild(node, visitor, context);
      }
      sourceFile = ts12.visitEachChild(sourceFile, visitor, context);
      return moduleTypeTranslator.insertAdditionalImports(sourceFile);
    };
  };
}

// src/tsickle/externs.ts
var PREDECLARED_CLOSURE_EXTERNS_LIST = [
  "exports",
  "global",
  "module",
  "ErrorConstructor",
  "Symbol",
  "WorkerGlobalScope"
];
var EXTERNS_HEADER = `/**
 * @externs
 * @suppress {checkTypes,const,duplicate,missingOverride}
 */
// NOTE: generated by tsickle, do not edit.
`;
function getGeneratedExterns(externs, rootDir) {
  let allExterns = EXTERNS_HEADER;
  for (const fileName of Object.keys(externs)) {
    const srcPath = relative(rootDir, fileName);
    allExterns += `// ${createGeneratedFromComment(srcPath)}
`;
    allExterns += externs[fileName].output;
  }
  return allExterns;
}
function isInGlobalAugmentation(declaration) {
  if (!declaration.parent || !declaration.parent.parent)
    return false;
  return (declaration.parent.parent.flags & ts13.NodeFlags.GlobalAugmentation) !== 0;
}
function generateExterns(typeChecker, sourceFile, host) {
  let output = "";
  const diagnostics = [];
  const isDts = isDtsFileName(sourceFile.fileName);
  const isExternalModule3 = ts13.isExternalModule(sourceFile);
  let moduleNamespace = "";
  if (isExternalModule3) {
    moduleNamespace = moduleNameAsIdentifier(host, sourceFile.fileName);
  }
  let rootNamespace = moduleNamespace;
  const exportAssignment = sourceFile.statements.find(ts13.isExportAssignment);
  const hasExportEquals = exportAssignment && exportAssignment.isExportEquals;
  if (hasExportEquals) {
    rootNamespace = rootNamespace + "_";
  }
  const mtt = new ModuleTypeTranslator(sourceFile, typeChecker, host, diagnostics, true, hasExportEquals);
  for (const stmt of sourceFile.statements) {
    importsVisitor(stmt);
    if (!isDts && !hasModifierFlag(stmt, ts13.ModifierFlags.Ambient)) {
      continue;
    }
    visitor(stmt, []);
  }
  function qualifiedNameToMangledIdentifier(name) {
    const entityName = getEntityNameText(name);
    let symbol = typeChecker.getSymbolAtLocation(name);
    if (symbol) {
      if (symbol.flags & ts13.SymbolFlags.Alias) {
        symbol = typeChecker.getAliasedSymbol(symbol);
      }
      const alias = mtt.symbolsToAliasedNames.get(symbol);
      if (alias)
        return alias;
      const isGlobalSymbol = symbol && symbol.declarations && symbol.declarations.some((d) => {
        if (isInGlobalAugmentation(d))
          return true;
        return !ts13.isExternalModule(d.getSourceFile());
      });
      if (isGlobalSymbol)
        return entityName;
    }
    return rootNamespace + "." + entityName;
  }
  if (output && isExternalModule3) {
    output = `/** @const */
var ${rootNamespace} = {};
` + output;
    let exportedNamespace = rootNamespace;
    if (exportAssignment && hasExportEquals) {
      if (ts13.isIdentifier(exportAssignment.expression) || ts13.isQualifiedName(exportAssignment.expression)) {
        exportedNamespace = qualifiedNameToMangledIdentifier(exportAssignment.expression);
      } else {
        reportDiagnostic(diagnostics, exportAssignment.expression, `export = expression must be a qualified name, got ${ts13.SyntaxKind[exportAssignment.expression.kind]}.`);
      }
      emit(`/**
 * export = ${exportAssignment.expression.getText()}
 * @const
 */
`);
      emit(`var ${moduleNamespace} = ${exportedNamespace};
`);
    }
    if (isDts && host.provideExternalModuleDtsNamespace) {
      for (const nsExport of sourceFile.statements.filter(ts13.isNamespaceExportDeclaration)) {
        const namespaceName = getIdentifierText(nsExport.name);
        emit(`// export as namespace ${namespaceName}
`);
        writeVariableStatement(namespaceName, [], exportedNamespace);
      }
    }
  }
  return { diagnostics, moduleNamespace, output };
  function emit(str) {
    output += str;
  }
  function isFirstValueDeclaration(decl) {
    if (!decl.name)
      return true;
    const sym = typeChecker.getSymbolAtLocation(decl.name);
    if (!sym.declarations || sym.declarations.length < 2)
      return true;
    const earlierDecls = sym.declarations.slice(0, sym.declarations.indexOf(decl));
    return earlierDecls.length === 0 || earlierDecls.every((d) => ts13.isVariableDeclaration(d) && d.getSourceFile() !== decl.getSourceFile());
  }
  function writeVariableStatement(name, namespace, value) {
    const qualifiedName = namespace.concat([name]).join(".");
    if (namespace.length === 0)
      emit(`var `);
    emit(qualifiedName);
    if (value)
      emit(` = ${value}`);
    emit(`;
`);
  }
  function writeVariableDeclaration(decl, namespace) {
    if (decl.name.kind === ts13.SyntaxKind.Identifier) {
      const name = getIdentifierText(decl.name);
      if (PREDECLARED_CLOSURE_EXTERNS_LIST.indexOf(name) >= 0)
        return;
      emit(toString([{ tagName: "type", type: mtt.typeToClosure(decl) }]));
      emit(`
`);
      writeVariableStatement(name, namespace);
    } else {
      errorUnimplementedKind(decl.name, "externs for variable");
    }
  }
  function emitFunctionType(decls, extraTags = []) {
    const { parameterNames, tags } = mtt.getFunctionTypeJSDoc(decls, extraTags);
    emit(`
`);
    emit(toString(tags));
    return parameterNames;
  }
  function writeFunction(name, params, namespace) {
    const paramsStr = params.join(", ");
    if (namespace.length > 0) {
      let fqn = namespace.join(".");
      if (name.kind === ts13.SyntaxKind.Identifier) {
        fqn += ".";
      }
      fqn += name.getText();
      emit(`${fqn} = function(${paramsStr}) {};
`);
    } else {
      if (name.kind !== ts13.SyntaxKind.Identifier) {
        reportDiagnostic(diagnostics, name, "Non-namespaced computed name in externs");
      }
      emit(`function ${name.getText()}(${paramsStr}) {}
`);
    }
  }
  function writeEnum(decl, namespace) {
    const name = getIdentifierText(decl.name);
    let members = "";
    const enumType = getEnumType(typeChecker, decl);
    const initializer = enumType === "string" ? `''` : 1;
    for (const member of decl.members) {
      let memberName;
      switch (member.name.kind) {
        case ts13.SyntaxKind.Identifier:
          memberName = getIdentifierText(member.name);
          break;
        case ts13.SyntaxKind.StringLiteral:
          const text = member.name.text;
          if (isValidClosurePropertyName(text))
            memberName = text;
          break;
        default:
          break;
      }
      if (!memberName) {
        members += `  /* TODO: ${ts13.SyntaxKind[member.name.kind]}: ${escapeForComment(member.name.getText())} */
`;
        continue;
      }
      members += `  ${memberName}: ${initializer},
`;
    }
    emit(`
/** @enum {${enumType}} */
`);
    writeVariableStatement(name, namespace, `{
${members}}`);
  }
  function handleLostProperties(decl, namespace) {
    let propNames = undefined;
    function collectPropertyNames(node) {
      if (ts13.isTypeLiteralNode(node)) {
        for (const m of node.members) {
          if (m.name && ts13.isIdentifier(m.name)) {
            propNames = propNames || new Set;
            propNames.add(getIdentifierText(m.name));
          }
        }
      }
      ts13.forEachChild(node, collectPropertyNames);
    }
    function findTypeIntersection(node) {
      if (ts13.isIntersectionTypeNode(node)) {
        ts13.forEachChild(node, collectPropertyNames);
      } else {
        ts13.forEachChild(node, findTypeIntersection);
      }
    }
    ts13.forEachChild(decl, findTypeIntersection);
    if (propNames) {
      const helperName = getIdentifierText(decl.name) + "_preventPropRenaming_doNotUse";
      emit(`
/** @typedef {{${[...propNames].map((p) => `${p}: ?`).join(", ")}}} */
`);
      writeVariableStatement(helperName, namespace);
    }
  }
  function writeTypeAlias(decl, namespace) {
    const typeStr = mtt.typeToClosure(decl, undefined);
    emit(`
/** @typedef {${typeStr}} */
`);
    writeVariableStatement(getIdentifierText(decl.name), namespace);
    handleLostProperties(decl, namespace);
  }
  function writeType(decl, namespace) {
    const name = decl.name;
    if (!name) {
      reportDiagnostic(diagnostics, decl, "anonymous type in externs");
      return;
    }
    if (name.escapedText === "gbigint" && decl.getSourceFile().fileName.endsWith("closure.lib.d.ts")) {
      return;
    }
    const typeName = namespace.concat([name.getText()]).join(".");
    if (PREDECLARED_CLOSURE_EXTERNS_LIST.indexOf(typeName) >= 0)
      return;
    if (isFirstValueDeclaration(decl)) {
      let paramNames = [];
      const jsdocTags = [];
      let wroteJsDoc = false;
      maybeAddHeritageClauses(jsdocTags, mtt, decl);
      maybeAddTemplateClause(jsdocTags, decl);
      if (decl.kind === ts13.SyntaxKind.ClassDeclaration) {
        jsdocTags.push({ tagName: "constructor" }, { tagName: "struct" });
        const ctors = getCtors(decl);
        if (ctors.length) {
          paramNames = emitFunctionType(ctors, jsdocTags);
          wroteJsDoc = true;
        }
      } else {
        jsdocTags.push({ tagName: "record" }, { tagName: "struct" });
      }
      if (!wroteJsDoc)
        emit(toString(jsdocTags));
      writeFunction(name, paramNames, namespace);
    }
    const methods = new Map;
    const accessors = new Map;
    for (const member of decl.members) {
      switch (member.kind) {
        case ts13.SyntaxKind.PropertySignature:
        case ts13.SyntaxKind.PropertyDeclaration:
          const prop = member;
          if (prop.name.kind === ts13.SyntaxKind.Identifier) {
            let type = mtt.typeToClosure(prop);
            if (prop.questionToken && type === "?") {
              type = "?|undefined";
            }
            const isReadonly = hasModifierFlag(prop, ts13.ModifierFlags.Readonly);
            emit(toString([
              { tagName: isReadonly ? "const" : "type", type }
            ]));
            if (hasModifierFlag(prop, ts13.ModifierFlags.Static)) {
              emit(`
${typeName}.${prop.name.getText()};
`);
            } else {
              emit(`
${typeName}.prototype.${prop.name.getText()};
`);
            }
            continue;
          }
          break;
        case ts13.SyntaxKind.GetAccessor:
        case ts13.SyntaxKind.SetAccessor:
          const accessor = member;
          if (accessor.name.kind === ts13.SyntaxKind.Identifier) {
            const name2 = accessor.name.getText();
            if (!accessors.has(name2) || accessor.kind === ts13.SyntaxKind.GetAccessor) {
              accessors.set(name2, accessor);
            }
            continue;
          }
          break;
        case ts13.SyntaxKind.MethodSignature:
        case ts13.SyntaxKind.MethodDeclaration:
          const method = member;
          const isStatic = hasModifierFlag(method, ts13.ModifierFlags.Static);
          const methodSignature = `${method.name.getText()}$$$${isStatic ? "static" : "instance"}`;
          if (methods.has(methodSignature)) {
            methods.get(methodSignature).push(method);
          } else {
            methods.set(methodSignature, [method]);
          }
          continue;
        case ts13.SyntaxKind.Constructor:
          continue;
        default:
          break;
      }
      let memberName = namespace;
      if (member.name) {
        memberName = memberName.concat([member.name.getText()]);
      }
      emit(`
/* TODO: ${ts13.SyntaxKind[member.kind]}: ${memberName.join(".")} */
`);
    }
    for (const [name2, accessor] of accessors.entries()) {
      const type = mtt.typeToClosure(accessor);
      emit(toString([{ tagName: "type", type }]));
      if (hasModifierFlag(accessor, ts13.ModifierFlags.Static)) {
        emit(`
${typeName}.${name2};
`);
      } else {
        emit(`
${typeName}.prototype.${name2};
`);
      }
    }
    for (const methodVariants of Array.from(methods.values())) {
      const firstMethodVariant = methodVariants[0];
      let parameterNames;
      if (methodVariants.length > 1) {
        parameterNames = emitFunctionType(methodVariants);
      } else {
        parameterNames = emitFunctionType([firstMethodVariant]);
      }
      const methodNamespace = namespace.concat([name.getText()]);
      if (!hasModifierFlag(firstMethodVariant, ts13.ModifierFlags.Static)) {
        methodNamespace.push("prototype");
      }
      writeFunction(firstMethodVariant.name, parameterNames, methodNamespace);
    }
  }
  function writeExportDeclaration(exportDeclaration, namespace) {
    if (!exportDeclaration.exportClause) {
      emit(`
// TODO(tsickle): export * declaration in ${debugLocationStr(exportDeclaration, namespace)}
`);
      return;
    }
    if (ts13.isNamespaceExport(exportDeclaration.exportClause)) {
      emit(`
// TODO(tsickle): export * as declaration in ${debugLocationStr(exportDeclaration, namespace)}
`);
      return;
    }
    for (const exportSpecifier of exportDeclaration.exportClause.elements) {
      if (!exportSpecifier.propertyName)
        continue;
      emit(`/** @const */
`);
      writeVariableStatement(exportSpecifier.name.text, namespace, namespace.join(".") + "." + exportSpecifier.propertyName.text);
    }
  }
  function getCtors(decl) {
    const currentCtors = decl.members.filter((m) => m.kind === ts13.SyntaxKind.Constructor);
    if (currentCtors.length) {
      return currentCtors;
    }
    if (decl.heritageClauses) {
      const baseSymbols = decl.heritageClauses.filter((h) => h.token === ts13.SyntaxKind.ExtendsKeyword).flatMap((h) => h.types).filter((t) => t.expression.kind === ts13.SyntaxKind.Identifier);
      for (const base of baseSymbols) {
        const sym = typeChecker.getSymbolAtLocation(base.expression);
        if (!sym || !sym.declarations)
          return [];
        for (const d of sym.declarations) {
          if (d.kind === ts13.SyntaxKind.ClassDeclaration) {
            return getCtors(d);
          }
        }
      }
    }
    return [];
  }
  function addImportAliases(decl) {
    if (ts13.isImportDeclaration(decl) && !decl.importClause)
      return;
    let moduleUri;
    if (ts13.isImportDeclaration(decl)) {
      moduleUri = decl.moduleSpecifier;
    } else if (ts13.isExternalModuleReference(decl.moduleReference)) {
      moduleUri = decl.moduleReference.expression;
    } else {
      return;
    }
    const importDiagnostics = isDts ? diagnostics : [];
    const moduleSymbol = typeChecker.getSymbolAtLocation(moduleUri);
    if (!moduleSymbol) {
      reportDiagnostic(importDiagnostics, moduleUri, `imported module has no symbol`);
      return;
    }
    const googNamespace = jsPathToNamespace(host, moduleUri, importDiagnostics, moduleUri.text, () => moduleSymbol);
    const isDefaultImport = ts13.isImportDeclaration(decl) && !!decl.importClause?.name;
    if (googNamespace) {
      mtt.registerImportSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, () => googNamespace);
    } else {
      mtt.registerImportSymbolAliases(undefined, isDefaultImport, moduleSymbol, getAliasPrefixForEsModule(moduleUri));
    }
  }
  function getAliasPrefixForEsModule(moduleUri) {
    const ambientModulePrefix = moduleNameAsIdentifier(host, moduleUri.text, sourceFile.fileName);
    const defaultPrefix = host.pathToModuleName(sourceFile.fileName, moduleUri.text);
    return (exportedSymbol) => {
      const isAmbientModuleDeclaration = exportedSymbol.declarations && exportedSymbol.declarations.some((d) => isAmbient(d) || d.getSourceFile().isDeclarationFile);
      return isAmbientModuleDeclaration ? ambientModulePrefix : defaultPrefix;
    };
  }
  function errorUnimplementedKind(node, where) {
    reportDiagnostic(diagnostics, node, `${ts13.SyntaxKind[node.kind]} not implemented in ${where}`);
  }
  function getNamespaceForTopLevelDeclaration(declaration, namespace) {
    if (namespace.length !== 0)
      return namespace;
    if (isDts && isExternalModule3)
      return [rootNamespace];
    if (hasModifierFlag(declaration, ts13.ModifierFlags.Export))
      return [rootNamespace];
    return [];
  }
  function debugLocationStr(node, namespace) {
    return namespace.join(".") || node.getSourceFile().fileName.replace(/.*[/\\]/, "");
  }
  function importsVisitor(node) {
    switch (node.kind) {
      case ts13.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node;
        if (importEquals.moduleReference.kind === ts13.SyntaxKind.ExternalModuleReference) {
          addImportAliases(importEquals);
        }
        break;
      case ts13.SyntaxKind.ImportDeclaration:
        addImportAliases(node);
        break;
      default:
        break;
    }
  }
  function visitor(node, namespace) {
    if (node.parent === sourceFile) {
      namespace = getNamespaceForTopLevelDeclaration(node, namespace);
    }
    switch (node.kind) {
      case ts13.SyntaxKind.ModuleDeclaration:
        const decl = node;
        switch (decl.name.kind) {
          case ts13.SyntaxKind.Identifier:
            if (decl.flags & ts13.NodeFlags.GlobalAugmentation) {
              namespace = [];
            } else {
              const name2 = getIdentifierText(decl.name);
              if (isFirstValueDeclaration(decl)) {
                emit(`/** @const */
`);
                writeVariableStatement(name2, namespace, "{}");
              }
              namespace = namespace.concat(name2);
            }
            if (decl.body)
              visitor(decl.body, namespace);
            break;
          case ts13.SyntaxKind.StringLiteral:
            const importName = decl.name.text;
            const mangled = moduleNameAsIdentifier(host, importName, sourceFile.fileName);
            emit(`// Derived from: declare module "${importName}"
`);
            namespace = [mangled];
            if (isFirstValueDeclaration(decl)) {
              emit(`/** @const */
`);
              writeVariableStatement(mangled, [], "{}");
            }
            if (decl.body)
              visitor(decl.body, [mangled]);
            break;
          default:
            errorUnimplementedKind(decl.name, "externs generation of namespace");
            break;
        }
        break;
      case ts13.SyntaxKind.ModuleBlock:
        const block = node;
        for (const stmt of block.statements) {
          visitor(stmt, namespace);
        }
        break;
      case ts13.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node;
        if (importEquals.moduleReference.kind === ts13.SyntaxKind.ExternalModuleReference) {
          break;
        }
        const localName = getIdentifierText(importEquals.name);
        const qn = qualifiedNameToMangledIdentifier(importEquals.moduleReference);
        emit(`/** @const */
`);
        writeVariableStatement(localName, namespace, qn);
        break;
      case ts13.SyntaxKind.ClassDeclaration:
      case ts13.SyntaxKind.InterfaceDeclaration:
        writeType(node, namespace);
        break;
      case ts13.SyntaxKind.FunctionDeclaration:
        const fnDecl = node;
        const name = fnDecl.name;
        if (!name) {
          reportDiagnostic(diagnostics, fnDecl, "anonymous function in externs");
          break;
        }
        const sym = typeChecker.getSymbolAtLocation(name);
        const decls = sym.declarations.filter(ts13.isFunctionDeclaration);
        if (fnDecl !== decls[0])
          break;
        const params = emitFunctionType(decls);
        writeFunction(name, params, namespace);
        break;
      case ts13.SyntaxKind.VariableStatement:
        for (const decl2 of node.declarationList.declarations) {
          writeVariableDeclaration(decl2, namespace);
        }
        break;
      case ts13.SyntaxKind.EnumDeclaration:
        writeEnum(node, namespace);
        break;
      case ts13.SyntaxKind.TypeAliasDeclaration:
        writeTypeAlias(node, namespace);
        break;
      case ts13.SyntaxKind.ImportDeclaration:
        break;
      case ts13.SyntaxKind.NamespaceExportDeclaration:
      case ts13.SyntaxKind.ExportAssignment:
        break;
      case ts13.SyntaxKind.ExportDeclaration:
        const exportDeclaration = node;
        writeExportDeclaration(exportDeclaration, namespace);
        break;
      default:
        emit(`
// TODO(tsickle): ${ts13.SyntaxKind[node.kind]} in ${debugLocationStr(node, namespace)}
`);
        break;
    }
  }
}

// src/tsickle/fileoverview-comment-transformer.ts
var ts14 = __toESM(require("typescript"));
var FILEOVERVIEW_COMMENT_MARKERS = new Set([
  "fileoverview",
  "externs",
  "modName",
  "mods",
  "pintomodule"
]);
function augmentFileoverviewComments(options, source, tags, generateExtraSuppressions) {
  let fileOverview = tags.find((t) => t.tagName === "fileoverview");
  if (!fileOverview) {
    fileOverview = { tagName: "fileoverview", text: "added by tsickle" };
    tags.splice(0, 0, fileOverview);
  }
  if (options.rootDir != null) {
    const GENERATED_FROM_COMMENT_TEXT = `
${createGeneratedFromComment(relative(options.rootDir, source.fileName))}`;
    fileOverview.text = fileOverview.text ? fileOverview.text + GENERATED_FROM_COMMENT_TEXT : GENERATED_FROM_COMMENT_TEXT;
  }
  if (generateExtraSuppressions) {
    const suppressions = [
      "checkTypes",
      "extraRequire",
      "missingRequire",
      "uselessCode",
      "suspiciousCode",
      "missingReturn",
      "unusedPrivateMembers",
      "missingOverride",
      "const"
    ];
    const suppressTags = suppressions.map((s) => ({
      tagName: "suppress",
      text: "added by tsickle",
      type: s
    }));
    const licenseTagIndex = tags.findIndex((t) => t.tagName === "license");
    if (licenseTagIndex !== -1) {
      tags.splice(licenseTagIndex, 0, ...suppressTags);
    } else {
      tags.push(...suppressTags);
    }
  }
}
function transformFileoverviewCommentFactory(options, diagnostics, generateExtraSuppressions) {
  return () => {
    function checkNoFileoverviewComments(context, comments, message) {
      for (const comment of comments) {
        const parse2 = parse(comment);
        if (parse2 !== null && parse2.tags.some((t) => FILEOVERVIEW_COMMENT_MARKERS.has(t.tagName))) {
          reportDiagnostic(diagnostics, context, message, comment.originalRange, ts14.DiagnosticCategory.Warning);
        }
      }
    }
    return (sourceFile) => {
      if (!sourceFile.fileName.match(/\.tsx?$/)) {
        return sourceFile;
      }
      const text = sourceFile.getFullText();
      let fileComments = [];
      const firstStatement = sourceFile.statements.length && sourceFile.statements[0] || null;
      const originalComments = ts14.getLeadingCommentRanges(text, 0) || [];
      if (!firstStatement) {
        fileComments = synthesizeCommentRanges(sourceFile, originalComments);
      } else {
        for (let i = originalComments.length - 1;i >= 0; i--) {
          const end = originalComments[i].end;
          if (!text.substring(end).startsWith(`

`) && !text.substring(end).startsWith(`\r
\r
`)) {
            continue;
          }
          const synthesizedComments = synthesizeLeadingComments(firstStatement);
          fileComments = synthesizedComments.splice(0, i + 1);
          break;
        }
      }
      const notEmitted = ts14.factory.createNotEmittedStatement(sourceFile);
      ts14.setSyntheticLeadingComments(notEmitted, fileComments);
      sourceFile = updateSourceFileNode(sourceFile, ts14.factory.createNodeArray([notEmitted, ...sourceFile.statements]));
      for (let i = 0;i < sourceFile.statements.length; i++) {
        const stmt = sourceFile.statements[i];
        if (i === 0 && stmt.kind === ts14.SyntaxKind.NotEmittedStatement) {
          continue;
        }
        const comments = synthesizeLeadingComments(stmt);
        checkNoFileoverviewComments(stmt, comments, `file comments must be at the top of the file, ` + `separated from the file body by an empty line.`);
      }
      let fileoverviewIdx = -1;
      let tags = [];
      for (let i = fileComments.length - 1;i >= 0; i--) {
        const parsed = parse(fileComments[i]);
        if (parsed !== null && parsed.tags.some((t) => FILEOVERVIEW_COMMENT_MARKERS.has(t.tagName))) {
          fileoverviewIdx = i;
          tags = parsed.tags;
          break;
        }
      }
      const mutableJsDoc = new MutableJSDoc(notEmitted, fileComments, fileoverviewIdx, tags);
      if (fileoverviewIdx !== -1) {
        checkNoFileoverviewComments(firstStatement || sourceFile, fileComments.slice(0, fileoverviewIdx), `duplicate file level comment`);
      }
      augmentFileoverviewComments(options, sourceFile, mutableJsDoc.tags, generateExtraSuppressions);
      mutableJsDoc.updateComment();
      return sourceFile;
    };
  };
}

// src/tsickle/modules-manifest.ts
class ModulesManifest {
  moduleToFileName = {};
  referencedModules = {};
  addManifest(other) {
    Object.assign(this.moduleToFileName, other.moduleToFileName);
    Object.assign(this.referencedModules, other.referencedModules);
  }
  addModule(fileName, module2) {
    this.moduleToFileName[module2] = fileName;
    this.referencedModules[fileName] = [];
  }
  addReferencedModule(fileName, resolvedModule) {
    this.referencedModules[fileName].push(resolvedModule);
  }
  get fileNames() {
    return Object.keys(this.referencedModules);
  }
  getFileNameFromModule(module2) {
    return this.moduleToFileName[module2];
  }
  getReferencedModules(fileName) {
    return this.referencedModules[fileName];
  }
  get modules() {
    return Object.keys(this.moduleToFileName);
  }
}

// src/tsickle/ns-transformer.ts
var ts15 = __toESM(require("typescript"));
function namespaceTransformer(host, tsOptions, typeChecker, diagnostics) {
  return (context) => {
    return (sourceFile) => {
      let haveTransformedNs = false;
      let haveSeenError = false;
      const transformedStmts = [];
      for (const stmt of sourceFile.statements) {
        visitTopLevelStatement(stmt);
      }
      if (haveSeenError || !haveTransformedNs) {
        return sourceFile;
      }
      return ts15.factory.updateSourceFile(sourceFile, ts15.setTextRange(ts15.factory.createNodeArray(transformedStmts), sourceFile.statements));
      function transformNamespace(ns, mergedDecl) {
        if (!ns.body || !ts15.isModuleBlock(ns.body)) {
          if (ts15.isModuleDeclaration(ns)) {
            error(ns.name, "nested namespaces are not supported.  (go/ts-merged-namespaces)");
          }
          return [ns];
        }
        const nsName = getIdentifierText(ns.name);
        const mergingWithEnum = ts15.isEnumDeclaration(mergedDecl);
        const transformedNsStmts = [];
        for (const stmt of ns.body.statements) {
          if (ts15.isEmptyStatement(stmt))
            continue;
          if (ts15.isClassDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "class");
              continue;
            }
            transformInnerDeclaration(stmt, (classDecl, notExported, hoistedIdent) => {
              return ts15.factory.updateClassDeclaration(classDecl, notExported, hoistedIdent, classDecl.typeParameters, classDecl.heritageClauses, classDecl.members);
            });
          } else if (ts15.isEnumDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "enum");
              continue;
            }
            transformInnerDeclaration(stmt, (enumDecl, notExported, hoistedIdent) => {
              return ts15.factory.updateEnumDeclaration(enumDecl, notExported, hoistedIdent, enumDecl.members);
            });
          } else if (ts15.isInterfaceDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "interface");
              continue;
            }
            transformInnerDeclaration(stmt, (interfDecl, notExported, hoistedIdent) => {
              return ts15.factory.updateInterfaceDeclaration(interfDecl, notExported, hoistedIdent, interfDecl.typeParameters, interfDecl.heritageClauses, interfDecl.members);
            });
          } else if (ts15.isTypeAliasDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "type alias");
              continue;
            }
            transformTypeAliasDeclaration(stmt);
          } else if (ts15.isVariableStatement(stmt)) {
            if ((ts15.getCombinedNodeFlags(stmt.declarationList) & ts15.NodeFlags.Const) === 0) {
              error(stmt, "non-const values are not supported. (go/ts-merged-namespaces)");
              continue;
            }
            if (!ts15.isInterfaceDeclaration(mergedDecl)) {
              error(stmt, "const declaration only allowed when merging with an interface (go/ts-merged-namespaces)");
              continue;
            }
            transformConstDeclaration(stmt);
          } else if (ts15.isFunctionDeclaration(stmt)) {
            if (!ts15.isEnumDeclaration(mergedDecl)) {
              error(stmt, "function declaration only allowed when merging with an enum (go/ts-merged-namespaces)");
            }
            transformInnerDeclaration(stmt, (funcDecl, notExported, hoistedIdent) => {
              return ts15.factory.updateFunctionDeclaration(funcDecl, notExported, funcDecl.asteriskToken, hoistedIdent, funcDecl.typeParameters, funcDecl.parameters, funcDecl.type, funcDecl.body);
            });
          } else {
            error(stmt, `unsupported statement in declaration merging namespace '${nsName}' (go/ts-merged-namespaces)`);
          }
        }
        if (haveSeenError) {
          return [ns];
        }
        markAsMergedDeclaration(ns);
        markAsMergedDeclaration(mergedDecl);
        haveTransformedNs = true;
        transformedNsStmts.push(ts15.factory.createNotEmittedStatement(ns));
        return transformedNsStmts;
        function errorNotAllowed(stmt, declKind) {
          error(stmt, `${declKind} cannot be merged with enum declaration. (go/ts-merged-namespaces)`);
        }
        function transformConstDeclaration(varDecl) {
          for (let decl of varDecl.declarationList.declarations) {
            if (!decl.name || !ts15.isIdentifier(decl.name)) {
              error(decl, "Destructuring declarations are not supported. (go/ts-merged-namespaces)");
              return;
            }
            const originalName = getIdentifierText(decl.name);
            if (!hasModifierFlag(decl, ts15.ModifierFlags.Export)) {
              error(decl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
              return;
            }
            decl = fixReferences(decl);
            if (!decl.initializer) {
              error(decl, `'${originalName}' must have an initializer`);
              return;
            }
            transformedNsStmts.push(createInnerNameAlias(originalName, decl.initializer, varDecl));
          }
        }
        function transformTypeAliasDeclaration(aliasDecl) {
          const originalName = getIdentifierText(aliasDecl.name);
          if (!hasModifierFlag(aliasDecl, ts15.ModifierFlags.Export)) {
            error(aliasDecl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
          }
          aliasDecl = fixReferences(aliasDecl);
          const notExported = ts15.factory.createModifiersFromModifierFlags(ts15.getCombinedModifierFlags(aliasDecl) & ~ts15.ModifierFlags.Export);
          aliasDecl = ts15.factory.updateTypeAliasDeclaration(aliasDecl, notExported, aliasDecl.name, aliasDecl.typeParameters, aliasDecl.type);
          transformedNsStmts.push(aliasDecl);
        }
        function transformInnerDeclaration(decl, updateDecl) {
          if (!decl.name || !ts15.isIdentifier(decl.name)) {
            error(decl, "Anonymous declaration cannot be merged. (go/ts-merged-namespaces)");
            return;
          }
          const originalName = getIdentifierText(decl.name);
          if (!hasModifierFlag(decl, ts15.ModifierFlags.Export)) {
            error(decl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
          }
          decl = fixReferences(decl);
          const hoistedName = `${nsName}$${originalName}`;
          const hoistedIdent = ts15.factory.createIdentifier(hoistedName);
          ts15.setOriginalNode(hoistedIdent, decl.name);
          const notExported = ts15.factory.createModifiersFromModifierFlags(ts15.getCombinedModifierFlags(decl) & ~ts15.ModifierFlags.Export);
          const hoistedDecl = updateDecl(decl, notExported, hoistedIdent);
          transformedNsStmts.push(hoistedDecl);
          const aliasProp = createInnerNameAlias(originalName, hoistedIdent, decl);
          ts15.setEmitFlags(aliasProp, ts15.EmitFlags.NoLeadingComments);
          transformedNsStmts.push(aliasProp);
        }
        function createInnerNameAlias(propName, initializer, original) {
          const prop = ts15.factory.createExpressionStatement(ts15.factory.createAssignment(ts15.factory.createPropertyAccessExpression(mergedDecl.name, propName), initializer));
          ts15.setTextRange(prop, original);
          ts15.setOriginalNode(prop, original);
          const jsDoc = getMutableJSDoc(prop, diagnostics, sourceFile);
          jsDoc.tags.push({ tagName: "const" });
          jsDoc.updateComment();
          return prop;
        }
        function isNamespaceRef(ident) {
          const sym = typeChecker.getSymbolAtLocation(ident);
          const parent = sym && sym.parent;
          if (parent && (parent.flags & ts15.SymbolFlags.Module) !== 0) {
            const parentName = parent.getName();
            if (parentName === nsName) {
              return true;
            }
          }
          return false;
        }
        function maybeFixIdentifier(ident) {
          if (isNamespaceRef(ident)) {
            const nsIdentifier = ts15.factory.createIdentifier(nsName);
            const nsProp = ts15.factory.createPropertyAccessExpression(nsIdentifier, ident);
            ts15.setOriginalNode(nsProp, ident);
            ts15.setTextRange(nsProp, ident);
            return nsProp;
          }
          return ident;
        }
        function maybeFixPropertyAccess(prop) {
          if (ts15.isPropertyAccessExpression(prop.expression)) {
            const updatedProp = maybeFixPropertyAccess(prop.expression);
            if (updatedProp !== prop.expression) {
              return ts15.factory.updatePropertyAccessExpression(prop, updatedProp, prop.name);
            }
            return prop;
          }
          if (!ts15.isIdentifier(prop.expression)) {
            return prop;
          }
          const nsProp = maybeFixIdentifier(prop.expression);
          if (nsProp !== prop.expression) {
            const newPropAccess = ts15.factory.updatePropertyAccessExpression(prop, nsProp, prop.name);
            return newPropAccess;
          }
          return prop;
        }
        function fixReferences(node) {
          const rootNode = node;
          function refCheckVisitor(node2) {
            if (ts15.isTypeReferenceNode(node2) || ts15.isTypeQueryNode(node2)) {
              return node2;
            }
            if (ts15.isPropertyAccessExpression(node2)) {
              return maybeFixPropertyAccess(node2);
            }
            if (!ts15.isIdentifier(node2)) {
              return ts15.visitEachChild(node2, refCheckVisitor, context);
            }
            if (node2.parent === rootNode) {
              return node2;
            }
            return maybeFixIdentifier(node2);
          }
          return ts15.visitEachChild(node, refCheckVisitor, context);
        }
      }
      function visitTopLevelStatement(node) {
        if (!ts15.isModuleDeclaration(node) || isAmbient(node)) {
          transformedStmts.push(node);
          return;
        }
        const ns = node;
        const sym = typeChecker.getSymbolAtLocation(ns.name);
        if (!sym || ns.name.kind === ts15.SyntaxKind.StringLiteral) {
          transformedStmts.push(ns);
          return;
        }
        const mergedDecl = getPreviousDeclaration(sym, ns);
        if (!mergedDecl) {
          transformedStmts.push(ns);
          error(ns.name, "transformation of plain namespace not supported. (go/ts-merged-namespaces)");
          return;
        }
        if (!ts15.isInterfaceDeclaration(mergedDecl) && !ts15.isClassDeclaration(mergedDecl) && !ts15.isEnumDeclaration(mergedDecl)) {
          transformedStmts.push(ns);
          error(ns.name, "merged declaration must be local class, enum, or interface. (go/ts-merged-namespaces)");
          return;
        }
        transformedStmts.push(...transformNamespace(ns, mergedDecl));
      }
      function error(node, message) {
        reportDiagnostic(diagnostics, node, message);
        haveSeenError = true;
      }
    };
  };
}

// src/tsickle/ts-migration-exports-shim.ts
var ts16 = __toESM(require("typescript"));

// src/tsickle/summary.ts
class FileSummary {
  dynamicRequireSet = new Map;
  enhancedSet = new Map;
  maybeRequireSet = new Map;
  modSet = new Map;
  provideSet = new Map;
  strongRequireSet = new Map;
  weakRequireSet = new Map;
  autochunk = false;
  enhanceable = false;
  legacyNamespace = false;
  modName;
  moduleType = 0 /* UNKNOWN */;
  toggles = [];
  stringify(symbol) {
    return JSON.stringify(symbol);
  }
  addDynamicRequire(dynamicRequire) {
    this.dynamicRequireSet.set(this.stringify(dynamicRequire), dynamicRequire);
  }
  addEnhanced(enhanced) {
    this.enhancedSet.set(this.stringify(enhanced), enhanced);
  }
  addMaybeRequire(maybeRequire) {
    this.maybeRequireSet.set(this.stringify(maybeRequire), maybeRequire);
  }
  addMods(mods) {
    this.modSet.set(this.stringify(mods), mods);
  }
  addProvide(provide) {
    this.provideSet.set(this.stringify(provide), provide);
  }
  addStrongRequire(strongRequire) {
    this.strongRequireSet.set(this.stringify(strongRequire), strongRequire);
  }
  addWeakRequire(weakRequire) {
    this.weakRequireSet.set(this.stringify(weakRequire), weakRequire);
  }
  get dynamicRequires() {
    return [...this.dynamicRequireSet.values()];
  }
  get enhanced() {
    return [...this.enhancedSet.values()];
  }
  get maybeRequires() {
    return [...this.maybeRequireSet.values()];
  }
  get mods() {
    return [...this.modSet.values()];
  }
  get provides() {
    return [...this.provideSet.values()];
  }
  get strongRequires() {
    return [...this.strongRequireSet.values()];
  }
  get weakRequires() {
    const weakRequires = [];
    for (const [k, v] of this.weakRequireSet.entries()) {
      if (this.strongRequireSet.has(k))
        continue;
      weakRequires.push(v);
    }
    return weakRequires;
  }
}

// src/tsickle/ts-migration-exports-shim.ts
function createTsMigrationExportsShimTransformerFactory(typeChecker, host, manifest, tsickleDiagnostics, outputFileMap, fileSummaries) {
  return (context) => {
    return (src) => {
      const srcFilename = host.rootDirsRelative(src.fileName);
      const srcModuleId = host.pathToModuleName("", src.fileName);
      const srcIds = new FileIdGroup(srcFilename, srcModuleId);
      const generator = new Generator(src, srcIds, typeChecker, host, manifest, tsickleDiagnostics);
      const tsmesFile = srcIds.google3PathWithoutExtension() + ".tsmes.js";
      const dtsFile = srcIds.google3PathWithoutExtension() + ".tsmes.d.ts";
      if (!host.generateTsMigrationExportsShim) {
        return src;
      }
      if (!generator.foundMigrationExportsShim()) {
        outputFileMap.set(tsmesFile, "");
        const fileSummary2 = new FileSummary;
        fileSummary2.moduleType = 0 /* UNKNOWN */;
        fileSummaries.set(tsmesFile, fileSummary2);
        if (context.getCompilerOptions().declaration) {
          outputFileMap.set(dtsFile, "");
        }
        return src;
      }
      const [content, fileSummary] = generator.generateExportShimJavaScript();
      outputFileMap.set(tsmesFile, content);
      fileSummaries.set(tsmesFile, fileSummary);
      if (context.getCompilerOptions().declaration) {
        const dtsResult = generator.generateExportShimDeclarations();
        outputFileMap.set(dtsFile, dtsResult);
      }
      return generator.transformSourceFile();
    };
  };
}
function stripSupportedExtensions(path5) {
  return path5.replace(SUPPORTED_EXTENSIONS, "");
}
var SUPPORTED_EXTENSIONS = /(?<!\.d)\.ts$/;

class Generator {
  src;
  srcIds;
  typeChecker;
  host;
  manifest;
  diagnostics;
  mainExports;
  outputIds;
  tsmesBreakdown;
  constructor(src, srcIds, typeChecker, host, manifest, diagnostics) {
    this.src = src;
    this.srcIds = srcIds;
    this.typeChecker = typeChecker;
    this.host = host;
    this.manifest = manifest;
    this.diagnostics = diagnostics;
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(this.src);
    this.mainExports = moduleSymbol ? this.typeChecker.getExportsOfModule(moduleSymbol) : [];
    const outputFilename = this.srcIds.google3PathWithoutExtension() + ".tsmes.closure.js";
    this.tsmesBreakdown = this.extractTsmesStatement();
    if (this.tsmesBreakdown) {
      this.outputIds = new FileIdGroup(outputFilename, this.tsmesBreakdown.googModuleId.text);
    }
  }
  checkIsModuleExport(node, symbol) {
    if (!symbol) {
      this.report(node, `could not resolve symbol of exported property`);
    } else if (this.mainExports.indexOf(symbol) === -1) {
      this.report(node, `export must be an exported symbol of the module`);
    } else {
      return true;
    }
    return false;
  }
  checkNonTopLevelTsmesCalls(topLevelStatement) {
    const inner = (node) => {
      if (isAnyTsmesCall(node) || isTsmesDeclareLegacyNamespaceCall(node)) {
        const name = getGoogFunctionName(node);
        this.report(node, `goog.${name} is only allowed in top level statements`);
      }
      ts16.forEachChild(node, inner);
    };
    ts16.forEachChild(topLevelStatement, inner);
  }
  extractGoogExports(exportsExpr) {
    let googExports;
    const diagnosticCount = this.diagnostics.length;
    if (ts16.isObjectLiteralExpression(exportsExpr)) {
      googExports = new Map;
      for (const property of exportsExpr.properties) {
        if (ts16.isShorthandPropertyAssignment(property)) {
          const symbol = this.typeChecker.getShorthandAssignmentValueSymbol(property);
          this.checkIsModuleExport(property.name, symbol);
          googExports.set(property.name.text, property.name.text);
        } else if (ts16.isPropertyAssignment(property)) {
          const name = property.name;
          if (!ts16.isIdentifier(name)) {
            this.report(name, "export names must be simple keys");
            continue;
          }
          const initializer = property.initializer;
          let identifier = null;
          if (ts16.isAsExpression(initializer)) {
            identifier = this.maybeExtractTypeName(initializer);
          } else if (ts16.isIdentifier(initializer)) {
            identifier = initializer;
          } else {
            this.report(initializer, "export values must be plain identifiers");
            continue;
          }
          if (identifier == null) {
            continue;
          }
          const symbol = this.typeChecker.getSymbolAtLocation(identifier);
          this.checkIsModuleExport(identifier, symbol);
          googExports.set(name.text, identifier.text);
        } else {
          this.report(property, `exports object must only contain (shorthand) properties`);
        }
      }
    } else if (ts16.isIdentifier(exportsExpr)) {
      const symbol = this.typeChecker.getSymbolAtLocation(exportsExpr);
      this.checkIsModuleExport(exportsExpr, symbol);
      googExports = exportsExpr.text;
    } else if (ts16.isAsExpression(exportsExpr)) {
      const identifier = this.maybeExtractTypeName(exportsExpr);
      if (!identifier) {
        return;
      }
      const symbol = this.typeChecker.getSymbolAtLocation(identifier);
      this.checkIsModuleExport(identifier, symbol);
      googExports = identifier.text;
    } else {
      this.report(exportsExpr, `exports object must be either an object literal ({A, B}) or the ` + `identifier of a module export (A)`);
    }
    return diagnosticCount === this.diagnostics.length ? googExports : undefined;
  }
  extractTsmesStatement() {
    const startDiagnosticsCount = this.diagnostics.length;
    let tsmesCallStatement = undefined;
    let tsmesDlnCallStatement = undefined;
    for (const statement of this.src.statements) {
      const isTsmesCall = ts16.isExpressionStatement(statement) && isAnyTsmesCall(statement.expression);
      const isTsmesDlnCall = ts16.isExpressionStatement(statement) && isTsmesDeclareLegacyNamespaceCall(statement.expression);
      if (!isTsmesCall && !isTsmesDlnCall) {
        this.checkNonTopLevelTsmesCalls(statement);
        continue;
      }
      if (isTsmesCall) {
        if (tsmesCallStatement) {
          this.report(tsmesCallStatement, "at most one call to any of goog.tsMigrationExportsShim, " + "goog.tsMigrationDefaultExportsShim, " + "goog.tsMigrationNamedExportsShim is allowed per file");
        } else {
          tsmesCallStatement = statement;
        }
      } else if (isTsmesDlnCall) {
        if (tsmesDlnCallStatement) {
          this.report(tsmesDlnCallStatement, "at most one call to " + "goog.tsMigrationExportsShimDeclareLegacyNamespace " + "is allowed per file");
        } else {
          tsmesDlnCallStatement = statement;
        }
      }
    }
    if (!tsmesCallStatement) {
      if (tsmesDlnCallStatement) {
        this.report(tsmesDlnCallStatement, "goog.tsMigrationExportsShimDeclareLegacyNamespace requires a " + "goog.tsMigration*ExportsShim call as well");
        return;
      }
      return;
    } else if (!this.host.generateTsMigrationExportsShim) {
      this.report(tsmesCallStatement, "calls to goog.tsMigration*ExportsShim are not enabled. Please set" + " generate_ts_migration_exports_shim = True" + " in the BUILD file to enable this feature.");
      return;
    }
    const tsmesCall = tsmesCallStatement.expression;
    if (isGoogCallExpressionOf(tsmesCall, "tsMigrationExportsShim") && tsmesCall.arguments.length !== 2) {
      this.report(tsmesCall, "goog.tsMigrationExportsShim requires 2 arguments");
      return;
    }
    if (isTsmesShorthandCall(tsmesCall) && tsmesCall.arguments.length !== 1) {
      this.report(tsmesCall, `goog.${getGoogFunctionName(tsmesCall)} requires exactly one argument`);
      return;
    }
    if (isGoogCallExpressionOf(tsmesCall, "tsMigrationDefaultExportsShim") && this.mainExports.length !== 1) {
      this.report(tsmesCall, "can only call goog.tsMigrationDefaultExportsShim when there is" + " exactly one export.");
      return;
    }
    const [moduleId, exportsExpr] = tsmesCall.arguments;
    if (!ts16.isStringLiteral(moduleId)) {
      this.report(moduleId, `goog.${getGoogFunctionName(tsmesCall)} ID must be a string literal`);
      return;
    }
    let googExports = undefined;
    const fnName = getGoogFunctionName(tsmesCall);
    switch (fnName) {
      case "tsMigrationDefaultExportsShim":
        googExports = this.mainExports[0].name;
        break;
      case "tsMigrationNamedExportsShim":
        googExports = new Map;
        for (const mainExport of this.mainExports) {
          googExports.set(mainExport.name, mainExport.name);
        }
        break;
      case "tsMigrationExportsShim":
        googExports = this.extractGoogExports(exportsExpr);
        break;
      default:
        throw new Error(`encountered unhandled goog.$fnName: ${fnName}`);
    }
    if (googExports === undefined) {
      if (startDiagnosticsCount >= this.diagnostics.length) {
        throw new Error("googExports should be defined unless some diagnostic is reported.");
      }
      return;
    }
    return {
      callStatement: tsmesCallStatement,
      declareLegacyNamespaceStatement: tsmesDlnCallStatement,
      googExports,
      googModuleId: moduleId
    };
  }
  maybeExtractTypeName(cast) {
    if (!ts16.isObjectLiteralExpression(cast.expression) || cast.expression.properties.length !== 0) {
      this.report(cast.expression, "must be object literal with no keys");
      return null;
    }
    const typeRef = cast.type;
    if (!ts16.isTypeReferenceNode(typeRef)) {
      this.report(typeRef, "must be a type reference");
      return null;
    }
    const typeName = typeRef.typeName;
    if (typeRef.typeArguments || !ts16.isIdentifier(typeName)) {
      this.report(typeRef, "export types must be plain identifiers");
      return null;
    }
    return typeName;
  }
  report(node, messageText) {
    reportDiagnostic(this.diagnostics, node, messageText, undefined, ts16.DiagnosticCategory.Error);
  }
  foundMigrationExportsShim() {
    return !!this.tsmesBreakdown;
  }
  generateExportShimDeclarations() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    const generatedFromComment = "// Generated from " + this.srcIds.google3Path;
    const dependencyFileImports = lines2(`declare module 'ಠ_ಠ.clutz._dependencies' {`, `  import '${this.srcIds.esModuleImportPath()}';`, `}`);
    let clutzNamespaceDeclaration;
    let googColonModuleDeclaration;
    if (this.tsmesBreakdown.googExports instanceof Map) {
      const clutzNamespace = this.srcIds.clutzNamespace();
      const clutzNamespaceReexports = Array.from(this.tsmesBreakdown.googExports).map(([k, v]) => `  export import ${k} = ${clutzNamespace}.${v};`);
      clutzNamespaceDeclaration = lines2(generatedFromComment, `declare namespace ${this.outputIds.clutzNamespace()} {`, ...clutzNamespaceReexports, `}`);
      googColonModuleDeclaration = lines2(generatedFromComment, `declare module '${this.outputIds.clutzModuleId()}' {`, `  import x = ${this.outputIds.clutzNamespace()};`, `  export = x;`, `}`);
    } else {
      clutzNamespaceDeclaration = lines2(generatedFromComment, `declare namespace ಠ_ಠ.clutz {`, `  export import ${this.outputIds.googModuleRewrittenId()} =`, `      ${this.srcIds.clutzNamespace()}.${this.tsmesBreakdown.googExports};`, `}`);
      googColonModuleDeclaration = lines2(generatedFromComment, `declare module '${this.outputIds.clutzModuleId()}' {`, `  import x = ${this.outputIds.clutzNamespace()};`, `  export default x;`, `}`);
    }
    return lines2("/**", " * @fileoverview generator:ts_migration_exports_shim.ts", " */", dependencyFileImports, clutzNamespaceDeclaration, googColonModuleDeclaration, "");
  }
  generateExportShimJavaScript() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    let maybeDeclareLegacyNameCall = undefined;
    if (this.tsmesBreakdown.declareLegacyNamespaceStatement) {
      maybeDeclareLegacyNameCall = "goog.module.declareLegacyNamespace();";
    }
    const mainModuleRequire = `var mainModule = goog.require('${this.srcIds.googModuleId}');`;
    let exportsAssignment;
    if (this.tsmesBreakdown.googExports instanceof Map) {
      const exports2 = Array.from(this.tsmesBreakdown.googExports).map(([k, v]) => `exports.${k} = mainModule.${v};`);
      exportsAssignment = lines2(...exports2);
    } else {
      exportsAssignment = `exports = mainModule.${this.tsmesBreakdown.googExports};`;
    }
    this.manifest.addModule(this.outputIds.google3Path, this.outputIds.googModuleId);
    this.manifest.addReferencedModule(this.outputIds.google3Path, this.srcIds.googModuleId);
    const isAutoChunk = containsAtPintoModule(this.src);
    const pintoModuleAnnotation = isAutoChunk ? "@pintomodule found in original_file" : "pintomodule absent in original_file";
    const content = lines2("/**", " * @fileoverview generator:ts_migration_exports_shim.ts", " * original_file:" + this.srcIds.google3Path, ` * ${pintoModuleAnnotation}`, " */", `goog.module('${this.outputIds.googModuleId}');`, maybeDeclareLegacyNameCall, mainModuleRequire, exportsAssignment, "");
    const fileSummary = new FileSummary;
    fileSummary.addProvide({
      name: this.outputIds.googModuleId,
      type: 1 /* CLOSURE */
    });
    fileSummary.addStrongRequire({ name: "goog", type: 1 /* CLOSURE */ });
    fileSummary.addStrongRequire({
      name: this.srcIds.googModuleId,
      type: 1 /* CLOSURE */
    });
    if (maybeDeclareLegacyNameCall) {
      fileSummary.legacyNamespace = true;
    }
    fileSummary.autochunk = isAutoChunk;
    fileSummary.moduleType = 2 /* GOOG_MODULE */;
    return [content, fileSummary];
  }
  transformSourceFile() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    const outputStatements = [...this.src.statements];
    const tsmesIndex = outputStatements.indexOf(this.tsmesBreakdown.callStatement);
    if (tsmesIndex < 0) {
      throw new Error("could not find tsmes call in file");
    }
    outputStatements.splice(tsmesIndex, 1);
    if (this.tsmesBreakdown.declareLegacyNamespaceStatement) {
      const dlnIndex = outputStatements.indexOf(this.tsmesBreakdown.declareLegacyNamespaceStatement);
      if (dlnIndex < 0) {
        throw new Error("could not find the tsmes declareLegacyNamespace call in file");
      }
      outputStatements.splice(dlnIndex, 1);
    }
    return ts16.factory.updateSourceFile(this.src, ts16.setTextRange(ts16.factory.createNodeArray(outputStatements), this.src.statements));
  }
}
function lines2(...lines3) {
  return lines3.filter((line) => line != null).join(`
`);
}

class FileIdGroup {
  google3Path;
  googModuleId;
  constructor(google3Path, googModuleId) {
    this.google3Path = google3Path;
    this.googModuleId = googModuleId;
  }
  clutzModuleId() {
    return "goog:" + this.googModuleId;
  }
  clutzNamespace() {
    return "ಠ_ಠ.clutz." + this.googModuleRewrittenId();
  }
  esModuleImportPath() {
    return "google3/" + this.google3PathWithoutExtension();
  }
  google3PathWithoutExtension() {
    return stripSupportedExtensions(this.google3Path);
  }
  googModuleRewrittenId() {
    return "module$exports$" + this.googModuleId.replace(/\./g, "$");
  }
}
function containsAtPintoModule(file) {
  const leadingTrivia = file.getFullText().substring(0, file.getLeadingTriviaWidth());
  return /\s@pintomodule\s/.test(leadingTrivia);
}
// src/tsickle/index.ts
function writeWithTsickleHeader(writeFile, rootDir) {
  return (fileName, content, writeByteOrderMark, onError, sourceFiles, data) => {
    if (fileName.endsWith(".d.ts")) {
      const sources = sourceFiles?.map((sf) => relative(rootDir, sf.fileName));
      content = `//!! generated by tsickle from ${sources?.join(" ") || "???"}
${content}`;
    }
    writeFile(fileName, content, writeByteOrderMark, onError, sourceFiles, data);
  };
}
function emit(program, host, writeFile, targetSourceFile, cancellationToken, emitOnlyDtsFiles, customTransformers = {}) {
  for (const sf of program.getSourceFiles()) {
    assertAbsolute(sf.fileName);
  }
  let tsickleDiagnostics = [];
  const typeChecker = program.getTypeChecker();
  const tsOptions = program.getCompilerOptions();
  if (!tsOptions.rootDir) {
    return {
      diagnostics: [
        {
          category: ts17.DiagnosticCategory.Error,
          code: 0,
          file: undefined,
          length: undefined,
          messageText: "TypeScript options must specify rootDir",
          start: undefined
        }
      ],
      emitSkipped: false,
      externs: {},
      fileSummaries: new Map,
      modulesManifest: new ModulesManifest,
      tsMigrationExportsShimFiles: new Map
    };
  }
  const modulesManifest = new ModulesManifest;
  const tsMigrationExportsShimFiles = new Map;
  const tsickleSourceTransformers = [];
  const fileSummaries = new Map;
  tsickleSourceTransformers.push(createTsMigrationExportsShimTransformerFactory(typeChecker, host, modulesManifest, tsickleDiagnostics, tsMigrationExportsShimFiles, fileSummaries));
  if (host.transformTypesToClosure) {
    tsickleSourceTransformers.push(transformFileoverviewCommentFactory(tsOptions, tsickleDiagnostics, host.generateExtraSuppressions));
    if (host.useDeclarationMergingTransformation) {
      tsickleSourceTransformers.push(namespaceTransformer(host, tsOptions, typeChecker, tsickleDiagnostics));
    }
    tsickleSourceTransformers.push(jsdocTransformer(host, tsOptions, typeChecker, tsickleDiagnostics));
    tsickleSourceTransformers.push(enumTransformer(host, typeChecker));
  }
  if (host.transformDecorators) {
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  }
  const tsTransformers = {
    after: [...customTransformers.afterTs || []],
    afterDeclarations: [...customTransformers.afterDeclarations || []],
    before: [
      ...(tsickleSourceTransformers || []).map((tf) => skipTransformForSourceFileIfNeeded(host, tf)),
      ...customTransformers.beforeTs || []
    ]
  };
  if (host.transformTypesToClosure) {
    tsTransformers.before.push(removeTypeAssertions());
  }
  if (host.googmodule) {
    tsTransformers.after.push(commonJsToGoogmoduleTransformer(host, modulesManifest, typeChecker));
    tsTransformers.after.push(transformDecoratorsOutputForClosurePropertyRenaming(tsickleDiagnostics));
    tsTransformers.after.push(transformDecoratorJsdoc());
  }
  if (host.addDtsClutzAliases) {
    tsTransformers.afterDeclarations.push(makeDeclarationTransformerFactory(typeChecker, host));
  }
  const {
    diagnostics: tsDiagnostics,
    emitSkipped,
    emittedFiles
  } = program.emit(targetSourceFile, writeWithTsickleHeader(writeFile, tsOptions.rootDir), cancellationToken, emitOnlyDtsFiles, tsTransformers);
  const externs = {};
  if (host.transformTypesToClosure) {
    const sourceFiles = targetSourceFile ? [targetSourceFile] : program.getSourceFiles();
    for (const sourceFile of sourceFiles) {
      const isDts = isDtsFileName(sourceFile.fileName);
      if (isDts && host.shouldSkipTsickleProcessing(sourceFile.fileName)) {
        continue;
      }
      const { diagnostics, moduleNamespace, output } = generateExterns(typeChecker, sourceFile, host);
      if (output) {
        externs[sourceFile.fileName] = { moduleNamespace, output };
      }
      if (diagnostics) {
        tsickleDiagnostics.push(...diagnostics);
      }
    }
  }
  tsickleDiagnostics = tsickleDiagnostics.filter((d) => d.category === ts17.DiagnosticCategory.Error || !host.shouldIgnoreWarningsForPath(d.file.fileName));
  return {
    diagnostics: [...tsDiagnostics, ...tsickleDiagnostics],
    emitSkipped,
    emittedFiles: emittedFiles || [],
    externs,
    fileSummaries,
    modulesManifest,
    tsMigrationExportsShimFiles
  };
}
function skipTransformForSourceFileIfNeeded(host, delegateFactory) {
  return (context) => {
    const delegate = delegateFactory(context);
    return (sourceFile) => {
      if (host.shouldSkipTsickleProcessing(sourceFile.fileName)) {
        return sourceFile;
      }
      return delegate(sourceFile);
    };
  };
}

// src/stages/tsickle/emit.ts
var MODULE_PREFIX = "_gcc_";
async function emitTsickleStage({
  cacheDir,
  compilerOptions,
  fileNames,
  metadataPath,
  options,
  workspaceDir
}) {
  const outDir = import_path5.default.join(cacheDir, "out");
  const externsPath = import_path5.default.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readTsickleMetadata(metadataPath);
  if (cachedMetadata && await pathExists(externsPath) && (await Promise.all(cachedMetadata.emittedFiles.map(pathExists))).every(Boolean)) {
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
    module: import_typescript2.default.ModuleKind.CommonJS,
    moduleResolution: import_typescript2.default.ModuleResolutionKind.NodeJs,
    outDir,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: import_typescript2.default.ScriptTarget.ESNext
  };
  const compilerHost = import_typescript2.default.createCompilerHost(finalCompilerOptions);
  const program = import_typescript2.default.createProgram(fileNames, finalCompilerOptions, compilerHost);
  const preflightDiagnostics = getPreflightDiagnostics(program, options.diagnostics.preflight);
  if (preflightDiagnostics.length > 0) {
    return {
      diagnostics: preflightDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir
    };
  }
  const filesToProcess = new Set(fileNames.map((fileName) => import_path5.default.resolve(fileName)));
  const moduleNameCache = new Map;
  const moduleIdCache = new Map;
  const writePromises = [];
  const asyncWriteFile = (fileName, content) => {
    writePromises.push(writeFileContent(fileName, content));
  };
  const transformerHost = {
    addDtsClutzAliases: false,
    fileNameToModuleId: (fileName) => {
      const cached = moduleIdCache.get(fileName);
      if (cached) {
        return cached;
      }
      const value = MODULE_PREFIX + import_path5.default.relative(workspaceDir, fileName).replace(/\\/g, "/");
      moduleIdCache.set(fileName, value);
      return value;
    },
    generateExtraSuppressions: false,
    generateSummary: false,
    generateTsMigrationExportsShim: false,
    googmodule: true,
    logWarning: (warning) => {
      if (options.diagnostics.verbose) {
        console.error(import_typescript2.default.formatDiagnosticsWithColorAndContext([warning], compilerHost));
      } else {
        console.error(import_typescript2.default.flattenDiagnosticMessageText(warning.messageText, `
`));
      }
    },
    options: finalCompilerOptions,
    pathToModuleName: (context, fileName) => {
      const cacheKey = `${context}::${fileName}`;
      const cached = moduleNameCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const value = fileName === "tslib" ? "tslib" : MODULE_PREFIX + pathToModuleName(workspaceDir, context, fileName);
      moduleNameCache.set(cacheKey, value);
      return value;
    },
    provideExternalModuleDtsNamespace: true,
    rootDirsRelative: (fileName) => fileName,
    shouldIgnoreWarningsForPath: () => !options.diagnostics.fatalWarnings,
    shouldSkipTsickleProcessing: (fileName) => !filesToProcess.has(import_path5.default.resolve(fileName)),
    transformDecorators: true,
    transformDynamicImport: "closure",
    transformTypesToClosure: true,
    typeBlackListPaths: new Set,
    untyped: false,
    useDeclarationMergingTransformation: true
  };
  const result = emit(program, transformerHost, asyncWriteFile);
  await Promise.all(writePromises);
  if (result.diagnostics.length > 0) {
    return {
      diagnostics: [...result.diagnostics],
      emitSkipped: result.emitSkipped,
      emittedFiles: [],
      externsPath,
      outDir
    };
  }
  await writeFileContent(externsPath, getGeneratedExterns(result.externs, finalCompilerOptions.rootDir || ""));
  const emittedFiles = await collectJavaScriptFiles(outDir);
  await writeFileContent(metadataPath, JSON.stringify({
    emittedFiles,
    externsPath
  }, null, 2));
  return {
    diagnostics: [...result.diagnostics],
    emitSkipped: result.emitSkipped,
    emittedFiles,
    externsPath,
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
async function collectJavaScriptFiles(dir) {
  const files = [];
  const pendingDirs = [dir];
  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    const entries = await import_fs5.default.promises.readdir(currentDir, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const entryPath = import_path5.default.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
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
async function readTsickleMetadata(metadataPath) {
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
var import_path6 = __toESM(require("path"));

// src/stages/post-process/rewrite-exports.ts
var import_core = require("@swc/core");
var DEFAULT_EXPORT_IDENTIFIER = "__DEFAULT_EXPORT__";
var GCC_IDENTIFIER = "GCC";
var SWC_PARSE_OPTIONS = {
  syntax: "ecmascript",
  target: "es2022"
};
async function rewriteClosureExports({
  code,
  minifyOutput,
  rewriteExports
}) {
  if (code.length === 0) {
    return code;
  }
  let transformedCode = code;
  if (rewriteExports && code.includes("globalThis.GCC")) {
    const module2 = import_core.parseSync(code, SWC_PARSE_OPTIONS);
    transformedCode = import_core.printSync(convertGccExportsToEsm(module2)).code;
  }
  if (minifyOutput !== "swc") {
    return transformedCode;
  }
  const result = await import_core.minify(transformedCode, {
    compress: true,
    mangle: true,
    module: true
  });
  if (!result.code) {
    throw new Error("SWC minify produced no output.");
  }
  return result.code;
}
function convertGccExportsToEsm(module2) {
  const body = [];
  const exportsMap = new Map;
  const processedExports = new Set;
  const existingExportNames = new Set;
  let hasDefaultExport = false;
  for (const item of module2.body) {
    if (item.type === "ExportNamedDeclaration") {
      for (const specifier of item.specifiers) {
        if (specifier.type !== "ExportSpecifier") {
          continue;
        }
        existingExportNames.add(getModuleExportName(specifier.exported ?? specifier.orig));
      }
      continue;
    }
    if (item.type === "ExportDefaultDeclaration" || item.type === "ExportDefaultExpression") {
      hasDefaultExport = true;
    }
  }
  for (const item of module2.body) {
    const gccExport = getGccExportAssignment(item);
    if (!gccExport) {
      body.push(item);
      continue;
    }
    if (processedExports.has(gccExport.exportName)) {
      continue;
    }
    processedExports.add(gccExport.exportName);
    const localName = gccExport.exportName === DEFAULT_EXPORT_IDENTIFIER ? "__gcc_default_export__" : `__gcc_export_${sanitizeIdentifier(gccExport.exportName)}`;
    exportsMap.set(gccExport.exportName, localName);
    body.push(createConstDeclaration(localName, gccExport.right));
  }
  for (const [exportName, localName] of exportsMap) {
    if (exportName === DEFAULT_EXPORT_IDENTIFIER) {
      if (!hasDefaultExport) {
        body.push(createDefaultExport(localName));
      }
      continue;
    }
    if (!existingExportNames.has(exportName)) {
      body.push(createNamedExport(localName, exportName));
    }
  }
  module2.body = body;
  return module2;
}
function getGccExportAssignment(item) {
  if (item.type !== "ExpressionStatement") {
    return;
  }
  const statement = item;
  if (statement.expression.type !== "AssignmentExpression") {
    return;
  }
  const expression = statement.expression;
  if (expression.left.type !== "MemberExpression") {
    return;
  }
  const left = expression.left;
  if (left.object.type !== "MemberExpression") {
    return;
  }
  const object = left.object;
  if (object.object.type !== "Identifier" || object.object.value !== "globalThis" || getMemberPropertyName(object) !== GCC_IDENTIFIER) {
    return;
  }
  const exportName = getMemberPropertyName(left);
  if (!exportName) {
    return;
  }
  return { exportName, right: expression.right };
}
function getMemberPropertyName(node) {
  const property = node.property;
  if (property.type === "Identifier" || property.type === "StringLiteral") {
    return property.value;
  }
  return;
}
function getModuleExportName(node) {
  return node.type === "Identifier" ? node.value : node.value;
}
function sanitizeIdentifier(name) {
  return name.replace(/[^\w$]/g, "_");
}
function parseModuleItem(code) {
  const module2 = import_core.parseSync(code, SWC_PARSE_OPTIONS);
  const [item] = module2.body;
  if (!item) {
    throw new Error(`Failed to parse module item: ${code}`);
  }
  return item;
}
function createConstDeclaration(localName, right) {
  const declaration = parseModuleItem(`const ${localName} = null;`);
  if (declaration.type !== "VariableDeclaration") {
    throw new Error("Failed to create variable declaration.");
  }
  declaration.declarations[0].init = right;
  return declaration;
}
function createDefaultExport(localName) {
  return parseModuleItem(`export default ${localName};`);
}
function createNamedExport(localName, exportName) {
  const exportedName = /^[A-Za-z_$][\w$]*$/.test(exportName) ? exportName : JSON.stringify(exportName);
  return parseModuleItem(`export { ${localName} as ${exportedName} };`);
}

// src/stages/closure/run-closure.ts
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
  const rawDir = import_path6.default.join(finalCacheDir, "raw");
  const outputDir = import_path6.default.join(finalCacheDir, "outputs");
  await import_promises.default.mkdir(rawDir, { recursive: true });
  await import_promises.default.mkdir(outputDir, { recursive: true });
  const closureLibFiles = await collectJavaScriptFiles2(import_path6.default.join(packageRoot, "closure-lib"));
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
    rawOutputPath: import_path6.default.join(rawDir, `${chunkPlan[0].name}.js`)
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
  const rawOutputs = await collectJavaScriptFiles2(rawDir);
  await Promise.all(rawOutputs.map(async (rawFile) => {
    const contents = await import_promises.default.readFile(rawFile, "utf-8");
    const transformed = await rewriteClosureExports({
      code: contents,
      minifyOutput: options.postProcess.minify,
      rewriteExports: options.postProcess.rewriteExports
    });
    await import_promises.default.writeFile(import_path6.default.join(outputDir, import_path6.default.basename(rawFile)), transformed);
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
    processCommonJsModules: true,
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
    chunkOutputPathPrefix: `${outputDir}${import_path6.default.sep}`,
    chunkOutputType: "ES_MODULES",
    dependencyMode: "NONE",
    externs: externPaths,
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    moduleResolution: "NODE",
    processCommonJsModules: true,
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
  return files.map((filePath) => import_path6.default.join(emittedOutDir, import_path6.default.relative(workspaceDir, filePath).replace(/\.[^/.]+$/, ".js")));
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
async function collectJavaScriptFiles2(dir) {
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

// src/pipeline/build-pipeline.ts
async function build(options) {
  const normalizedOptions = normalizeBuildOptions(options);
  const resolved = await resolveBuild(normalizedOptions);
  try {
    const finalMetadataPath = import_path7.default.join(resolved.finalCacheDir, "meta.json");
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
    await writeEntryShims({
      entries: resolved.entryFiles,
      shimDir: resolved.shimDir
    });
    const tsickleMetadataPath = import_path7.default.join(resolved.tsickleCacheDir, "meta.json");
    const tsickleResult = await emitTsickleStage({
      cacheDir: resolved.tsickleCacheDir,
      compilerOptions: resolved.compilerOptions,
      fileNames: [...resolved.filePaths, ...resolved.shimFiles],
      metadataPath: tsickleMetadataPath,
      options: normalizedOptions,
      workspaceDir: resolved.workspaceDir
    });
    if (tsickleResult.diagnostics.length > 0 || tsickleResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: tsickleResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir
      };
    }
    const bundledExterns = await collectBundledExterns(resolved.packageRoot);
    const exitCode = await runClosureStage({
      emittedOutDir: tsickleResult.outDir,
      entryFiles: resolved.entryFiles,
      externPaths: [
        ...normalizedOptions.externs,
        ...bundledExterns,
        tsickleResult.externsPath
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
    const finalOutputFiles = await collectJavaScriptFiles3(import_path7.default.join(resolved.finalCacheDir, "outputs"));
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
  const projectRoot = import_path7.default.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = import_path7.default.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = import_path7.default.join(cacheRoot, hashContent(projectRoot));
  await import_fs6.default.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function collectBundledExterns(packageRoot) {
  const closureExternsPath = import_path7.default.join(packageRoot, "closure-externs");
  const entries = await import_fs6.default.promises.readdir(closureExternsPath);
  return entries.map((entry) => import_path7.default.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
}
async function collectJavaScriptFiles3(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await import_fs6.default.promises.readdir(currentDir, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const entryPath = import_path7.default.join(currentDir, entry.name);
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
  await Promise.all(outputFiles.map((outputFile) => import_fs6.default.promises.copyFile(outputFile, import_path7.default.join(outDir, import_path7.default.basename(outputFile)))));
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
var build2 = (options) => build(options);
async function runCli(args) {
  const { options, showHelp } = parseCliArgs(args);
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
