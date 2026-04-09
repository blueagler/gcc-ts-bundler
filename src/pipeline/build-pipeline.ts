import path from "path";
import fs from "fs";

import { generateExterns } from "../api/externs";
import { BuildOptions, BuildResult, CleanCacheOptions } from "../api/types";
import { hashContent, hashJson } from "../cache/hash";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import {
  collectPublishedOutputStats,
  copyOrLinkFiles,
  FileStateSnapshot,
  filesExist,
  publishedOutputsMatch,
  publishedOutputsMatchSnapshot,
  trackedFilesMatch,
} from "../internal/file-state";
import {
  createBuildContext,
  normalizeBuildOptions,
  resolveBuild,
} from "./resolve-build";
import { emitNativeStage } from "../stages/native/emit";
import { loadCompilerOptions } from "../stages/native/compiler-options";
import { runClosureStage } from "../stages/closure/run-closure";
import { writeEntryShims } from "../native/load";

interface FinalCacheMetadata {
  outputFiles: string[];
}

interface FinalFastSnapshot {
  finalKey: string;
  optionsSignature: string;
  packageSignature: string;
  publishedOutputs: Array<{ name: string; size: number }>;
  trackedFiles: Record<string, FileStateSnapshot>;
}

interface RuntimeDependencyExternsCacheMetadata {
  key: string;
  outputFile: string;
  version: number;
}

const RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION = 1;

export async function build(options: BuildOptions): Promise<BuildResult> {
  const context = await createBuildContext(normalizeBuildOptions(options));
  const usesPersistentCache = context.options.cache.mode === "persistent";

  if (usesPersistentCache) {
    const fastSnapshot = await readJsonIfExists<FinalFastSnapshot>(
      path.join(context.projectCacheDir, "final-fast.json"),
    );
    if (
      fastSnapshot &&
      fastSnapshot.optionsSignature === context.optionsSignature &&
      fastSnapshot.packageSignature === context.packageSignature &&
      (await trackedFilesMatch(fastSnapshot.trackedFiles)) &&
      (await publishedOutputsMatchSnapshot(
        fastSnapshot.publishedOutputs,
        context.options.outDir,
      ))
    ) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(
          fastSnapshot.publishedOutputs,
          context.options.outDir,
        ),
      };
    }
  }

  let resolved: Awaited<ReturnType<typeof resolveBuild>> | null = null;

  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = path.join(
      resolvedBuild.finalCacheDir,
      "meta.json",
    );
    const finalMetadata = usesPersistentCache
      ? await readJsonIfExists<FinalCacheMetadata>(finalMetadataPath)
      : null;
    if (
      usesPersistentCache &&
      finalMetadata &&
      (await filesExist(finalMetadata.outputFiles))
    ) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(
          finalMetadata.outputFiles.map((outputFile) => ({
            name: path.basename(outputFile),
          })),
          context.options.outDir,
        ),
      };
    }

    if (
      context.options.chunks.mode !== "off" &&
      resolvedBuild.entryFiles.some(
        (entry) => entry.exportNames.length > 0 || entry.hasDefaultExport,
      )
    ) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic(
            "Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.",
          ),
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: [],
      };
    }

    if (
      context.options.chunks.mode === "off" &&
      resolvedBuild.lazyImports.length > 0
    ) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic(
            'Dynamic import() requires chunks.mode = "bundler-runtime".',
          ),
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: [],
      };
    }

    if (context.options.chunks.mode === "off") {
      writeEntryShims({
        entries: resolvedBuild.entryFiles.map((entry) => ({
          exportNames: entry.exportNames,
          hasDefaultExport: entry.hasDefaultExport,
          importPath: toImportPath(
            path.relative(
              path.dirname(
                path.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`),
              ),
              entry.sourcePath,
            ),
          ),
          shimPath: path.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`),
        })),
      });
    }

    const nativeEmitMetadataPath = path.join(
      resolvedBuild.nativeEmitCacheDir,
      "meta.json",
    );
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames:
        context.options.chunks.mode !== "off"
          ? resolvedBuild.sourceFiles
          : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      lazyImports: resolvedBuild.lazyImports,
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      packageAliases: resolvedBuild.packageAliases,
      packageJsonFiles: resolvedBuild.packageJsonFiles,
      tsConfigPath: resolvedBuild.tsConfigPath,
      workspaceDir: resolvedBuild.workspaceDir,
    });
    if (
      nativeEmitResult.diagnostics.length > 0 ||
      nativeEmitResult.emitSkipped
    ) {
      return {
        cacheHit: false,
        diagnostics: nativeEmitResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        outputFiles: [],
      };
    }

    const runtimeDependencyExterns = await generateRuntimeDependencyExterns({
      appEntryFiles: context.options.entries,
      cacheMode: context.options.cache.mode,
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      dependencyModules: nativeEmitResult.dependencyModules,
      dependencyRuntimeFiles: nativeEmitResult.dependencyRuntimeFiles,
      projectRoot: context.options.projectRoot,
      srcDir: context.options.srcDir,
      tsConfigPath: resolvedBuild.tsConfigPath,
    });
    const closureResult = await runClosureStage({
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      explicitExternPaths: context.options.externs,
      finalCacheDir: resolvedBuild.finalCacheDir,
      generatedExternPaths: runtimeDependencyExterns
        ? [runtimeDependencyExterns]
        : [],
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: context.options.outDir,
      projectCacheDir: context.projectCacheDir,
      supportFiles: nativeEmitResult.supportFiles,
      packageRoot: context.packageRoot,
    });
    if (closureResult.exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode: closureResult.exitCode,
        outputFiles: [],
      };
    }

    if (usesPersistentCache) {
      await writeJson(finalMetadataPath, {
        outputFiles: closureResult.cacheOutputFiles,
      } satisfies FinalCacheMetadata);
      await writeJson(path.join(context.projectCacheDir, "final-fast.json"), {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats(
          closureResult.outputFiles,
        ),
        trackedFiles: resolvedBuild.trackedFiles,
      } satisfies FinalFastSnapshot);
    }

    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      outputFiles: closureResult.outputFiles,
    };
  } catch (error) {
    return {
      cacheHit: false,
      diagnostics: [createBuildDiagnostic(error)],
      emitSkipped: true,
      exitCode: 1,
      outputFiles: [],
    };
  } finally {
    await resolved?.cleanup();
  }
}

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path.resolve(
    options.cacheDir || getDefaultPersistentCacheRoot(),
  );
  const projectCacheDir = path.join(cacheRoot, hashContent(projectRoot));
  await fs.promises.rm(projectCacheDir, { force: true, recursive: true });
}

