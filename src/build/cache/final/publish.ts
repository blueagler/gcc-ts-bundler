import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

import type { BuildResult } from "../../../api/types";
import { readJsonIfExists } from "../../../shared/cache-store";
import {
  fileContentSnapshotMatches,
  filesExist,
  publishedOutputsMatchSnapshot,
} from "../../../shared/file-state";
import { logInternalDetail } from "../../../shared/timing";
import type { BuildContext, ResolvedBuild } from "../../types";
import { hasErrorCode } from "../../../shared/validation";
import { ensureParentDirectory } from "../../../shared/files";
import type { ClosureStageResult } from "../../closure/run-closure";
import type { FinalCachePaths, InvocationStaging } from "./staging";
import {
  isFinalCacheMetadata,
  isFinalFastSnapshot,
  successfulBuild,
} from "./persist";

export async function publishStagedClosureResult(
  closureResult: ClosureStageResult,
  staging: InvocationStaging,
  finalCacheDir: string,
  outDir: string,
) {
  await replaceDirectoryAtomically(staging.finalCacheDir, finalCacheDir);
  const cacheOutputFiles = remapStagedFiles(
    closureResult.cacheOutputFiles,
    staging.finalCacheDir,
    finalCacheDir,
  );
  await replaceDirectoryAtomically(staging.outDir, outDir);
  const outputFiles = remapStagedFiles(
    closureResult.outputFiles,
    staging.outDir,
    outDir,
  );
  return { ...closureResult, cacheOutputFiles, outputFiles };
}

export async function publishOffModeEntryOutFiles(
  context: BuildContext,
  resolved: ResolvedBuild,
  outputFiles: readonly string[],
) {
  if (context.options.chunks.mode !== "off") {
    return [...outputFiles];
  }
  const published = [...outputFiles];
  const { outDir, projectRoot } = context.options;
  for (const entry of resolved.entryFiles) {
    if (!entry.outFile) {
      continue;
    }
    const sourcePath = path.join(outDir, entry.outputName);
    const destPath = path.isAbsolute(entry.outFile)
      ? path.resolve(entry.outFile)
      : path.resolve(projectRoot, entry.outFile);
    if (path.resolve(sourcePath) === destPath) {
      continue;
    }
    const source = await fs.readFile(sourcePath, "utf8");
    await ensureParentDirectory(destPath);
    await fs.writeFile(
      destPath,
      rewriteRelocatedRelativeImports(source, sourcePath, destPath, outDir),
    );
    const resolvedOutDir = path.resolve(outDir);
    const destOutsideOutDir =
      destPath !== resolvedOutDir &&
      !destPath.startsWith(`${resolvedOutDir}${path.sep}`);
    if (destOutsideOutDir) {
      await fs.unlink(sourcePath);
      const sourceResolved = path.resolve(sourcePath);
      for (let index = published.length - 1; index >= 0; index -= 1) {
        if (path.resolve(published[index]!) === sourceResolved) {
          published.splice(index, 1);
        }
      }
    }
    published.push(destPath);
  }
  return published;
}

