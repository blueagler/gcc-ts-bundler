import fs from "fs";
import path from "path";

import { BuildOptions, BuildResult, CleanCacheOptions } from "../api/types";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import { hashContent } from "../cache/hash";
import {
  getOptionsSignature,
  getPackageSignature,
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
  trackedFiles: Record<string, { mtimeMs: number; size: number }>;
}

let bundledExternsCache: Promise<string[]> | null = null;

export async function build(options: BuildOptions): Promise<BuildResult> {
  const normalizedOptions = normalizeBuildOptions(options);
  const projectCacheDir = path.join(
    path.resolve(
      normalizedOptions.cache.dir || getDefaultPersistentCacheRoot(),
    ),
    hashContent(normalizedOptions.projectRoot),
  );
  if (normalizedOptions.cache.mode === "persistent") {
    const fastSnapshot = await readJsonIfExists<FinalFastSnapshot>(
      path.join(projectCacheDir, "final-fast.json"),
    );
    if (
      fastSnapshot &&
      fastSnapshot.optionsSignature ===
        getOptionsSignature(normalizedOptions) &&
      fastSnapshot.packageSignature === (await getPackageSignature())
    ) {
      const trackedFilesValid = await trackedFilesMatch(
        fastSnapshot.trackedFiles,
      );
      if (trackedFilesValid) {
        if (
          await publishedOutputsMatchSnapshot(
            fastSnapshot.publishedOutputs,
            normalizedOptions.outDir,
          )
        ) {
          return {
            cacheHit: true,
            diagnostics: [],
            emitSkipped: false,
            exitCode: 0,
            options: normalizedOptions,
            outputFiles: fastSnapshot.publishedOutputs.map(({ name }) =>
              path.join(normalizedOptions.outDir, name),
            ),
            workspaceDir: path.join(projectCacheDir, "workspace"),
          };
        }
      }
    }
  }
  const resolved = await resolveBuild(normalizedOptions);

  try {
    const finalMetadataPath = path.join(resolved.finalCacheDir, "meta.json");
    const finalMetadata =
      await readJsonIfExists<FinalCacheMetadata>(finalMetadataPath);
    if (
      normalizedOptions.cache.mode !== "off" &&
      finalMetadata &&
      (await Promise.all(finalMetadata.outputFiles.map(pathExists))).every(
        Boolean,
      )
    ) {
      await publishOutputs(finalMetadata.outputFiles, normalizedOptions.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        options: normalizedOptions,
        outputFiles: finalMetadata.outputFiles,
        workspaceDir: resolved.workspaceDir,
      };
    }

    writeEntryShims({
      entries: resolved.entryFiles.map((entry) => ({
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        importPath: toImportPath(
          path.relative(
            path.dirname(path.join(resolved.shimDir, `${entry.chunkName}.ts`)),
            entry.sourcePath,
          ),
        ),
        shimPath: path.join(resolved.shimDir, `${entry.chunkName}.ts`),
      })),
    });

    const nativeEmitMetadataPath = path.join(
      resolved.nativeEmitCacheDir,
      "meta.json",
    );
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      fileNames: [...resolved.filePaths, ...resolved.shimFiles],
      metadataPath: nativeEmitMetadataPath,
      options: normalizedOptions,
      tsConfigPath: resolved.tsConfigPath,
      workspaceDir: resolved.workspaceDir,
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
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir,
      };
    }

    const bundledExterns = await collectBundledExterns(resolved.packageRoot);
    const closureResult = await runClosureStage({
      emittedOutDir: nativeEmitResult.outDir,
      entryFiles: resolved.entryFiles,
      externPaths: [
        ...normalizedOptions.externs,
        ...bundledExterns,
        nativeEmitResult.externsPath,
      ],
      finalCacheDir: resolved.finalCacheDir,
      graph: {
        ...resolved.graph,
        ...Object.fromEntries(
          resolved.shimFiles.map((shimFile, index) => [
            shimFile,
            [resolved.entryFiles[index].sourcePath],
          ]),
        ),
      },
      options: normalizedOptions,
      packageRoot: resolved.packageRoot,
      shimFiles: resolved.shimFiles,
      workspaceDir: resolved.workspaceDir,
    });
    if (closureResult.exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode: closureResult.exitCode,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir,
      };
    }

    const finalOutputFiles = closureResult.outputFiles;
    await writeJson(finalMetadataPath, {
      outputFiles: finalOutputFiles,
    } satisfies FinalCacheMetadata);
    await writeJson(path.join(projectCacheDir, "final-fast.json"), {
      finalKey: resolved.finalKey,
      optionsSignature: getOptionsSignature(normalizedOptions),
      packageSignature: await getPackageSignature(),
      publishedOutputs: await collectPublishedOutputStats(finalOutputFiles),
      trackedFiles: await collectTrackedFiles([
        ...resolved.filePaths,
        resolved.tsConfigPath,
        ...normalizedOptions.externs,
        ...normalizedOptions.js,
      ]),
    } satisfies FinalFastSnapshot);
    await publishOutputs(finalOutputFiles, normalizedOptions.outDir);

    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      options: normalizedOptions,
      outputFiles: finalOutputFiles,
      workspaceDir: resolved.workspaceDir,
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
      workspaceDir: resolved.workspaceDir,
    };
  } finally {
    await resolved.cleanup();
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

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });
  await Promise.all(
    outputFiles.map((outputFile) =>
      fs.promises.copyFile(
        outputFile,
        path.join(outDir, path.basename(outputFile)),
      ),
    ),
  );
}

