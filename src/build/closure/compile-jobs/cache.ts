import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

import { ensureDirectory } from "../../../shared/files";
import { runWithConcurrency } from "../../../shared/concurrency";
import { logInternalDetail } from "../../../shared/timing";
import type { PreparedCompileJob } from "./types";

/**
 * Reuses previous renaming assignments to improve name stability across edits.
 * This does not guarantee byte-identical chunks: output can depend on map
 * history. Cache-off builds omit these inputs for history-independent output.
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
  stableJob.variableRenamingReportPath = pairedVariableRenamingReportPath(
    job.propertyRenamingReportPath,
  );
  const mapsDir = renamingMapsDirectory(cacheDir, job);
  const propertyMap = path.join(mapsDir, "property.map");
  const variableMap = path.join(mapsDir, "variable.map");
  const [propertyMapInput, variableMapInput] = await runWithConcurrency(
    [propertyMap, variableMap],
    2,
    wellFormedRenamingMapPath,
  );
  if (propertyMapInput) {
    stableJob.propertyMapInputFile = propertyMapInput;
  }
  if (variableMapInput) {
    stableJob.variableMapInputFile = variableMapInput;
  }
  return stableJob;
}

function pairedVariableRenamingReportPath(
  propertyRenamingReportPath: string,
): string {
  const suffix = "property-renaming-report.txt";
  if (propertyRenamingReportPath.endsWith(suffix)) {
    return `${propertyRenamingReportPath.slice(0, -suffix.length)}variable-renaming-report.txt`;
  }
  return path.join(
    path.dirname(propertyRenamingReportPath),
    "variable-renaming-report.txt",
  );
}

function chunkSpecName(chunkSpec: string): string {
  const separator = chunkSpec.indexOf(":");
  return separator === -1 ? chunkSpec : chunkSpec.slice(0, separator);
}

/**
 * Identity for the per-job renaming-maps directory: unique across jobs in a
 * compile, and stable across runs. Output absolute paths include a per-run
 * staging directory, so they cannot be hashed. Chunk names (and the
 * jsOutputFile basename for one-file jobs) do not.
 */
function renamingMapJobIdentity(job: PreparedCompileJob): string {
  if (job.chunk && job.chunk.length > 0) {
    return job.chunk
      .map(chunkSpecName)
      .sort((left, right) => left.localeCompare(right))
      .join("\n");
  }
  if (job.jsOutputFile) {
    return path.basename(job.jsOutputFile, ".js");
  }
  return "job";
}

function renamingMapsDirectory(cacheDir: string, job: PreparedCompileJob) {
  const digest = createHash("sha256")
    .update(renamingMapJobIdentity(job))
    .digest("hex");
  // Sibling of the closure-jobs cache: job cache entries are content-keyed
  // and immutable, while these maps are mutable per-project state.
  return path.join(path.dirname(cacheDir), "renaming-maps", digest);
}

function renamingMapTextIsWellFormed(text: string): boolean {
  for (const line of text.split("\n")) {
    if (line.length > 0 && !line.includes(":")) {
      return false;
    }
  }
  return true;
}

async function wellFormedRenamingMapPath(
  filePath: string,
): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  if (renamingMapTextIsWellFormed(text)) {
    return filePath;
  }
  logInternalDetail(
    "cache:renaming-maps",
    `discarding malformed map ${filePath}`,
  );
  await fs.rm(filePath, { force: true }).catch(() => {});
  return null;
}

async function persistRenamingMapFile(sourcePath: string, destPath: string) {
  let text: string;
  try {
    text = await fs.readFile(sourcePath, "utf8");
  } catch {
    return;
  }
  if (!renamingMapTextIsWellFormed(text)) {
    logInternalDetail(
      "cache:renaming-maps",
      `skipping incomplete report ${sourcePath}`,
    );
    return;
  }
  const tempPath = `${destPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, text);
    await fs.rename(tempPath, destPath);
  } catch {
    logInternalDetail("cache:renaming-maps", `failed to persist ${destPath}`);
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function persistRenamingMaps(
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
  await runWithConcurrency(
    [
      [job.propertyRenamingReportPath, path.join(mapsDir, "property.map")],
      [job.variableRenamingReportPath, path.join(mapsDir, "variable.map")],
    ] as const,
    2,
    ([source, destination]) => persistRenamingMapFile(source, destination),
  );
}
