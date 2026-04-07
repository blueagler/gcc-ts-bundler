// src/cli/parse-options.ts
import minimist from "minimist";

// src/api/types.ts
var DEFAULT_BUILD_OPTIONS = Object.freeze({
  cache: {
    dir: "",
    mode: "persistent"
  },
  compilationLevel: "ADVANCED",
  chunks: {
    baseChunkName: "main",
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

// src/pipeline/build-pipeline.ts
import path7 from "path";
import fs7 from "fs";

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
import fs from "fs";
import os from "os";
import path from "path";
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

// src/internal/file-state.ts
import fs3 from "fs";
import path2 from "path";

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
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.metadataPath, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? [], input.lazyImports ?? []);
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
    const outEntries = (await fs3.promises.readdir(outDir)).sort();
    const expectedEntries = outputFiles.map((outputFile) => path2.basename(outputFile)).sort();
    if (outEntries.length !== expectedEntries.length || outEntries.some((entry, index) => entry !== expectedEntries[index])) {
      return false;
    }
    const destinationFiles = outputFiles.map((outputFile) => path2.join(outDir, path2.basename(outputFile)));
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
    const outEntries = (await fs3.promises.readdir(outDir)).sort();
    const expectedEntries = publishedOutputs.map(({ name }) => name).sort();
    if (outEntries.length !== expectedEntries.length || outEntries.some((entry, index) => entry !== expectedEntries[index])) {
      return false;
    }
    const states = collectFileStates(publishedOutputs.map(({ name }) => path2.join(outDir, name)));
    const stateMap = new Map(states.map((state) => [state.filePath, state]));
    return publishedOutputs.every(({ name, size }) => {
      const state = stateMap.get(path2.join(outDir, name));
      return state?.exists === true && state.size === size;
    });
  } catch {
    return false;
  }
}
async function collectPublishedOutputStats(outputFiles) {
  const states = collectFileStates(outputFiles);
  return states.filter((state) => state.exists).map((state) => ({
    name: path2.basename(state.filePath),
    size: state.size
  })).sort((left, right) => left.name.localeCompare(right.name));
}
async function copyOrLinkFiles(sourceFiles, outDir) {
  await fs3.promises.rm(outDir, { force: true, recursive: true });
  await fs3.promises.mkdir(outDir, { recursive: true });
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = path2.join(outDir, path2.basename(sourceFile));
    try {
      await fs3.promises.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await fs3.promises.copyFile(sourceFile, destinationFile);
    }
  }));
}

