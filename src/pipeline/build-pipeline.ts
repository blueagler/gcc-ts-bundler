import path from "path";
import fs from "fs";

import { BuildOptions, BuildResult, CleanCacheOptions } from "../api/types";
import { hashContent } from "../cache/hash";
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

const bundledExternsCacheByRoot = new Map<string, Promise<string[]>>();

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
      context.options.chunks.mode === "closure-library" &&
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

    if (context.options.chunks.mode !== "closure-library") {
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
        context.options.chunks.mode === "closure-library"
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

    const bundledExterns = await collectBundledExterns(context.packageRoot);
    const closureResult = await runClosureStage({
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      externPaths: [
        ...context.options.externs,
        ...bundledExterns,
        nativeEmitResult.externsPath,
      ],
      finalCacheDir: resolvedBuild.finalCacheDir,
      lazyImports: resolvedBuild.lazyImports,
      options: context.options,
      outDir: context.options.outDir,
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

async function collectBundledExterns(packageRoot: string) {
  let bundledExternsPromise = bundledExternsCacheByRoot.get(packageRoot);
  if (!bundledExternsPromise) {
    bundledExternsPromise = (async () => {
      const closureExternsPath = path.join(packageRoot, "closure-externs");
      const entries = await fs.promises.readdir(closureExternsPath);
      return entries
        .map((entry) => path.join(closureExternsPath, entry))
        .sort((left, right) => left.localeCompare(right));
    })();
    bundledExternsCacheByRoot.set(packageRoot, bundledExternsPromise);
  }

  return bundledExternsPromise;
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
