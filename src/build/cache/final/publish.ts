import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

import type { BuildResult } from "../../../api/types";
import { readJsonIfExists } from "../../../shared/cache-store";
import { runWithConcurrency } from "../../../shared/concurrency";
import {
  fileContentSnapshotMatches,
  filesExist,
} from "../../../shared/file-state";
import { ensureParentDirectory } from "../../../shared/files";
import { hasErrorCode } from "../../../shared/validation";
import type { ClosureStageResult } from "../../closure/run-closure";
import { validateOutputPathBoundaries } from "../../resolve/options";
import type { BuildContext, ResolvedBuild } from "../../types";
import { isFinalCacheMetadata, successfulBuild } from "./persist";
import type { InvocationStaging } from "./staging";

interface PreparedPublication {
  externalFiles: Array<{ temporary: string; destination: string }>;
  outputFiles: string[];
}

/** Prepare all mappings and relocated bytes before either public directory is replaced. */
async function preparePublication(
  context: BuildContext,
  resolved: ResolvedBuild,
  stagedFiles: string[],
  stagedOutDir: string,
): Promise<PreparedPublication> {
  const outputFiles = remapStagedFiles(
    stagedFiles,
    stagedOutDir,
    context.options.outDir,
  );
  const entryNames = resolved.entryFiles.map((entry) => entry.outputName);
  await validateOutputPathBoundaries(
    context.options,
    resolved.workspaceDir,
    [
      ...resolved.sourceFiles,
      ...resolved.tsxRuntimeSourceFiles,
      ...resolved.packageJsonFiles,
      resolved.tsConfigPath,
    ],
    path.dirname(path.dirname(resolved.finalCacheDir)),
    [
      ...entryNames,
      ...outputFiles
        .map((file) => path.relative(context.options.outDir, file))
        .filter((name) => !entryNames.includes(name)),
    ],
  );
  const prepared: PreparedPublication = { externalFiles: [], outputFiles };
  if (context.options.chunks.mode !== "off") return prepared;
  try {
    for (const entry of resolved.entryFiles) {
      if (entry.outFile === undefined) continue;
      const sourcePath = path.join(context.options.outDir, entry.outputName);
      const stagedSource = path.join(stagedOutDir, entry.outputName);
      const destination = path.resolve(
        context.options.projectRoot,
        entry.outFile,
      );
      if (path.resolve(sourcePath) === destination) continue;
      const source = await fs.readFile(stagedSource, "utf8");
      const rewritten = rewriteRelocatedRelativeImports(
        source,
        sourcePath,
        destination,
        context.options.outDir,
      );
      const relative = path.relative(context.options.outDir, destination);
      const inside =
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      if (inside) {
        const stagedDestination = path.join(stagedOutDir, relative);
        await ensureParentDirectory(stagedDestination);
        await fs.writeFile(stagedDestination, rewritten);
      } else {
        await ensureParentDirectory(destination);
        const temporary = path.join(
          path.dirname(destination),
          `.${path.basename(destination)}.${randomUUID()}.tmp`,
        );
        prepared.externalFiles.push({ temporary, destination });
        await fs.writeFile(temporary, rewritten, { flag: "wx" });
        await fs.unlink(stagedSource);
        prepared.outputFiles = prepared.outputFiles.filter(
          (file) => path.resolve(file) !== path.resolve(sourcePath),
        );
      }
      if (!prepared.outputFiles.includes(destination))
        prepared.outputFiles.push(destination);
    }
    return prepared;
  } catch (error) {
    await cleanupPublication(prepared, error);
    throw error;
  }
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
      if (!specifier.startsWith(".")) return full;
      const target = path.resolve(path.dirname(sourcePath), specifier);
      if (!target.startsWith(`${distRoot}${path.sep}`)) return full;
      const relative = path
        .relative(path.dirname(destPath), target)
        .replace(/\\/gu, "/");
      return `${prefix}${quote}${relative.startsWith(".") ? relative : `./${relative}`}${quote}`;
    },
  );
}

