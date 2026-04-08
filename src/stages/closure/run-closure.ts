import fs from "fs/promises";
import path from "path";
import * as closureCompilerPackage from "google-closure-compiler";
// @ts-expect-error - package does not expose types for this internal helper.
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";

import { copyOrLinkFiles } from "../../internal/file-state";
import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
import { rewriteGccExports } from "../../native/load";

type ClosureCompilerClass = (typeof closureCompilerPackage)["compiler"] & {
  JAR_PATH?: unknown;
};

type ClosureCompilerInstance = InstanceType<ClosureCompilerClass> & {
  JAR_PATH?: null | string;
  javaPath?: string;
};

type ClosureCompilerPackageShape = typeof closureCompilerPackage & {
  JAR_PATH?: unknown;
};
type ClosureCompilerOptions = ConstructorParameters<ClosureCompilerClass>[0];

interface ClosureChunk {
  dependencies: string[];
  entryPoints: string[];
  files: string[];
  kind?: ChunkPlanChunk["kind"];
  lazyModuleIds: string[];
  name: string;
}

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

const closureLibFilesCache = new Map<string, Promise<string[]>>();
const BUNDLER_RUNTIME_GLOBAL = "__gcc_runtime__";

export async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  externPaths,
  finalCacheDir,
  options,
  outDir,
  supportFiles,
  packageRoot,
}: {
  chunkPlan: ChunkPlanChunk[];
  emittedOutDir: string;
  externPaths: string[];
  finalCacheDir: string;
  options: NormalizedBuildOptions;
  outDir: string;
  supportFiles: string[];
  packageRoot: string;
}): Promise<ClosureStageResult> {
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await fs.mkdir(finalCacheDir, { recursive: true });

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(cacheOutputDir, { recursive: true });
  await fs.rm(outDir, { force: true, recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const resolvedChunks = resolveChunkPlan(chunkPlan, emittedOutDir);
  let manifestOutputPath: string | null = null;

  if (options.chunks.mode === "bundler-runtime") {
    const bundlerAssets = await createBundlerRuntimeAssets({
      chunkPlan: resolvedChunks,
      emittedOutDir,
      finalCacheDir,
      options,
    });
    manifestOutputPath = bundlerAssets.manifestOutputPath;
    const exitCode = await runBundlerRuntimeCompilation({
      chunkPlan: resolvedChunks,
      chunkSources: bundlerAssets.chunkSources,
      externPaths: [...externPaths, bundlerAssets.runtimeExternsPath],
      options,
      outputDir: rawDir,
      packageRoot,
    });
    if (exitCode !== 0) {
      return { cacheOutputFiles: [], exitCode, outputFiles: [] };
    }

    const outputFiles = resolvedChunks.map((chunk) =>
      path.join(outDir, `${chunk.name}.js`),
    );
    await Promise.all(
      outputFiles.map((outputFile, index) =>
        fs.copyFile(
          path.join(rawDir, `${resolvedChunks[index].name}.js`),
          outputFile,
        ),
      ),
    );

    const publishedFiles =
      manifestOutputPath === null
        ? outputFiles
        : [...outputFiles, manifestOutputPath];
    await copyOrLinkFiles(publishedFiles, cacheOutputDir);
    const cacheOutputFiles = publishedFiles.map((outputFile) =>
      path.join(cacheOutputDir, path.relative(outDir, outputFile)),
    );

    return { cacheOutputFiles, exitCode: 0, outputFiles: publishedFiles };
  }
  const closureLibFiles = await collectClosureLibFiles(packageRoot, [
    ...supportFiles,
    ...resolvedChunks.flatMap((chunk) => chunk.files),
  ]);

  const exitCode =
    resolvedChunks.length === 1
      ? await runSingleClosureCompilation({
          closureLibFiles,
          entryChunk: resolvedChunks[0],
          externPaths,
          options,
          supportFiles,
          rawOutputPath: path.join(rawDir, `${resolvedChunks[0].name}.js`),
        })
      : await runChunkedClosureCompilation({
          chunkPlan: resolvedChunks,
          closureLibFiles,
          externPaths,
          options,
          outputDir: rawDir,
          supportFiles,
        });

  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }

  const rawOutputs = resolvedChunks.map((chunk) =>
    path.join(rawDir, `${chunk.name}.js`),
  );
  const outputFiles = resolvedChunks.map((chunk) =>
    path.join(outDir, `${chunk.name}.js`),
  );
  await Promise.all(
    rawOutputs.map(async (rawFile, index) => {
      const contents = await fs.readFile(rawFile, "utf-8");
      const transformed = rewriteGccExports(contents);
      await fs.writeFile(outputFiles[index], transformed);
    }),
  );

  const publishedFiles =
    manifestOutputPath === null
      ? outputFiles
      : [...outputFiles, manifestOutputPath];
  await copyOrLinkFiles(publishedFiles, cacheOutputDir);
  const cacheOutputFiles = publishedFiles.map((outputFile) =>
    path.join(cacheOutputDir, path.relative(outDir, outputFile)),
  );

  return { cacheOutputFiles, exitCode: 0, outputFiles: publishedFiles };
}

async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  supportFiles,
  rawOutputPath,
}: {
  closureLibFiles: string[];
  entryChunk: ClosureChunk;
  externPaths: string[];
  options: NormalizedBuildOptions;
  supportFiles: string[];
  rawOutputPath: string;
}) {
  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: uniquePaths([
      ...options.js,
      ...closureLibFiles,
      ...supportFiles,
      ...entryChunk.files,
    ]),
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
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
  supportFiles,
}: {
  chunkPlan: ClosureChunk[];
  closureLibFiles: string[];
  externPaths: string[];
  options: NormalizedBuildOptions;
  outputDir: string;
  supportFiles: string[];
}) {
  const leadingJs = uniquePaths([
    ...options.js,
    ...closureLibFiles,
    ...supportFiles,
  ]);
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix =
      chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${uniquePaths(chunk.files).length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = uniquePaths([
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files),
  ]);

  const closureOptions: ClosureCompilerOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${path.sep}`,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
  };
  const entryPoints = uniquePaths(
    chunkPlan.flatMap((chunk) => chunk.entryPoints),
  );
  if (entryPoints.length > 0) {
    closureOptions.entryPoint = entryPoints;
  }
  applyInternalClosureDebugOptions(closureOptions);
  return runClosureCompiler(closureOptions);
}

function applyInternalClosureDebugOptions(
  closureOptions: ClosureCompilerOptions,
) {
  const mutableOptions = closureOptions as ClosureCompilerOptions & {
    debug?: boolean;
    formatting?: string;
    useTypesForOptimization?: boolean;
  };
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
    mutableOptions.useTypesForOptimization = false;
  }
}

async function createBundlerRuntimeAssets({
  chunkPlan,
  emittedOutDir,
  finalCacheDir,
  options,
}: {
  chunkPlan: ClosureChunk[];
  emittedOutDir: string;
  finalCacheDir: string;
  options: NormalizedBuildOptions;
}) {
  const assetDir = path.join(finalCacheDir, "bundler-runtime");
  await fs.rm(assetDir, { force: true, recursive: true });
  await fs.mkdir(assetDir, { recursive: true });

  const baseChunk =
    chunkPlan.find((chunk) => chunk.kind === "base") ?? chunkPlan[0];
  const moduleMap = Object.fromEntries(
    chunkPlan.flatMap((chunk) =>
      chunk.files.map((filePath) => [
        toGoogModuleId(filePath, emittedOutDir),
        chunk.name,
      ]),
    ),
  );
  const chunkManifest = Object.fromEntries(
    chunkPlan.map((chunk) => [
      chunk.name,
      {
        deps: chunk.dependencies,
        modules: chunk.files.map((filePath) =>
          toGoogModuleId(filePath, emittedOutDir),
        ),
        url: `${options.chunks.publicPath}${chunk.name}.js`,
      },
    ]),
  );
  const manifest = {
    baseChunk: baseChunk.name,
    chunks: chunkManifest,
    loader: options.chunks.loader,
    modules: moduleMap,
    publicPath: options.chunks.publicPath,
  };
  const runtimeExternsPath = path.join(assetDir, "runtime.externs.js");
  const exportNames = new Set<string>();

  const chunkSources = await Promise.all(
    chunkPlan.map(async (chunk) => {
      const moduleSources = await Promise.all(
        chunk.files.map((filePath) => fs.readFile(filePath, "utf-8")),
      );
      for (const sourceText of moduleSources) {
        for (const exportName of collectBundlerRuntimeExportNames(sourceText)) {
          exportNames.add(exportName);
        }
      }
      const moduleText = moduleSources.join("\n");
      const sourceText =
        chunk.name === baseChunk.name
          ? renderBundlerRuntimeBaseChunk({
              chunkId: chunk.name,
              entryPoints: chunk.entryPoints,
              loader: options.chunks.loader,
              manifest,
              moduleText,
            })
          : renderBundlerRuntimeLazyChunk({
              chunkId: chunk.name,
              moduleText,
            });
      const sourcePath = path.join(assetDir, `${chunk.name}.linked.js`);
      await fs.writeFile(sourcePath, sourceText, "utf-8");
      return { chunkName: chunk.name, sourcePath };
    }),
  );
  await fs.writeFile(
    runtimeExternsPath,
    renderBundlerRuntimeExterns(exportNames),
    "utf-8",
  );

  const manifestOutputPath = options.chunks.manifestFile
    ? path.join(options.outDir, options.chunks.manifestFile)
    : null;
  if (manifestOutputPath) {
    await fs.mkdir(path.dirname(manifestOutputPath), { recursive: true });
    await fs.writeFile(
      manifestOutputPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );
  }

  return {
    chunkSources,
    manifestOutputPath,
    runtimeExternsPath,
  };
}

async function runBundlerRuntimeCompilation({
  chunkPlan,
  chunkSources,
  externPaths,
  options,
  outputDir,
  packageRoot,
}: {
  chunkPlan: ClosureChunk[];
  chunkSources: Array<{ chunkName: string; sourcePath: string }>;
  externPaths: string[];
  options: NormalizedBuildOptions;
  outputDir: string;
  packageRoot: string;
}) {
  for (const chunk of chunkPlan) {
    const chunkSource = chunkSources.find(
      (candidate) => candidate.chunkName === chunk.name,
    );
    if (!chunkSource) {
      throw new Error(`Missing linked chunk source for ${chunk.name}`);
    }
    const extraJs = chunk.kind === "base" ? options.js : [];
    const closureLibFiles = await collectBundlerRuntimeClosureLibFiles(
      packageRoot,
      [...extraJs, chunkSource.sourcePath],
    );
    const closureOptions: ClosureCompilerOptions = {
      assumeFunctionWrapper: true,
      compilationLevel: options.compilationLevel,
      externs: uniquePaths(externPaths),
      js: uniquePaths([...extraJs, ...closureLibFiles, chunkSource.sourcePath]),
      jsOutputFile: path.join(outputDir, `${chunk.name}.js`),
      languageIn: "UNSTABLE",
      languageOut: options.languageOut,
      rewritePolyfills: false,
      warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET",
    };
    applyInternalClosureDebugOptions(closureOptions);
    const exitCode = await runClosureCompiler(closureOptions);
    if (exitCode !== 0) {
      return exitCode;
    }
  }
  return 0;
}

async function collectBundlerRuntimeClosureLibFiles(
  packageRoot: string,
  candidateFiles: string[],
) {
  const contents = (
    await Promise.all(
      uniquePaths(candidateFiles).map((filePath) =>
        fs.readFile(filePath, "utf-8").catch(() => ""),
      ),
    )
  ).join("\n");

  if (!contents.includes("goog.reflect.")) {
    return [];
  }

  return [
    path.join(packageRoot, "closure-lib", "base.js"),
    path.join(packageRoot, "closure-lib", "reflect.js"),
  ];
}

function renderBundlerRuntimeExterns(exportNames: Set<string>) {
  const lines = [
    "/** @externs */",
    `Window.prototype.${BUNDLER_RUNTIME_GLOBAL};`,
    `WorkerGlobalScope.prototype.${BUNDLER_RUNTIME_GLOBAL};`,
    "Object.prototype.markChunkFailed;",
    "Object.prototype.markChunkLoaded;",
    "Object.prototype.preloadDynamicImport;",
    "Object.prototype.registerModule;",
    "Object.prototype.require;",
    "Object.prototype.runEntries;",
    "",
  ];
  for (const exportName of [...exportNames].sort((left, right) =>
    left.localeCompare(right),
  )) {
    lines.push(
      /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)
        ? `Object.prototype.${exportName};`
        : `Object.prototype[${JSON.stringify(exportName)}];`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function collectBundlerRuntimeExportNames(sourceText: string) {
  const exportNames = new Set<string>();
  for (const match of sourceText.matchAll(/__exports\[(["'])(.+?)\1\]\s*=/g)) {
    exportNames.add(match[2]);
  }
  return exportNames;
}

function renderBundlerRuntimeBaseChunk({
  chunkId,
  entryPoints,
  loader,
  manifest,
  moduleText,
}: {
  chunkId: string;
  entryPoints: string[];
  loader: string;
  manifest: Record<string, unknown>;
  moduleText: string;
}) {
  return [
    renderBundlerRuntimePreamble({
      loader,
      manifest: JSON.stringify(manifest),
    }),
    moduleText,
    `globalThis[${JSON.stringify(BUNDLER_RUNTIME_GLOBAL)}]["markChunkLoaded"](${JSON.stringify(
      chunkId,
    )});`,
    `globalThis[${JSON.stringify(BUNDLER_RUNTIME_GLOBAL)}]["runEntries"](${JSON.stringify(
      entryPoints,
    )});`,
    "",
  ].join("\n");
}

function renderBundlerRuntimeLazyChunk({
  chunkId,
  moduleText,
}: {
  chunkId: string;
  moduleText: string;
}) {
  return [
    "(function(__gcc_runtime){",
    'if(!__gcc_runtime)throw new Error("bundler-runtime base chunk must load before lazy chunks.");',
    moduleText,
    `__gcc_runtime["markChunkLoaded"](${JSON.stringify(chunkId)});`,
    `}).call(this,globalThis[${JSON.stringify(BUNDLER_RUNTIME_GLOBAL)}]);`,
    "",
  ].join("\n");
}

function renderBundlerRuntimePreamble({
  loader,
  manifest,
}: {
  loader: string;
  manifest: string;
}) {
  return [
    "(function(global){",
    `var runtimeKey=${JSON.stringify(BUNDLER_RUNTIME_GLOBAL)};`,
    "var runtime=global[runtimeKey]||(global[runtimeKey]={});",
    'if(!runtime["initialized"]){',
    'runtime["manifest"]=null;',
    'runtime["factories"]=Object.create(null);',
    'runtime["cache"]=Object.create(null);',
    'runtime["chunkStates"]=Object.create(null);',
    'runtime["chunkDeferreds"]=Object.create(null);',
    'runtime["baseUrl"]="";',
    'runtime["loaderMode"]="auto";',
    'runtime["resolveChunkUrl"]=function(chunkId){var manifest=runtime["manifest"];var chunk=manifest&&manifest["chunks"]&&manifest["chunks"][chunkId];if(!chunk)throw new Error("Unknown chunk " + chunkId);return new URL(chunk["url"], runtime["baseUrl"] || (global.location && global.location.href ? global.location.href : "./")).toString();};',
    'runtime["getDeferred"]=function(chunkId){var existing=runtime["chunkDeferreds"][chunkId];if(existing)return existing;var deferred={};deferred["promise"]=new Promise(function(resolve,reject){deferred["resolve"]=resolve;deferred["reject"]=reject;});runtime["chunkDeferreds"][chunkId]=deferred;return deferred;};',
    'runtime["markChunkLoaded"]=function(chunkId){runtime["chunkStates"][chunkId]="loaded";var deferred=runtime["chunkDeferreds"][chunkId];if(deferred){deferred["resolve"]();delete runtime["chunkDeferreds"][chunkId];}};',
    'runtime["markChunkFailed"]=function(chunkId,error){runtime["chunkStates"][chunkId]="failed";var deferred=runtime["chunkDeferreds"][chunkId];if(deferred){deferred["reject"](error);delete runtime["chunkDeferreds"][chunkId];}};',
    'runtime["registerModule"]=function(moduleId,_deps,factory){runtime["factories"][moduleId]=factory;};',
    'runtime["require"]=function(moduleId){if(Object.prototype.hasOwnProperty.call(runtime["cache"],moduleId))return runtime["cache"][moduleId];var factory=runtime["factories"][moduleId];if(!factory)throw new Error("Module not registered: " + moduleId);var exports={};runtime["cache"][moduleId]=exports;factory(runtime["require"], exports, runtime["dynamicImport"], runtime["preloadDynamicImport"]);return exports;};',
    'runtime["loadWithScript"]=function(chunkId,url){return new Promise(function(resolve,reject){var script=global.document.createElement("script");script.async=true;script.src=url;script.onload=function(){resolve();};script.onerror=function(){reject(new Error("Failed to load chunk " + chunkId));};(global.document.head||global.document.documentElement).appendChild(script);});};',
    'runtime["loadWithFetch"]=function(chunkId,url){return Promise.resolve(global.fetch(url)).then(function(response){if(!response.ok)throw new Error("Failed to fetch chunk " + chunkId + " (" + response.status + ")");return response.text();}).then(function(source){(0, global.eval)(source + "\\n//# sourceURL=" + url);});};',
    'runtime["selectLoader"]=function(){if(runtime["loaderMode"]!=="auto")return runtime["loaderMode"];return global.document ? "script" : "fetch";};',
    'runtime["ensureChunk"]=function(chunkId){var state=runtime["chunkStates"][chunkId];if(state==="loaded")return Promise.resolve();if(state==="loading"){return runtime["getDeferred"](chunkId)["promise"];}var manifest=runtime["manifest"];var chunk=manifest&&manifest["chunks"]&&manifest["chunks"][chunkId];if(!chunk)throw new Error("Unknown chunk " + chunkId);runtime["chunkStates"][chunkId]="loading";var deferred=runtime["getDeferred"](chunkId);var loader=runtime["selectLoader"]();return Promise.all((chunk["deps"]||[]).map(function(depId){return runtime["ensureChunk"](depId);})).then(function(){var url=runtime["resolveChunkUrl"](chunkId);return loader==="fetch"?runtime["loadWithFetch"](chunkId,url):runtime["loadWithScript"](chunkId,url);}).then(function(){return deferred["promise"];}).catch(function(error){runtime["markChunkFailed"](chunkId,error);throw error;});};',
    'runtime["dynamicImport"]=function(moduleId){var manifest=runtime["manifest"];var chunkId=manifest&&manifest["modules"]&&manifest["modules"][moduleId];if(!chunkId)throw new Error("Unknown module " + moduleId);return runtime["ensureChunk"](chunkId).then(function(){return runtime["require"](moduleId);});};',
    'runtime["preloadDynamicImport"]=function(moduleId){var manifest=runtime["manifest"];var chunkId=manifest&&manifest["modules"]&&manifest["modules"][moduleId];if(!chunkId)throw new Error("Unknown module " + moduleId);return runtime["ensureChunk"](chunkId).then(function(){});};',
    'runtime["runEntries"]=function(entryIds){for(var index=0;index<entryIds.length;index+=1)runtime["require"](entryIds[index]);};',
    'runtime["init"]=function(manifest, loaderMode){runtime["manifest"]=manifest;runtime["loaderMode"]=loaderMode||runtime["loaderMode"];var currentScript=global.document&&global.document.currentScript&&global.document.currentScript.src?global.document.currentScript.src:(global.location&&global.location.href?global.location.href:"./");runtime["baseUrl"]=new URL(manifest["publicPath"]||"./", currentScript).toString();runtime["chunkStates"][manifest["baseChunk"]]="loaded";};',
    'runtime["initialized"]=true;',
    "}",
    `runtime["init"](${manifest}, ${JSON.stringify(loader)});`,
    "}).call(this,globalThis);",
    "",
  ].join("\n");
}

function resolveChunkPlan(
  chunkPlan: ChunkPlanChunk[],
  emittedOutDir: string,
): ClosureChunk[] {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    entryPoints: chunk.entryFiles
      ? chunk.entryFiles.map((filePath) =>
          toGoogModuleId(
            path.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js")),
            emittedOutDir,
          ),
        )
      : (chunk.lazyModuleIds ?? []).length > 0
        ? [...(chunk.lazyModuleIds ?? [])]
        : chunk.files.length > 0
          ? [
              toGoogModuleId(
                path.join(
                  emittedOutDir,
                  chunk.files[chunk.files.length - 1].replace(
                    /\.[^/.]+$/,
                    ".js",
                  ),
                ),
                emittedOutDir,
              ),
            ]
          : [],
    files: chunk.files.map((filePath) =>
      path.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js")),
    ),
    kind: chunk.kind,
    lazyModuleIds: chunk.lazyModuleIds ?? [],
    name: chunk.name,
  }));
}

function getDefaultString(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "string"
  ) {
    return value.default;
  }

  return undefined;
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths)];
}

function toGoogModuleId(filePath: string, moduleRoot: string) {
  const relativePath = path.relative(moduleRoot, filePath).replace(/\\/g, "/");
  const withoutExtension = relativePath.replace(/\.[^/.]+$/, "");
  return `gcc.${withoutExtension
    .split("/")
    .map((segment) => segment.replace(/[^A-Za-z0-9_$]/g, "_"))
    .join(".")}`;
}

function resolveClosureCompilerJarPath(): string | undefined {
  const closureCompilerModule =
    closureCompilerPackage as ClosureCompilerPackageShape;
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;
  const jarPath =
    typeof closureCompiler.JAR_PATH === "string"
      ? closureCompiler.JAR_PATH
      : typeof closureCompilerModule.JAR_PATH === "string"
        ? closureCompilerModule.JAR_PATH
        : (getDefaultString(closureCompiler.JAR_PATH) ??
          getDefaultString(closureCompilerModule.JAR_PATH));

  return jarPath;
}

function configureClosureCompilerInstance(
  instance: ClosureCompilerInstance,
): ClosureCompilerInstance {
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

async function runClosureCompiler(
  options: ClosureCompilerOptions,
): Promise<number> {
  const closureCompiler =
    closureCompilerPackage.compiler as ClosureCompilerClass;

  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(
      new closureCompiler(options),
    );
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

async function collectClosureLibFiles(
  packageRoot: string,
  candidateFiles: string[],
): Promise<string[]> {
  const closureLibDir = path.join(packageRoot, "closure-lib");
  const cacheKey = `${closureLibDir}\0${await hashClosureLibSelection(candidateFiles)}`;
  const existing = closureLibFilesCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const filesPromise = selectClosureLibFiles(closureLibDir, candidateFiles);
  closureLibFilesCache.set(cacheKey, filesPromise);
  return filesPromise;
}

async function hashClosureLibSelection(filePaths: string[]) {
  const stats = await Promise.all(
    uniquePaths(filePaths).map(async (filePath) => {
      try {
        const stat = await fs.stat(filePath);
        return `${filePath}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${filePath}:missing`;
      }
    }),
  );
  return stats.sort((left, right) => left.localeCompare(right)).join("|");
}

async function selectClosureLibFiles(
  closureLibDir: string,
  candidateFiles: string[],
) {
  const required: string[] = [];
  const contents = (
    await Promise.all(
      uniquePaths(candidateFiles).map((filePath) =>
        fs.readFile(filePath, "utf-8").catch(() => ""),
      ),
    )
  ).join("\n");
  const needsGoogBase =
    contents.includes("goog.module(") ||
    contents.includes("goog.require(") ||
    contents.includes("goog.requireType(") ||
    contents.includes("goog.provide(") ||
    contents.includes("goog.reflect.");
  if (needsGoogBase) {
    required.push(path.join(closureLibDir, "base.js"));
  }
  if (contents.includes("goog.reflect.")) {
    required.push(path.join(closureLibDir, "reflect.js"));
  }
  if (contents.includes("tslib")) {
    if (!required.includes(path.join(closureLibDir, "base.js"))) {
      required.push(path.join(closureLibDir, "base.js"));
    }
    required.push(path.join(closureLibDir, "tslib.js"));
  }
  return uniquePaths(required);
}
