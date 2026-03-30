// src/cli/parse-options.ts
import minimist from "minimist";

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

// src/pipeline/build-pipeline.ts
import fs6 from "fs";
import path5 from "path";

// src/cache/store.ts
import fs from "fs";
import os from "os";
import path from "path";

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

// src/cache/store.ts
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = path.join(rootDir2, "workspace");
    await fs.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await fs.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = path.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path.join(rootDir, hashContent(projectRoot));
  const workspaceDir = path.join(projectCacheDir, "workspace");
  await fs.promises.mkdir(workspaceDir, { recursive: true });
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
    const raw = await fs.promises.readFile(filePath, "utf-8");
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
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
async function ensureDirectoryExistence(filePath) {
  const dirName = path.dirname(filePath);
  if (await fs.promises.access(dirName).then(() => true).catch(() => false)) {
    return;
  }
  await fs.promises.mkdir(dirName, { recursive: true });
}

// src/pipeline/resolve-build.ts
import fs3 from "fs";
import path2 from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

// src/native/load.ts
import fs2 from "fs";
import { createRequire } from "module";
var require2 = createRequire(import.meta.url);
var cachedBinding = null;
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  const nativeModulePath = require2.resolve("gcc-ts-bundler/native");
  if (!fs2.existsSync(nativeModulePath)) {
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
  const packageJsonRaw = await fs3.promises.readFile(path2.join(packageRoot, "package.json"), "utf-8");
  const packageJson = JSON.parse(packageJsonRaw);
  const runtimeSignature = await readRuntimeSignature(packageRoot);
  const nativeSignature = await readNativeSignature(packageRoot);
  const packageSignature = hashContent(`${packageJsonRaw}
${runtimeSignature}
${nativeSignature}`);
  const sourceRoot = path2.join(cacheStore.workspaceDir, "src");
  await ensureSourceSymlink(sourceRoot, options.srcDir);
  const compilerOptions = await loadCompilerOptions(options.projectRoot);
  const overlayEntries = options.entries.map((entry) => path2.join(sourceRoot, path2.relative(options.srcDir, entry)));
  const graphResult = resolveGraph({
    entries: overlayEntries,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir
  });
  const outputNames = resolveOutputNames(options.entries.map((entry) => path2.relative(options.srcDir, entry)));
  const resolveKey = hashJson({
    compilerOptions,
    entries: options.entries.map((entry) => path2.relative(options.srcDir, entry)),
    files: graphResult.fileHashes,
    packageSignature
  });
  const resolveMetadataPath = path2.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = await readJsonIfExists(resolveMetadataPath);
  const isResolveCacheHit = resolveMetadata !== null;
  if (!resolveMetadata) {
    resolveMetadata = {
      entryFiles: graphResult.entries.map((entry, index) => ({
        chunkName: sanitizeChunkName(outputNames[index]),
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: outputNames[index],
        sourceRelativePath: path2.relative(sourceRoot, entry.sourcePath)
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
    outputPath: path2.join(options.outDir, entry.outputName),
    sourcePath: path2.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  }));
  const shimDir = path2.join(cacheStore.workspaceDir, "entries");
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
    finalCacheDir: path2.join(cacheStore.projectCacheDir, "final", finalKey),
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
    shimFiles: entryFiles.map((entry) => path2.join(shimDir, `${entry.chunkName}.ts`)),
    sourceRoot,
    tsConfigPath: path2.join(options.projectRoot, "tsconfig.json"),
    nativeEmitCacheDir: path2.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    nativeEmitKey,
    workspaceDir: cacheStore.workspaceDir
  };
}
function resolveOutputNames(entryPaths) {
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => path2.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
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
    const currentTarget = await fs3.promises.readlink(linkPath);
    if (path2.resolve(path2.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs3.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs3.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await fs3.promises.mkdir(path2.dirname(linkPath), { recursive: true });
  await fs3.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function loadCompilerOptions(projectRoot) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot, {}, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, ts.createCompilerHost({})));
  }
  return parsedConfig.options;
}
function toRelativeGraph(graph, workspaceDir) {
  return Object.fromEntries(Object.entries(graph).map(([filePath, dependencies]) => [
    path2.relative(workspaceDir, filePath),
    dependencies.map((dependency) => path2.relative(workspaceDir, dependency))
  ]));
}
function fromRelativeGraph(graph, workspaceDir) {
  return Object.fromEntries(Object.entries(graph).map(([filePath, dependencies]) => [
    path2.join(workspaceDir, filePath),
    dependencies.map((dependency) => path2.join(workspaceDir, dependency))
  ]));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await fs3.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
function getPackageRoot() {
  return path2.dirname(path2.dirname(fileURLToPath(import.meta.url)));
}
async function readRuntimeSignature(packageRoot) {
  try {
    return await fs3.promises.readFile(path2.join(packageRoot, "dist", "index.mjs"), "utf-8");
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot) {
  try {
    const contents = await fs3.promises.readFile(path2.join(packageRoot, "native", "index.node"));
    return hashContent(contents.toString("base64"));
  } catch {
    return "";
  }
}
function normalizeBuildOptions(options) {
  const projectRoot = path2.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path2.resolve(projectRoot, options.srcDir ?? "src");
  const outDir = path2.resolve(projectRoot, options.outDir ?? "dist");
  return {
    cache: {
      dir: options.cache?.dir ? path2.resolve(projectRoot, options.cache.dir) : "",
      mode: options.cache?.mode ?? "persistent"
    },
    compilationLevel: options.compilationLevel ?? "ADVANCED",
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? false,
      preflight: options.diagnostics?.preflight ?? "errors-only",
      verbose: options.diagnostics?.verbose ?? false
    },
    entries: options.entries.map((entry) => path2.isAbsolute(entry) ? entry : path2.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => path2.isAbsolute(filePath) ? filePath : path2.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => path2.isAbsolute(filePath) ? filePath : path2.resolve(projectRoot, filePath)),
    languageOut: options.languageOut ?? "ECMASCRIPT_NEXT",
    outDir,
    projectRoot,
    srcDir
  };
}

// src/stages/native/emit.ts
import fs4 from "fs";
import path3 from "path";
import ts2 from "typescript";
async function emitNativeStage({
  cacheDir,
  compilerOptions,
  fileNames,
  metadataPath,
  options,
  workspaceDir
}) {
  const outDir = path3.join(cacheDir, "out");
  const externsPath = path3.join(cacheDir, "modules-externs.js");
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
  await fs4.promises.rm(outDir, { force: true, recursive: true });
  await fs4.promises.mkdir(outDir, { recursive: true });
  const finalCompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    moduleResolution: ts2.ModuleResolutionKind.Bundler,
    outDir,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts2.ScriptTarget.ESNext
  };
  const compilerHost = ts2.createCompilerHost(finalCompilerOptions);
  const program = ts2.createProgram(fileNames, finalCompilerOptions, compilerHost);
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
  await fs4.promises.writeFile(metadataPath, JSON.stringify({
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
    return [...ts2.getPreEmitDiagnostics(program)];
  }
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics()
  ];
}
async function readMetadata(metadataPath) {
  try {
    const raw = await fs4.promises.readFile(metadataPath, "utf-8");
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
    await fs4.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// src/stages/closure/run-closure.ts
import fs5 from "fs/promises";
import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
import path4 from "path";
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
  await fs5.rm(finalCacheDir, { force: true, recursive: true });
  await fs5.mkdir(finalCacheDir, { recursive: true });
  const rawDir = path4.join(finalCacheDir, "raw");
  const outputDir = path4.join(finalCacheDir, "outputs");
  await fs5.mkdir(rawDir, { recursive: true });
  await fs5.mkdir(outputDir, { recursive: true });
  const closureLibFiles = await collectJavaScriptFiles(path4.join(packageRoot, "closure-lib"));
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
    rawOutputPath: path4.join(rawDir, `${chunkPlan[0].name}.js`)
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
    const contents = await fs5.readFile(rawFile, "utf-8");
    const transformed = rewriteGccExports(contents);
    await fs5.writeFile(path4.join(outputDir, path4.basename(rawFile)), transformed);
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
    chunkOutputPathPrefix: `${outputDir}${path4.sep}`,
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
  return files.map((filePath) => path4.join(emittedOutDir, path4.relative(workspaceDir, filePath).replace(/\.[^/.]+$/, ".js")));
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
    const entries = await fs5.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path4.join(currentDir, entry.name);
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
    const finalMetadataPath = path5.join(resolved.finalCacheDir, "meta.json");
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
        importPath: toImportPath(path5.relative(path5.dirname(path5.join(resolved.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
        shimPath: path5.join(resolved.shimDir, `${entry.chunkName}.ts`)
      }))
    });
    const nativeEmitMetadataPath = path5.join(resolved.nativeEmitCacheDir, "meta.json");
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
    const finalOutputFiles = await collectJavaScriptFiles2(path5.join(resolved.finalCacheDir, "outputs"));
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
  const projectRoot = path5.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path5.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path5.join(cacheRoot, hashContent(projectRoot));
  await fs6.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function collectBundledExterns(packageRoot) {
  const closureExternsPath = path5.join(packageRoot, "closure-externs");
  const entries = await fs6.promises.readdir(closureExternsPath);
  return entries.map((entry) => path5.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
}
async function collectJavaScriptFiles2(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await fs6.promises.readdir(currentDir, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const entryPath = path5.join(currentDir, entry.name);
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
  await fs6.promises.rm(outDir, { force: true, recursive: true });
  await fs6.promises.mkdir(outDir, { recursive: true });
  await Promise.all(outputFiles.map((outputFile) => fs6.promises.copyFile(outputFile, path5.join(outDir, path5.basename(outputFile)))));
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
async function pathExists2(filePath) {
  try {
    await fs6.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// src/api/build.ts
var build2 = (options) => build(options);
export {
  cleanCache,
  build2 as build,
  DEFAULT_BUILD_OPTIONS
};