function rewriteRelocatedRelativeImports(
  source: string,
  sourcePath: string,
  destPath: string,
  outDir: string,
) {
  const distRoot = path.resolve(outDir);
  return source.replace(
    /(\b(?:from|import)\s*)(["'])([^"']+)\2/gu,
    (full, prefix: string, quote: string, specifier: string) => {
      if (!specifier.startsWith(".")) {
        return full;
      }
      const target = path.resolve(path.dirname(sourcePath), specifier);
      if (!target.startsWith(`${distRoot}${path.sep}`)) {
        return full;
      }
      const relative = path
        .relative(path.dirname(destPath), target)
        .replace(/\\/gu, "/");
      const relocatedSpecifier = relative.startsWith(".")
        ? relative
        : `./${relative}`;
      return `${prefix}${quote}${relocatedSpecifier}${quote}`;
    },
  );
}

async function publishCachedOutputsAtomically(
  outputFiles: string[],
  sourceRoot: string,
  outDir: string,
) {
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingDir = await fs.mkdtemp(
    path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`),
  );
  try {
    await copyFilesPreservingRelativePaths(outputFiles, sourceRoot, stagingDir);
    await replaceDirectoryAtomically(stagingDir, outDir);
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => {});
  }
}

async function copyFilesPreservingRelativePaths(
  sourceFiles: string[],
  sourceRoot: string,
  targetRoot: string,
) {
  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const [targetFile] = remapStagedFiles(
        [sourceFile],
        sourceRoot,
        targetRoot,
      );
      if (!targetFile) {
        return;
      }
      await ensureParentDirectory(targetFile);
      await fs.copyFile(sourceFile, targetFile);
    }),
  );
}

async function replaceDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
) {
  const backupDir = `${targetDir}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await fs.rename(targetDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  try {
    await fs.rename(stagingDir, targetDir);
  } catch (error) {
    if (hasBackup) {
      await fs.rename(backupDir, targetDir).catch((restoreError) => {
        throw new AggregateError(
          [error, restoreError],
          `Failed to publish ${targetDir} and restore its previous contents.`,
        );
      });
    }
    throw error;
  }

  if (hasBackup) {
    await fs.rm(backupDir, { force: true, recursive: true }).catch(() => {});
  }
}

function remapStagedFiles(
  filePaths: string[],
  stagingDir: string,
  targetDir: string,
) {
  return filePaths.map((filePath) => {
    const relativePath = path.relative(stagingDir, filePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Staged output escaped its directory: ${filePath}`);
    }
    return path.join(targetDir, relativePath);
  });
}

export async function cleanupInvocationStaging(staging: InvocationStaging) {
  await Promise.all(
    [staging.finalCacheDir, staging.outDir].map((dirPath) =>
      fs.rm(dirPath, { force: true, recursive: true }).catch(() => {}),
    ),
  );
}

export async function restoreCachedBuild(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
): Promise<BuildResult | null> {
  if (context.options.cache.mode !== "persistent") {
    return null;
  }
  return (
    (await restoreFastSnapshot(
      context,
      resolved,
      cachePaths.fastSnapshotPath,
    )) ?? restoreFinalMetadata(context, resolved, cachePaths.metadataPath)
  );
}

async function restoreFastSnapshot(
  context: BuildContext,
  resolved: ResolvedBuild,
  snapshotPath: string,
): Promise<BuildResult | null> {
  const snapshot = await readJsonIfExists(snapshotPath, isFinalFastSnapshot);
  const cacheHit = Boolean(
    snapshot &&
    snapshot.finalKey === resolved.finalKey &&
    snapshot.optionsSignature === context.optionsSignature &&
    snapshot.packageSignature === context.packageSignature &&
    (await publishedOutputsMatchSnapshot(
      snapshot.publishedOutputs,
      context.options.outDir,
    )) &&
    (await fileContentSnapshotMatches(snapshot.typeMetadataDependencies)) &&
    (await requiredSidecarFilesExist(context.options.viteRuntimeSourceMapFile)),
  );
  logInternalDetail("cache:final-fast", cacheHit ? "hit" : "miss");
  return snapshot && cacheHit
    ? successfulBuild(
        await publishOffModeEntryOutFiles(
          context,
          resolved,
          snapshot.publishedOutputs.map(({ name }) =>
            path.join(context.options.outDir, name),
          ),
        ),
        true,
      )
    : null;
}

async function restoreFinalMetadata(
  context: BuildContext,
  resolved: ResolvedBuild,
  metadataPath: string,
): Promise<BuildResult | null> {
  const metadata = await readJsonIfExists(metadataPath, isFinalCacheMetadata);
  const cacheHit = Boolean(
    metadata &&
    metadata.finalKey === resolved.finalKey &&
    metadata.optionsSignature === context.optionsSignature &&
    metadata.packageSignature === context.packageSignature &&
    (await fileContentSnapshotMatches(
      metadata.artifacts,
      metadata.outputFiles,
    )) &&
    (await fileContentSnapshotMatches(metadata.typeMetadataDependencies)) &&
    (await requiredSidecarFilesExist(context.options.viteRuntimeSourceMapFile)),
  );
  logInternalDetail("cache:final-metadata", cacheHit ? "hit" : "miss");
  if (!metadata || !cacheHit) {
    return null;
  }

  const cacheOutputRoot = path.join(resolved.finalCacheDir, "outputs");
  await publishCachedOutputsAtomically(
    metadata.outputFiles,
    cacheOutputRoot,
    context.options.outDir,
  );
  return successfulBuild(
    await publishOffModeEntryOutFiles(
      context,
      resolved,
      remapStagedFiles(
        metadata.outputFiles,
        cacheOutputRoot,
        context.options.outDir,
      ),
    ),
    true,
  );
}

async function requiredSidecarFilesExist(
  runtimeModuleSourceMapFile: string | undefined,
) {
  return (
    !runtimeModuleSourceMapFile ||
    (await filesExist([runtimeModuleSourceMapFile]))
  );
}
