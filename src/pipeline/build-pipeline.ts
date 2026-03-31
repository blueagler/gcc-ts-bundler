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

let bundledExternsCache: Promise<string[]> | null = null;

export async function build(options: BuildOptions): Promise<BuildResult> {
  const context = await createBuildContext(normalizeBuildOptions(options));

  if (context.options.cache.mode === "persistent") {
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
        outputFiles: fastSnapshot.publishedOutputs.map(({ name }) =>
          path.join(context.options.outDir, name),
        ),
      };
    }
  }

  let resolved: Awaited<ReturnType<typeof resolveBuild>> | null = null;

  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = path.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata =
      await readJsonIfExists<FinalCacheMetadata>(finalMetadataPath);
    if (
      context.options.cache.mode !== "off" &&
      finalMetadata &&
      (await filesExist(finalMetadata.outputFiles))
    ) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: finalMetadata.outputFiles.map((outputFile) =>
          path.join(context.options.outDir, path.basename(outputFile)),
        ),
      };
    }

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

    const nativeEmitMetadataPath = path.join(
      resolvedBuild.nativeEmitCacheDir,
      "meta.json",
    );
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
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

    await writeJson(finalMetadataPath, {
      outputFiles: closureResult.cacheOutputFiles,
    } satisfies FinalCacheMetadata);
    if (context.options.cache.mode === "persistent") {
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
  if (!bundledExternsCache) {
    bundledExternsCache = (async () => {
      const closureExternsPath = path.join(packageRoot, "closure-externs");
      const entries = await fs.promises.readdir(closureExternsPath);
      return entries
        .map((entry) => path.join(closureExternsPath, entry))
        .sort((left, right) => left.localeCompare(right));
    })();
  }

  return bundledExternsCache;
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

function createBuildDiagnostic(error: unknown) {
  return {
    category: 1,
    code: 0,
    messageText:
      error instanceof Error ? error.message : typeof error === "string"
        ? error
        : "Build failed.",
  };
}