async function publishedOutputsMatch(outputFiles: string[], outDir: string) {
  try {
    const outEntries = (await fs.promises.readdir(outDir)).sort();
    const expectedEntries = outputFiles
      .map((outputFile) => path.basename(outputFile))
      .sort();

    if (
      outEntries.length !== expectedEntries.length ||
      outEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      return false;
    }

    return (
      await Promise.all(
        outputFiles.map(async (outputFile) => {
          const destinationFile = path.join(outDir, path.basename(outputFile));
          const [sourceStat, destinationStat] = await Promise.all([
            fs.promises.stat(outputFile),
            fs.promises.stat(destinationFile),
          ]);
          return sourceStat.size === destinationStat.size;
        }),
      )
    ).every(Boolean);
  } catch {
    return false;
  }
}

async function publishedOutputsMatchSnapshot(
  publishedOutputs: Array<{ name: string; size: number }>,
  outDir: string,
) {
  try {
    const outEntries = (await fs.promises.readdir(outDir)).sort();
    const expectedEntries = publishedOutputs.map(({ name }) => name).sort();

    if (
      outEntries.length !== expectedEntries.length ||
      outEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      return false;
    }

    return (
      await Promise.all(
        publishedOutputs.map(async ({ name, size }) => {
          const stat = await fs.promises.stat(path.join(outDir, name));
          return stat.size === size;
        }),
      )
    ).every(Boolean);
  } catch {
    return false;
  }
}

function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectTrackedFiles(filePaths: string[]) {
  const trackedEntries = await Promise.all(
    [...new Set(filePaths)]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => {
        const stat = await fs.promises.stat(filePath);
        return [
          filePath,
          {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          },
        ] as const;
      }),
  );

  return Object.fromEntries(trackedEntries);
}

async function collectPublishedOutputStats(outputFiles: string[]) {
  const outputStats = await Promise.all(
    outputFiles.map(async (outputFile) => {
      const stat = await fs.promises.stat(outputFile);
      return {
        name: path.basename(outputFile),
        size: stat.size,
      };
    }),
  );

  return outputStats.sort((left, right) => left.name.localeCompare(right.name));
}

async function trackedFilesMatch(
  trackedFiles: Record<string, { mtimeMs: number; size: number }>,
) {
  return (
    await Promise.all(
      Object.entries(trackedFiles).map(async ([filePath, expected]) => {
        try {
          const stat = await fs.promises.stat(filePath);
          return (
            stat.mtimeMs === expected.mtimeMs && stat.size === expected.size
          );
        } catch {
          return false;
        }
      }),
    )
  ).every(Boolean);
}