async function generateRuntimeDependencyExterns({
  appEntryFiles,
  cacheMode,
  cacheDir,
  dependencyModules,
  dependencyRuntimeFiles,
  projectRoot,
  srcDir,
  tsConfigPath,
}: {
  appEntryFiles: string[];
  cacheMode: "off" | "temp" | "persistent";
  cacheDir: string;
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  projectRoot: string;
  srcDir: string;
  tsConfigPath: string;
}) {
  if (dependencyModules.length === 0 || dependencyRuntimeFiles.length === 0) {
    return null;
  }

  const outputFile = path.join(cacheDir, "runtime-dependency-externs.js");
  const metadataPath = path.join(
    cacheDir,
    "runtime-dependency-externs.meta.json",
  );
  if (cacheMode !== "off") {
    const compilerOptions = await loadCompilerOptions(tsConfigPath);
    const cacheKey = hashJson({
      appEntryFiles,
      compilerOptions,
      dependencyModules,
      dependencyRuntimeFiles,
      projectRoot,
      srcDir,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION,
    });
    const cachedMetadata =
      await readJsonIfExists<RuntimeDependencyExternsCacheMetadata>(
        metadataPath,
      );
    if (
      cachedMetadata?.version === RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION &&
      cachedMetadata.key === cacheKey &&
      cachedMetadata.outputFile === outputFile &&
      (await filesExist([outputFile]))
    ) {
      return outputFile;
    }

    await generateExterns({
      appEntryFiles,
      mode: "runtime-aware",
      modules: dependencyModules,
      outputFile,
      projectRoot,
      runtimeEntryFiles: dependencyRuntimeFiles,
      srcDir,
      tsConfigPath,
    });
    await writeJson(metadataPath, {
      key: cacheKey,
      outputFile,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION,
    } satisfies RuntimeDependencyExternsCacheMetadata);
    return outputFile;
  }

  await generateExterns({
    appEntryFiles,
    mode: "runtime-aware",
    modules: dependencyModules,
    outputFile,
    projectRoot,
    runtimeEntryFiles: dependencyRuntimeFiles,
    srcDir,
    tsConfigPath,
  });
  return outputFile;
}

async function publishOutputs(outputFiles: string[], outDir: string) {
  if (await publishedOutputsMatch(outputFiles, outDir)) {
    return;
  }

  await copyOrLinkFiles(outputFiles, outDir);
}

function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function toPublishedOutputPaths(
  publishedOutputs: Array<{ name: string }>,
  outDir: string,
) {
  return publishedOutputs.map(({ name }) => path.join(outDir, name));
}

function createBuildDiagnostic(error: unknown) {
  return {
    category: 1,
    code: 0,
    messageText:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Build failed.",
  };
}
