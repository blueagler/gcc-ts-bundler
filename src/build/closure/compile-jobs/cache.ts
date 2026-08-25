import fs from "fs/promises";
import path from "path";

import { ensureDirectory } from "../../../shared/files";
import {
  getCompileJobArtifactFiles,
  getCompileJobOutputFiles,
  persistCachedClosureJob,
  tryRestoreCachedClosureJob,
} from "../cache";
import {
  resolveClosureCompilerVersionTag,
  type ClosureCompilerEnvironment,
} from "../compiler";
import type { PreparedCompileJob } from "./types";

/**
 * Feeds renaming maps from the previous build back into Closure so
 * unchanged chunks stay byte-identical across builds. Without this, one new
 * property name reshuffles the global renaming tables and invalidates every
 * emitted chunk; with pinned maps only genuinely changed chunks differ.
 * Maps live in the persistent cache and reset with `clean-cache`.
 */
export async function applyStableRenamingMaps(
  job: PreparedCompileJob,
  cacheDir: string | null,
): Promise<PreparedCompileJob> {
  if (!cacheDir || !job.propertyRenamingReportPath) {
    return job;
  }
  const stableJob: PreparedCompileJob = { ...job };
  stableJob.variableRenamingReportPath = path.join(
    path.dirname(job.propertyRenamingReportPath),
    "variable-renaming-report.txt",
  );
  const mapsDir = renamingMapsDirectory(cacheDir, job);
  const propertyMap = path.join(mapsDir, "property.map");
  const variableMap = path.join(mapsDir, "variable.map");
  const [hasPropertyMap, hasVariableMap] = await Promise.all(
    [propertyMap, variableMap].map((filePath) =>
      fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (hasPropertyMap) {
    stableJob.propertyMapInputFile = propertyMap;
  }
  if (hasVariableMap) {
    stableJob.variableMapInputFile = variableMap;
  }
  return stableJob;
}

function renamingMapsDirectory(cacheDir: string, job: PreparedCompileJob) {
  const firstOutput = getCompileJobOutputFiles(job)[0] ?? "job";
  // Sibling of the closure-jobs cache: job cache entries are content-keyed
  // and immutable, while these maps are mutable per-project state.
  return path.join(
    path.dirname(cacheDir),
    "renaming-maps",
    path.basename(firstOutput, ".js"),
  );
}

async function persistRenamingMaps(
  job: PreparedCompileJob,
  cacheDir: string | null,
) {
  if (
    !cacheDir ||
    !job.propertyRenamingReportPath ||
    !job.variableRenamingReportPath
  ) {
    return;
  }
  const mapsDir = renamingMapsDirectory(cacheDir, job);
  await ensureDirectory(mapsDir);
  await Promise.all([
    fs
      .copyFile(
        job.propertyRenamingReportPath,
        path.join(mapsDir, "property.map"),
      )
      .catch(() => {}),
    fs
      .copyFile(
        job.variableRenamingReportPath,
        path.join(mapsDir, "variable.map"),
      )
      .catch(() => {}),
  ]);
}

export async function restorePreparedClosureJob({
  compilerEnvironment,
  cacheDir,
  job,
}: {
  compilerEnvironment: ClosureCompilerEnvironment;
  cacheDir: string | null;
  job: PreparedCompileJob;
}): Promise<{ cacheHit: true; exitCode: 0 } | null> {
  const cacheJob = {
    ...job,
    compilerEnvironment: compilerEnvironment.options,
  };
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  const cached = cacheDir
    ? await tryRestoreCachedClosureJob({
        artifactFiles,
        cacheDir,
        compilerVersion,
        job: cacheJob,
      })
    : false;
  if (!cached) {
    return null;
  }
  await persistRenamingMaps(job, cacheDir);
  return {
    cacheHit: true,
    exitCode: 0,
  };
}

export async function persistPreparedClosureJob({
  compilerEnvironment,
  cacheDir,
  job,
}: {
  compilerEnvironment: ClosureCompilerEnvironment;
  cacheDir: string | null;
  job: PreparedCompileJob;
}) {
  const cacheJob = {
    ...job,
    compilerEnvironment: compilerEnvironment.options,
  };
  const artifactFiles = getCompileJobArtifactFiles(job);
  const compilerVersion = resolveClosureCompilerVersionTag();
  if (cacheDir) {
    await persistCachedClosureJob({
      artifactFiles,
      cacheDir,
      compilerVersion,
      job: cacheJob,
    });
  }
  await persistRenamingMaps(job, cacheDir);
}