export async function publishStagedClosureResult(
  context: BuildContext,
  resolved: ResolvedBuild,
  closureResult: ClosureStageResult,
  staging: InvocationStaging,
) {
  // Validate cache mappings before its independent commit, too.
  remapStagedFiles(
    closureResult.cacheOutputFiles,
    staging.finalCacheDir,
    resolved.finalCacheDir,
  );
  const prepared = await preparePublication(
    context,
    resolved,
    closureResult.outputFiles,
    staging.outDir,
  );
  let failure: unknown[] = [];
  try {
    await replaceDirectory(staging.finalCacheDir, resolved.finalCacheDir);
    await commitPublication(prepared, staging.outDir, context.options.outDir);
  } catch (error) {
    failure = [error];
  }
  await cleanupPublication(prepared, ...failure);
  return prepared.outputFiles;
}

/** Each tree/file has its own commit; this is not a whole-filesystem transaction. */
async function commitPublication(
  prepared: PreparedPublication,
  stagedOutDir: string,
  outDir: string,
) {
  await replaceDirectory(stagedOutDir, outDir);
  for (const { temporary, destination } of prepared.externalFiles)
    await fs.rename(temporary, destination);
}

async function cleanupPublication(
  prepared: PreparedPublication,
  ...primary: unknown[]
) {
  const failures = [...primary];
  for (const { temporary } of prepared.externalFiles) {
    try {
      await fs.rm(temporary, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Output publication or temporary-file cleanup failed.",
    );
}

async function replaceDirectory(stagingDir: string, targetDir: string) {
  const backupDir = `${targetDir}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await fs.rename(targetDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await fs.rename(stagingDir, targetDir);
  } catch (error) {
    if (hasBackup) {
      try {
        await fs.rename(backupDir, targetDir);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `Failed to publish ${targetDir}; previous contents remain at ${backupDir}.`,
        );
      }
    }
    throw error;
  }
  if (hasBackup) await fs.rm(backupDir, { force: true, recursive: true });
}

function remapStagedFiles(
  filePaths: string[],
  stagingDir: string,
  targetDir: string,
) {
  return filePaths.map((filePath) => {
    const relative = path.relative(stagingDir, filePath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Staged output escaped its directory: ${filePath}`);
    }
    return path.join(targetDir, relative);
  });
}

export async function restoreCachedBuild(
  context: BuildContext,
  resolved: ResolvedBuild,
): Promise<BuildResult | null> {
  if (context.options.cache.mode !== "persistent") return null;
  const metadata = await readJsonIfExists(
    path.join(resolved.finalCacheDir, "meta.json"),
    isFinalCacheMetadata,
  );
  if (
    !metadata ||
    metadata.finalKey !== resolved.finalKey ||
    metadata.optionsSignature !== context.optionsSignature ||
    metadata.packageSignature !== context.packageSignature ||
    !(await fileContentSnapshotMatches(metadata.typeMetadataDependencies)) ||
    (context.options.viteRuntimeSourceMapFile &&
      !(await filesExist([context.options.viteRuntimeSourceMapFile])))
  )
    return null;
  await validateOutputPathBoundaries(
    context.options,
    resolved.workspaceDir,
    Object.keys(metadata.typeMetadataDependencies),
  );
  const cacheRoot = path.join(resolved.finalCacheDir, "outputs");
  const artifacts = Object.fromEntries(
    metadata.artifacts.map(({ name, digest, size }) => [
      path.join(cacheRoot, name),
      { digest, size },
    ]),
  );
  if (!(await fileContentSnapshotMatches(artifacts))) return null;
  const outDir = context.options.outDir;
  await ensureParentDirectory(outDir);
  const stagedOutDir = await fs.mkdtemp(
    path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`),
  );
  let prepared: PreparedPublication | undefined;
  const failures: unknown[] = [];
  try {
    const stagedFiles = await runWithConcurrency(
      metadata.artifacts,
      8,
      async ({ name }) => {
        const destination = path.join(stagedOutDir, name);
        await ensureParentDirectory(destination);
        await fs.copyFile(path.join(cacheRoot, name), destination);
        return destination;
      },
    );
    prepared = await preparePublication(
      context,
      resolved,
      stagedFiles,
      stagedOutDir,
    );
    await commitPublication(prepared, stagedOutDir, outDir);
  } catch (error) {
    failures.push(error);
  }
  if (prepared) {
    try {
      await cleanupPublication(prepared);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await fs.rm(stagedOutDir, { force: true, recursive: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Cached output restoration and cleanup failed.",
    );
  return successfulBuild(prepared!.outputFiles, true);
}