// src/pipeline/resolve-build.ts
import fs4 from "fs";
import path3 from "path";
import ts from "typescript";
import { fileURLToPath } from "url";
async function createBuildContext(options) {
  const packageRoot = getPackageRoot();
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot,
    packageSignature: await getPackageSignature(packageRoot),
    projectCacheDir: path3.join(path3.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), hashContent(options.projectRoot))
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
  const sourceRoot = path3.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = await hashTsConfig(tsConfigPath);
  const entryRelativePaths = options.entries.map((entry) => path3.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => path3.join(sourceRoot, path3.relative(options.srcDir, entry)));
  const resolveSnapshotPath = path3.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = await readJsonIfExists(resolveSnapshotPath);
  if (cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => ({
      chunkName: entry.chunkName,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: entry.outputName,
      sourcePath: path3.join(sourceRoot, entry.sourceRelativePath),
      sourceRelativePath: entry.sourceRelativePath
    }));
    const shimDir2 = path3.join(cacheStore.workspaceDir, "entries");
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      lazyImports: cachedSnapshot.lazyImports ?? [],
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: path3.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: path3.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: entryFiles2.map((entry) => path3.join(shimDir2, `${entry.chunkName}.ts`)),
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
  const resolvedLazyImports = assignLazyRuntimeBindings(graphResult.lazyImports);
  const resolveKey = hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature
  });
  const resolveMetadataPath = path3.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = await readJsonIfExists(resolveMetadataPath);
  if (!resolveMetadata) {
    const entryFiles2 = graphResult.entries.map((entry, index) => ({
      chunkName: sanitizeChunkName(outputNames[index]),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: outputNames[index],
      sourcePath: entry.sourcePath,
      sourceRelativePath: path3.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = path3.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = entryFiles2.map((entry) => path3.join(shimDir2, `${entry.chunkName}.ts`));
    resolveMetadata = {
      chunkPlan: buildChunkPlan({
        chunkOptions: options.chunks,
        entryFiles: entryFiles2,
        graph: {
          ...graphResult.graph,
          ...Object.fromEntries(shimFiles2.map((shimFile, index) => [
            shimFile,
            [entryFiles2[index].sourcePath]
          ]))
        },
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
      lazyImports: resolvedLazyImports
    };
    await writeJson(resolveMetadataPath, resolveMetadata);
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => ({
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: path3.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  }));
  const shimDir = path3.join(cacheStore.workspaceDir, "entries");
  const shimFiles = entryFiles.map((entry) => path3.join(shimDir, `${entry.chunkName}.ts`));
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
    lazyImports: resolvedLazyImports,
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
    lazyImports: resolvedLazyImports,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    finalCacheDir: path3.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: path3.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
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
  const basenames = entryPaths.map((entryPath) => path3.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
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
    const currentTarget = await fs4.promises.readlink(linkPath);
    if (path3.resolve(path3.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs4.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs4.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await fs4.promises.mkdir(path3.dirname(linkPath), { recursive: true });
  await fs4.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = path3.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = path3.join(options.projectRoot, "node_modules");
  const hasNodeModules = await fs4.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function removePathIfExists(targetPath) {
  try {
    await fs4.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function hashTsConfig(configPath) {
  return hashContent(await fs4.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await fs4.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = path3.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
function buildChunkPlan({
  chunkOptions,
  entryFiles,
  graph,
  lazyImports,
  shimFiles,
  workspaceDir
}) {
  if (chunkOptions.mode === "closure-library") {
    return buildClosureChunkPlan({
      baseChunkName: chunkOptions.baseChunkName,
      entryFiles,
      graph,
      lazyImports,
      workspaceDir
    });
  }
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
function buildClosureChunkPlan({
  baseChunkName,
  entryFiles,
  graph,
  lazyImports,
  workspaceDir
}) {
  const baseChunk = sanitizeChunkName(baseChunkName);
  const baseReachable = new Set;
  for (const entry of entryFiles) {
    for (const filePath of walkReachableFiles(entry.sourcePath, graph)) {
      baseReachable.add(filePath);
    }
  }
  const uniqueLazyImports = dedupeLazyImports(lazyImports);
  if (uniqueLazyImports.length === 0) {
    return [
      {
        dependencies: [],
        entryFiles: entryFiles.map((entry) => path3.relative(workspaceDir, entry.sourcePath)),
        files: toRelativeFiles(topologicalSort(Array.from(baseReachable), graph), workspaceDir),
        kind: "base",
        name: baseChunk
      }
    ];
  }
  const lazyRootTargets = new Set(uniqueLazyImports.map((item) => item.targetPath));
  const lazyClosures = uniqueLazyImports.map((lazyImport) => ({
    lazyImport,
    reachable: new Set(Array.from(walkReachableFiles(lazyImport.targetPath, graph)).filter((filePath) => !baseReachable.has(filePath)))
  }));
  const sharedCounts = new Map;
  for (const closure of lazyClosures) {
    for (const filePath of closure.reachable) {
      if (lazyRootTargets.has(filePath)) {
        continue;
      }
      sharedCounts.set(filePath, (sharedCounts.get(filePath) ?? 0) + 1);
    }
  }
  const sharedLazyFiles = new Set(Array.from(sharedCounts.entries()).filter(([, count]) => count > 1).map(([filePath]) => filePath));
  const chunks = [
    {
      dependencies: [],
      entryFiles: entryFiles.map((entry) => path3.relative(workspaceDir, entry.sourcePath)),
      files: toRelativeFiles(topologicalSort(Array.from(baseReachable), graph), workspaceDir),
      kind: "base",
      lazyModuleIds: uniqueLazyImports.filter((item) => baseReachable.has(item.targetPath)).map((item) => item.moduleId),
      name: baseChunk
    }
  ];
  const sharedChunkName = `${baseChunk}-shared`;
  if (sharedLazyFiles.size > 0) {
    chunks.push({
      dependencies: [baseChunk],
      files: toRelativeFiles(topologicalSort(Array.from(sharedLazyFiles), graph), workspaceDir),
      kind: "shared",
      name: sharedChunkName
    });
  }
  for (const { lazyImport, reachable } of lazyClosures) {
    if (baseReachable.has(lazyImport.targetPath)) {
      continue;
    }
    const chunkFiles = Array.from(reachable).filter((filePath) => !sharedLazyFiles.has(filePath));
    chunks.push({
      dependencies: [
        baseChunk,
        ...sharedLazyFiles.size > 0 ? [sharedChunkName] : []
      ],
      files: toRelativeFiles(topologicalSort(chunkFiles, graph), workspaceDir),
      kind: "lazy",
      lazyModuleIds: [lazyImport.moduleId],
      name: sanitizeChunkName(`${path3.relative(workspaceDir, lazyImport.targetPath).replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "-")}-lazy`)
    });
  }
  return chunks;
}
function dedupeLazyImports(lazyImports) {
  return [
    ...new Map(lazyImports.map((item) => [item.moduleId, item])).values()
  ];
}
function assignLazyRuntimeBindings(lazyImports) {
  const byModuleId = [...new Set(lazyImports.map((item) => item.moduleId))].sort((left, right) => left.localeCompare(right));
  const bindingMap = new Map(byModuleId.map((moduleId, index) => [
    moduleId,
    {
      preloadBindingName: `__gcc_preload_${index}`,
      runtimeBindingName: `__gcc_lazy_${index}`
    }
  ]));
  return lazyImports.map((item) => ({
    ...item,
    ...bindingMap.get(item.moduleId)
  }));
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
    const relativeFile = path3.relative(workspaceDir, filePath);
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
  return path3.dirname(path3.dirname(fileURLToPath(import.meta.url)));
}
async function readRuntimeSignature(packageRoot) {
  try {
    const stat = await fs4.promises.stat(path3.join(packageRoot, "dist", "index.mjs"));
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
    const stat = await fs4.promises.stat(path3.join(packageRoot, "native", "index.node"));
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
      const packageJsonStat = await fs4.promises.stat(path3.join(packageRoot, "package.json"));
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
    chunks: options.chunks,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => path3.relative(options.srcDir, entry)),
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
  const projectRoot = path3.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path3.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = path3.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  const chunkPublicPath = normalizeChunkPublicPath(options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath);
  const chunkManifestFile = path3.basename(options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile);
  return {
    cache: {
      dir: options.cache?.dir ? path3.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
    },
    chunks: {
      baseChunkName: options.chunks?.baseChunkName ?? DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
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
    entries: options.entries.map((entry) => path3.isAbsolute(entry) ? entry : path3.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => path3.isAbsolute(filePath) ? filePath : path3.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => path3.isAbsolute(filePath) ? filePath : path3.resolve(projectRoot, filePath)),
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

// src/stages/native/emit.ts
import fs5 from "fs";
import { createRequire as createRequire2 } from "module";
import path5 from "path";
import ts4 from "typescript";

// src/stages/native/compiler-options.ts
import path4 from "path";
import ts2 from "typescript";
import { fileURLToPath as fileURLToPath2 } from "url";
var RUNTIME_SPECIFIER = "gcc-ts-bundler/runtime";
var PACKAGE_ROOT = path4.resolve(path4.dirname(fileURLToPath2(import.meta.url)), "..", "..", "..");
function loadCompilerOptions(configPath, extraOptions = {}) {
  const configDir = path4.dirname(configPath);
  const configFile = ts2.readConfigFile(configPath, ts2.sys.readFile);
  if (configFile.error) {
    throw new Error(ts2.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = ts2.parseJsonConfigFileContent(configFile.config, ts2.sys, configDir, {
    ...extraOptions,
    baseUrl: extraOptions.baseUrl ?? configFile.config.compilerOptions?.baseUrl ?? configDir,
    ignoreDeprecations: extraOptions.ignoreDeprecations ?? configFile.config.compilerOptions?.ignoreDeprecations ?? "6.0",
    paths: {
      ...configFile.config.compilerOptions?.paths ?? {},
      ...extraOptions.paths ?? {},
      [RUNTIME_SPECIFIER]: [path4.join(PACKAGE_ROOT, "src", "runtime", "index.ts")]
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(ts2.formatDiagnosticsWithColorAndContext(parsedConfig.errors, ts2.createCompilerHost({})));
  }
  return parsedConfig.options;
}

// src/stages/native/closure-ir.ts
import ts3 from "typescript";
async function collectClosureIrMetadata({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    rootDir: workspaceDir
  });
  const program = ts3.createProgram(fileNames, compilerOptions);
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
      if (ts3.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker));
        continue;
      }
      if (ts3.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker));
        continue;
      }
      if (ts3.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols);
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }
      if (ts3.isFunctionDeclaration(statement) && statement.name) {
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
      if (ts3.isClassDeclaration(statement) && statement.name) {
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
      const transpiled = ts3.transpileModule(sourceFile.getFullText(), {
        compilerOptions: {
          ...compilerOptions,
          module: ts3.ModuleKind.ESNext,
          moduleResolution: ts3.ModuleResolutionKind.Bundler,
          sourceMap: false,
          target: ts3.ScriptTarget.ES2018
        },
        fileName: sourceFile.fileName,
        reportDiagnostics: true
      });
      diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts3.DiagnosticCategory.Error));
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
    if (ts3.canHaveDecorators(node) && (ts3.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    ts3.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function collectUnsafeEnumSymbols(program, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & ts3.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node) => {
      if (ts3.isElementAccessExpression(node) && ts3.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (ts3.isCallExpression(node) && ts3.isPropertyAccessExpression(node.expression) && ts3.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && ts3.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (ts3.isIdentifier(node) && !ts3.isPropertyAccessExpression(node.parent) && !ts3.isElementAccessExpression(node.parent) && !ts3.isImportSpecifier(node.parent) && !ts3.isImportClause(node.parent) && !ts3.isExportSpecifier(node.parent) && !ts3.isEnumDeclaration(node.parent) && !ts3.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & ts3.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & ts3.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      ts3.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & ts3.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
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
    if (ts3.isPropertySignature(member)) {
      const propertyType = member.type ? toClosureType(checker.getTypeFromTypeNode(member.type), checker) : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
      continue;
    }
    if (ts3.isMethodSignature(member)) {
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
  if (!firstParameter || !ts3.isObjectBindingPattern(firstParameter.name) || hasRestElement(firstParameter.name)) {
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
function hasRestElement(pattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}
function isComponentLikeName(name) {
  return !!name && /^[A-Z]/.test(name);
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
        if (clause.token === ts3.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === ts3.SyntaxKind.ImplementsKeyword) {
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
  return (ts3.getCombinedModifierFlags(node) & ts3.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (ts3.getCombinedModifierFlags(node) & ts3.ModifierFlags.Const) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (ts3.isIdentifier(name) || ts3.isStringLiteral(name) || ts3.isNumericLiteral(name) || ts3.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `[${JSON.stringify(name)}]`;
}
function literalValueFromExpression(expression) {
  if (ts3.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts3.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts3.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts3.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts3.isPrefixUnaryExpression(expression) && expression.operator === ts3.SyntaxKind.MinusToken && ts3.isNumericLiteral(expression.operand)) {
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
  if (type.flags & ts3.TypeFlags.Any) {
    return "?";
  }
  if (type.flags & ts3.TypeFlags.Unknown) {
    return "?";
  }
  if (type.flags & ts3.TypeFlags.StringLike) {
    return "string";
  }
  if (type.flags & ts3.TypeFlags.NumberLike) {
    return "number";
  }
  if (type.flags & ts3.TypeFlags.BooleanLike) {
    return "boolean";
  }
  if (type.flags & ts3.TypeFlags.Void) {
    return "void";
  }
  if (type.flags & ts3.TypeFlags.Undefined) {
    return "undefined";
  }
  if (type.flags & ts3.TypeFlags.Null) {
    return "null";
  }
  if (type.flags & ts3.TypeFlags.Never) {
    return "never";
  }
  if (type.flags & ts3.TypeFlags.TypeParameter) {
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
  if (type.isClassOrInterface() || type.getProperties().length > 0 && !(type.flags & ts3.TypeFlags.Object)) {
    return "!Object";
  }
  return "?";
}

// src/stages/native/emit.ts
var require3 = createRequire2(import.meta.url);
var NATIVE_EMIT_METADATA_VERSION = 6;
async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir
}) {
  const outDir = path5.join(cacheDir, "out");
  const externsPath = path5.join(cacheDir, "modules-externs.js");
  const metadataPathForNative = path5.join(cacheDir, "closure-ir.json");
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
  await fs5.promises.rm(outDir, { force: true, recursive: true });
  await fs5.promises.mkdir(outDir, { recursive: true });
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
  await fs5.promises.writeFile(metadataPathForNative, JSON.stringify(closureIr.files, null, 2), "utf-8");
  const result = transpileSources({
    metadataPath: metadataPathForNative,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir
  });
  const finalSupportFiles = uniqueSorted2([
    ...runtimeSupportFiles,
    ...result.supportFiles
  ]);
  await fs5.promises.writeFile(metadataPath, JSON.stringify({
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
    srcDir: path5.join(workspaceDir, "src"),
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
    moduleResolution: ts4.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts4.ScriptTarget.ESNext
  };
  const compilerHost = ts4.createCompilerHost(finalCompilerOptions);
  const program = ts4.createProgram(fileNames, finalCompilerOptions, compilerHost);
  return [...ts4.getPreEmitDiagnostics(program)].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic));
}
function createSimpleDiagnostic(messageText) {
  return {
    category: ts4.DiagnosticCategory.Error,
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
  const message = ts4.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
}
function getJsxRuntimeSpecifier(compilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case ts4.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts4.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
async function readMetadata(metadataPath) {
  try {
    const raw = await fs5.promises.readFile(metadataPath, "utf-8");
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
  return path5.join(outDir, path5.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
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
  const marker = `${path5.sep}node_modules${path5.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path5.join(workspaceDir, relativeNodeModulesPath);
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
import fs6 from "fs/promises";
import path6 from "path";
import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
var closureLibFilesCache = new Map;
var CHUNK_NAMESPACE = "__gcc$chunks";
var CHUNK_MANAGER_JUSTIFICATION = "Generated by gcc-ts-bundler chunk runtime.";
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  externPaths,
  finalCacheDir,
  options,
  outDir,
  supportFiles,
  lazyImports,
  packageRoot
}) {
  await fs6.rm(finalCacheDir, { force: true, recursive: true });
  await fs6.mkdir(finalCacheDir, { recursive: true });
  const rawDir = path6.join(finalCacheDir, "raw");
  const cacheOutputDir = path6.join(finalCacheDir, "outputs");
  const supportDir = path6.join(emittedOutDir, "__gcc_chunk_support");
  await fs6.mkdir(rawDir, { recursive: true });
  await fs6.mkdir(cacheOutputDir, { recursive: true });
  await fs6.rm(supportDir, { force: true, recursive: true });
  await fs6.mkdir(supportDir, { recursive: true });
  await fs6.rm(outDir, { force: true, recursive: true });
  await fs6.mkdir(outDir, { recursive: true });
  const resolvedChunks = resolveChunkPlan(chunkPlan, emittedOutDir);
  let finalSupportFiles = [...supportFiles];
  let manifestOutputPath = null;
  let runtimeEntryPoint = null;
  if (options.chunks.mode === "closure-library") {
    const chunkAssets = await createChunkRuntimeAssets({
      chunkPlan: resolvedChunks,
      emittedOutDir,
      lazyImports,
      options,
      supportDir
    });
    finalSupportFiles = uniquePaths([
      ...supportFiles,
      chunkAssets.runtimeSupportFile
    ]);
    runtimeEntryPoint = chunkAssets.runtimeModuleId;
    applyChunkBridgesToResolvedChunks(resolvedChunks, chunkAssets.bridgeFiles);
    if (options.chunks.manifestFile) {
      manifestOutputPath = path6.join(outDir, options.chunks.manifestFile);
      await fs6.mkdir(path6.dirname(manifestOutputPath), { recursive: true });
      await fs6.writeFile(manifestOutputPath, chunkAssets.manifestText, "utf-8");
      await fs6.mkdir(path6.join(cacheOutputDir, path6.dirname(options.chunks.manifestFile)), {
        recursive: true
      });
      await fs6.writeFile(path6.join(cacheOutputDir, options.chunks.manifestFile), chunkAssets.manifestText, "utf-8");
    }
  }
  const closureLibFiles = await collectClosureLibFiles(packageRoot, [
    ...finalSupportFiles,
    ...resolvedChunks.flatMap((chunk) => chunk.files)
  ]);
  const exitCode = resolvedChunks.length === 1 && options.chunks.mode !== "closure-library" ? await runSingleClosureCompilation({
    closureLibFiles,
    entryChunk: resolvedChunks[0],
    externPaths,
    options,
    supportFiles: finalSupportFiles,
    rawOutputPath: path6.join(rawDir, `${resolvedChunks[0].name}.js`)
  }) : await runChunkedClosureCompilation({
    chunkPlan: resolvedChunks,
    closureLibFiles,
    externPaths,
    options,
    outputDir: rawDir,
    runtimeEntryPoint,
    supportFiles: finalSupportFiles,
    wrapperNamespace: toChunkWrapperNamespace(options.chunks.baseChunkName || resolvedChunks[0]?.name || "main")
  });
  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }
  const rawOutputs = resolvedChunks.map((chunk) => path6.join(rawDir, `${chunk.name}.js`));
  const outputFiles = resolvedChunks.map((chunk) => path6.join(outDir, `${chunk.name}.js`));
  if (options.chunks.mode === "closure-library") {
    await Promise.all(rawOutputs.map(async (rawFile, index) => {
      const contents = await fs6.readFile(rawFile, "utf-8");
      await fs6.writeFile(outputFiles[index], contents);
    }));
  } else {
    await Promise.all(rawOutputs.map(async (rawFile, index) => {
      const contents = await fs6.readFile(rawFile, "utf-8");
      const transformed = rewriteGccExports(contents);
      await fs6.writeFile(outputFiles[index], transformed);
    }));
  }
  const publishedFiles = manifestOutputPath === null ? outputFiles : [...outputFiles, manifestOutputPath];
  await copyOrLinkFiles(publishedFiles, cacheOutputDir);
  const cacheOutputFiles = publishedFiles.map((outputFile) => path6.join(cacheOutputDir, path6.relative(outDir, outputFile)));
  return { cacheOutputFiles, exitCode: 0, outputFiles: publishedFiles };
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
  if (entryChunk.entryPoints.length > 0) {
    closureOptions.entryPoint = entryChunk.entryPoints;
  }
  applyInternalClosureDebugOptions(closureOptions);
  return runClosureCompiler(closureOptions);
}
async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir,
  runtimeEntryPoint,
  supportFiles,
  wrapperNamespace
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
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${path6.sep}`,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  };
  const entryPoints = uniquePaths([
    ...runtimeEntryPoint ? [runtimeEntryPoint] : [],
    ...chunkPlan.flatMap((chunk) => chunk.entryPoints)
  ]);
  if (entryPoints.length > 0) {
    closureOptions.entryPoint = entryPoints;
  }
  if (options.chunks.mode === "closure-library") {
    const mutableOptions = closureOptions;
    mutableOptions.chunkOutputType = "GLOBAL_NAMESPACE";
    mutableOptions.renamePrefixNamespace = CHUNK_NAMESPACE;
    mutableOptions.chunkWrapper = chunkPlan.map((chunk) => `${chunk.name}:${createChunkWrapper(chunk, wrapperNamespace)}`);
  }
  applyInternalClosureDebugOptions(closureOptions);
  return runClosureCompiler(closureOptions);
}
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
async function createChunkRuntimeAssets({
  chunkPlan,
  emittedOutDir,
  lazyImports,
  options,
  supportDir
}) {
  const baseChunk = chunkPlan.find((chunk) => chunk.kind === "base") ?? chunkPlan[0];
  const chunkUrls = chunkPlan.map((chunk) => `${options.chunks.publicPath}${chunk.name}.js`);
  const uniqueLazyImports = dedupeLazyImports2(lazyImports);
  const bridgeFiles = await Promise.all(uniqueLazyImports.map(async (lazyImport, index) => {
    const chunkName = chunkPlan.find((chunk) => chunk.lazyModuleIds.includes(lazyImport.moduleId))?.name;
    if (!chunkName) {
      throw new Error(`Missing lazy chunk for ${lazyImport.moduleId}`);
    }
    const filePath = path6.join(supportDir, `lazy-bridge-${index}.js`);
    const moduleId = toGoogModuleId(filePath, emittedOutDir);
    await fs6.writeFile(filePath, renderLazyBridgeModule(moduleId, lazyImport.moduleId), "utf-8");
    return {
      chunkName,
      filePath,
      moduleId,
      preloadBindingName: lazyImport.preloadBindingName ?? `__gcc_preload_${index}`,
      runtimeBindingName: lazyImport.runtimeBindingName ?? `__gcc_lazy_${index}`
    };
  }));
  const manifest = {
    baseChunkName: baseChunk.name,
    chunkDependencies: Object.fromEntries(chunkPlan.map((chunk) => [chunk.name, chunk.dependencies])),
    chunkUrls: Object.fromEntries(chunkPlan.map((chunk) => [
      chunk.name,
      `${options.chunks.publicPath}${chunk.name}.js`
    ])),
    lazyModules: Object.fromEntries(uniqueLazyImports.map((lazyImport) => [
      lazyImport.moduleId,
      chunkPlan.find((chunk) => chunk.lazyModuleIds.includes(lazyImport.moduleId))?.name ?? ""
    ])),
    namespace: CHUNK_NAMESPACE,
    publicPath: options.chunks.publicPath
  };
  const runtimeSupportFile = path6.join(supportDir, "runtime.js");
  await fs6.writeFile(runtimeSupportFile, renderChunkRuntimeSupport({
    bridgeFiles,
    chunkNames: chunkPlan.map((chunk) => chunk.name),
    chunkUrls,
    publicPath: options.chunks.publicPath,
    moduleInfoString: renderModuleInfoString(chunkPlan)
  }), "utf-8");
  return {
    bridgeFiles,
    manifestText: `${JSON.stringify(manifest, null, 2)}
`,
    runtimeModuleId: "gcc.__gcc_chunk_runtime",
    runtimeSupportFile
  };
}
function renderChunkRuntimeSupport({
  bridgeFiles,
  chunkNames,
  chunkUrls,
  publicPath,
  moduleInfoString
}) {
  const chunkUrlMap = Object.fromEntries(chunkNames.map((chunkName, index) => [chunkName, chunkUrls[index] ?? ""]));
  return [
    'goog.module("gcc.__gcc_chunk_runtime");',
    'const googModule = goog.require("goog.module");',
    'const ModuleLoader = goog.require("goog.module.ModuleLoader");',
    'const ModuleManager = goog.require("goog.module.ModuleManager");',
    'const uncheckedConversions = goog.require("goog.html.uncheckedconversions");',
    'const Const = goog.require("goog.string.Const");',
    `const __gcc_chunk_urls = ${JSON.stringify(chunkUrlMap)};`,
    `const __gcc_module_info = ${JSON.stringify(moduleInfoString)};`,
    `const __gcc_public_path = ${JSON.stringify(publicPath)};`,
    `const __gcc_justification = Const.from(${JSON.stringify(CHUNK_MANAGER_JUSTIFICATION)});`,
    "const __gcc_loader = new ModuleLoader();",
    "__gcc_loader.setUseScriptTags(true);",
    "const __gcc_manager = ModuleManager.getInstance();",
    "__gcc_manager.setLoader(__gcc_loader);",
    "__gcc_manager.setBatchModeEnabled(false);",
    "__gcc_manager.setConcurrentLoadingEnabled(false);",
    "__gcc_manager.setAllModuleInfoString(__gcc_module_info);",
    "__gcc_manager.setModuleTrustedUris((function() {",
    "  const baseUrl = document.currentScript && document.currentScript.src ? new URL(__gcc_public_path, document.currentScript.src).toString() : __gcc_public_path;",
    "  const trustedUris = {};",
    "  for (const chunkId in __gcc_chunk_urls) {",
    "    trustedUris[chunkId] = [uncheckedConversions.trustedResourceUrlFromStringKnownToSatisfyTypeContract(__gcc_justification, new URL(__gcc_chunk_urls[chunkId], baseUrl).toString())];",
    "  }",
    "  return trustedUris;",
    "})());",
    "__gcc_manager.setModuleContext(globalThis);",
    "function __gcc_load(chunkId, moduleId) {",
    "  return Promise.resolve(__gcc_manager.load(chunkId)).then(function() {",
    "    return googModule.get(moduleId);",
    "  });",
    "}",
    "function __gcc_preload(chunkId) {",
    "  return Promise.resolve(__gcc_manager.preloadModule(chunkId)).then(function() {});",
    "}",
    ...bridgeFiles.flatMap((bridge) => {
      return [
        `function ${bridge.runtimeBindingName}() { return __gcc_load(${JSON.stringify(bridge.chunkName)}, ${JSON.stringify(bridge.moduleId)}); }`,
        `function ${bridge.preloadBindingName}() { return __gcc_preload(${JSON.stringify(bridge.chunkName)}); }`,
        `exports.${bridge.runtimeBindingName} = ${bridge.runtimeBindingName};`,
        `exports.${bridge.preloadBindingName} = ${bridge.preloadBindingName};`
      ];
    }),
    ""
  ].join(`
`);
}
function renderLazyBridgeModule(moduleId, targetModuleId) {
  return [
    `goog.module(${JSON.stringify(moduleId)});`,
    `const __module = goog.require(${JSON.stringify(targetModuleId)});`,
    "for (const key in __module) {",
    '  if (key !== "default") {',
    "    exports[key] = __module[key];",
    "  }",
    "}",
    "exports.default = __module.default;",
    ""
  ].join(`
`);
}
function dedupeLazyImports2(lazyImports) {
  return [
    ...new Map(lazyImports.map((item) => [item.moduleId, item])).values()
  ];
}
function applyChunkBridgesToResolvedChunks(chunkPlan, bridgeFiles) {
  const bridgesByChunk = new Map;
  for (const bridge of bridgeFiles) {
    const existing = bridgesByChunk.get(bridge.chunkName) ?? [];
    existing.push(bridge);
    bridgesByChunk.set(bridge.chunkName, existing);
  }
  for (const chunk of chunkPlan) {
    const bridges = bridgesByChunk.get(chunk.name) ?? [];
    if (bridges.length === 0) {
      continue;
    }
    chunk.files.push(...bridges.map((bridge) => bridge.filePath));
    chunk.entryPoints = bridges.map((bridge) => bridge.moduleId);
  }
}
function createChunkWrapper(chunk, wrapperNamespace) {
  const namespaceTarget = `globalThis.${wrapperNamespace}=globalThis.${wrapperNamespace}||{}`;
  if (chunk.kind === "base") {
    return `(function(${CHUNK_NAMESPACE}){%output%}).call(this,${namespaceTarget});`;
  }
  return `(function(${CHUNK_NAMESPACE}){var __gcc_manager=goog.module.ModuleManager.getInstance();__gcc_manager.beforeLoadModuleCode(${JSON.stringify(chunk.name)});%output%__gcc_manager.setLoaded();}).call(this,${namespaceTarget});`;
}
function toChunkWrapperNamespace(baseChunkName) {
  const sanitized = baseChunkName.replace(/[^A-Za-z0-9_$]/g, "_");
  return `default_${sanitized}`;
}
function renderModuleInfoString(chunkPlan) {
  return chunkPlan.map((chunk) => {
    const dependencyIndexes = chunk.dependencies.map((dependency) => chunkPlan.findIndex((candidate) => candidate.name === dependency)).filter((index) => index >= 0).map((index) => index.toString(36));
    return dependencyIndexes.length > 0 ? `${chunk.name}:${dependencyIndexes.join(",")}` : chunk.name;
  }).join("/");
}
function resolveChunkPlan(chunkPlan, emittedOutDir) {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    entryPoints: chunk.entryFiles ? chunk.entryFiles.map((filePath) => toGoogModuleId(path6.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js")), emittedOutDir)) : (chunk.lazyModuleIds ?? []).length > 0 ? [...chunk.lazyModuleIds ?? []] : chunk.files.length > 0 ? [
      toGoogModuleId(path6.join(emittedOutDir, chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js")), emittedOutDir)
    ] : [],
    files: chunk.files.map((filePath) => path6.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js"))),
    kind: chunk.kind,
    lazyModuleIds: chunk.lazyModuleIds ?? [],
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
  const relativePath = path6.relative(moduleRoot, filePath).replace(/\\/g, "/");
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
    const entries = await fs6.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path6.join(currentDir, entry.name);
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
async function collectClosureLibFiles(packageRoot, candidateFiles) {
  const closureLibDir = path6.join(packageRoot, "closure-lib");
  const cacheKey = `${closureLibDir}\x00${await hashClosureLibSelection(candidateFiles)}`;
  const existing = closureLibFilesCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const filesPromise = selectClosureLibFiles(closureLibDir, candidateFiles);
  closureLibFilesCache.set(cacheKey, filesPromise);
  return filesPromise;
}
async function hashClosureLibSelection(filePaths) {
  const stats = await Promise.all(uniquePaths(filePaths).map(async (filePath) => {
    try {
      const stat = await fs6.stat(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${filePath}:missing`;
    }
  }));
  return stats.sort((left, right) => left.localeCompare(right)).join("|");
}
async function selectClosureLibFiles(closureLibDir, candidateFiles) {
  const usesChunkLoader = candidateFiles.some((filePath) => filePath.includes(`${path6.sep}__gcc_chunk_support${path6.sep}`));
  if (usesChunkLoader) {
    const vendoredLoaderFiles = await collectJavaScriptFiles(path6.join(closureLibDir, "goog"));
    return uniquePaths([path6.join(closureLibDir, "base.js"), ...vendoredLoaderFiles]);
  }
  const required = [path6.join(closureLibDir, "base.js")];
  const contents = (await Promise.all(uniquePaths(candidateFiles).map((filePath) => fs6.readFile(filePath, "utf-8").catch(() => "")))).join(`
`);
  if (contents.includes("goog.reflect.")) {
    required.push(path6.join(closureLibDir, "reflect.js"));
  }
  if (contents.includes("tslib")) {
    required.push(path6.join(closureLibDir, "tslib.js"));
  }
  return required;
}

// src/pipeline/build-pipeline.ts
var bundledExternsCache = null;
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  if (context.options.cache.mode === "persistent") {
    const fastSnapshot = await readJsonIfExists(path7.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: fastSnapshot.publishedOutputs.map(({ name }) => path7.join(context.options.outDir, name))
      };
    }
  }
  let resolved = null;
  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = path7.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = await readJsonIfExists(finalMetadataPath);
    if (context.options.cache.mode !== "off" && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: finalMetadata.outputFiles.map((outputFile) => path7.join(context.options.outDir, path7.basename(outputFile)))
      };
    }
    if (context.options.chunks.mode === "closure-library" && resolvedBuild.entryFiles.some((entry) => entry.exportNames.length > 0 || entry.hasDefaultExport)) {
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
    if (context.options.chunks.mode !== "closure-library") {
      writeEntryShims({
        entries: resolvedBuild.entryFiles.map((entry) => ({
          exportNames: entry.exportNames,
          hasDefaultExport: entry.hasDefaultExport,
          importPath: toImportPath(path7.relative(path7.dirname(path7.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
          shimPath: path7.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
        }))
      });
    }
    const nativeEmitMetadataPath = path7.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: context.options.chunks.mode === "closure-library" ? resolvedBuild.sourceFiles : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      lazyImports: resolvedBuild.lazyImports,
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
      lazyImports: resolvedBuild.lazyImports,
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
      await writeJson(path7.join(context.projectCacheDir, "final-fast.json"), {
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
  const projectRoot = path7.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path7.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path7.join(cacheRoot, hashContent(projectRoot));
  await fs7.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function collectBundledExterns(packageRoot) {
  if (!bundledExternsCache) {
    bundledExternsCache = (async () => {
      const closureExternsPath = path7.join(packageRoot, "closure-externs");
      const entries = await fs7.promises.readdir(closureExternsPath);
      return entries.map((entry) => path7.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
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
export {
  cleanCache,
  build2 as build,
  DEFAULT_BUILD_OPTIONS
};
