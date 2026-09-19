import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { readJsonIfExists, writeJson } from "../../shared/cache-store";
import { zipExact } from "../../shared/arrays";
import { runWithConcurrency } from "../../shared/concurrency";
import { ensureDirectory } from "../../shared/files";
import {
  collectFileContentSnapshot,
  fileContentSnapshotMatches,
  type FileContentSnapshot,
} from "../../shared/file-state";
import { hashJson } from "../../shared/hash";
import {
  isNumber,
  isObjectOf,
  isString,
  recordOf,
} from "../../shared/validation";
import type { NativeTypeMetadataCounts } from "../../native/load";
import type { ClosureCompilerOptions } from "./compiler";

interface ClosureJobCacheMetadata {
  artifacts: FileContentSnapshot;
  version: number;
}

const CLOSURE_JOB_CACHE_VERSION = 7;

export interface ClosureCompileJobConfig {
  assumeFunctionWrapper: boolean;
  chunk?: string[] | null;
  chunkOutputType?: string | null;
  compilerEnvironment?: ClosureCompilerOptions;
  compilationLevel: string;
  dependencyMode?: string | null;
  entryPoint?: string[] | null;
  env?: string | null;
  hasTypeMetadata: boolean;
  externs: string[];
  js: string[];
  jsOutputFile?: string | null;
  languageIn: string;
  languageOut: string;
  propertyMapInputFile?: string | null;
  propertyRenamingReportPath?: string | null;
  variableMapInputFile?: string | null;
  variableRenamingReportPath?: string | null;
  renamePrefixNamespace?: string | null;
  rewritePolyfills: boolean;
  /** Silent `checkTypes` inference; see `applyTypeInference`. Not derivable
   * from any hashed file, so it has to be keyed explicitly. */
  typeInference?: boolean;
  typeMetadataCounts: NativeTypeMetadataCounts;
  warningLevel: string;
}

export function getCompileJobOutputFiles(job: {
  chunkOutputPathPrefix?: string | null;
  chunk?: string[] | null;
  jsOutputFile?: string | null;
}) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    const outputPathPrefix = job.chunkOutputPathPrefix;
    return job.chunk.map((chunkSpec) =>
      path.join(outputPathPrefix, `${chunkSpec.split(":", 1)[0]}.js`),
    );
  }
  throw new Error("Closure compile job is missing output configuration.");
}

export function getCompileJobArtifactFiles(job: {
  chunkOutputPathPrefix?: string | null;
  chunk?: string[] | null;
  jsOutputFile?: string | null;
  propertyRenamingReportPath?: string | null;
  variableRenamingReportPath?: string | null;
}) {
  const artifacts = getCompileJobOutputFiles(job);
  if (job.propertyRenamingReportPath) {
    artifacts.push(job.propertyRenamingReportPath);
  }
  if (job.variableRenamingReportPath) {
    artifacts.push(job.variableRenamingReportPath);
  }
  return artifacts;
}

export interface PreparedClosureJobCache {
  artifactFiles: string[];
  inputHashes: ClosureJobInputHashes;
  job: ClosureCompileJobConfig;
  jobCacheDir: string;
}

interface ClosureJobInputHashes {
  externHash: string[];
  jsHash: string[];
  renamingMapHash: string[];
}

export async function prepareClosureJobCache({
  cacheDir,
  compilerVersion,
  job,
  artifactFiles,
}: {
  artifactFiles: string[];
  cacheDir: string;
  compilerVersion: string;
  job: ClosureCompileJobConfig;
}): Promise<PreparedClosureJobCache> {
  const inputHashes = await hashClosureJobInputs(job);
  const outputFiles = getCompileJobOutputFiles(job);
  const cacheKey = hashJson({
    compilerEnvironment: job.compilerEnvironment ?? {},
    compilerVersion,
    externHash: inputHashes.externHash,
    renamingMapHash: inputHashes.renamingMapHash,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      chunkOutputType: job.chunkOutputType ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      env: job.env ?? null,
      hasPropertyRenamingReport: Boolean(job.propertyRenamingReportPath),
      hasRenamingMapInputs: [
        Boolean(job.propertyMapInputFile),
        Boolean(job.variableMapInputFile),
      ],
      hasVariableRenamingReport: Boolean(job.variableRenamingReportPath),
      jsOutputKinds: outputFiles.map((outputFile) => path.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      typeInference: job.typeInference ?? false,
      typeMetadataCounts: job.typeMetadataCounts,
      warningLevel: job.warningLevel,
    },
    jsHash: inputHashes.jsHash,
    version: CLOSURE_JOB_CACHE_VERSION,
  });
  return {
    artifactFiles,
    inputHashes,
    job,
    jobCacheDir: path.join(cacheDir, cacheKey),
  };
}

export async function tryRestoreCachedClosureJob(
  prepared: PreparedClosureJobCache,
) {
  const { artifactFiles, jobCacheDir } = prepared;
  const metadata = await readJsonIfExists(
    path.join(jobCacheDir, "meta.json"),
    isClosureJobCacheMetadata,
  );
  const cachedFiles = metadata === null ? [] : Object.keys(metadata.artifacts);
  if (
    !metadata ||
    metadata.version !== CLOSURE_JOB_CACHE_VERSION ||
    cachedFiles.length !== artifactFiles.length
  ) {
    return false;
  }
  if (!(await fileContentSnapshotMatches(metadata.artifacts, cachedFiles))) {
    return false;
  }

  const cachedByName = new Map(
    cachedFiles.map((cachedFile) => [path.basename(cachedFile), cachedFile]),
  );
  if (cachedByName.size !== cachedFiles.length) {
    return false;
  }
  const copies: Array<readonly [string, string]> = [];
  for (const artifactFile of artifactFiles) {
    const cachedFile = cachedByName.get(path.basename(artifactFile));
    if (cachedFile === undefined) {
      return false;
    }
    copies.push([artifactFile, cachedFile]);
  }

  await runWithConcurrency(copies, 16, async ([artifactFile, cachedFile]) => {
    await ensureDirectory(path.dirname(artifactFile));
    await fs.copyFile(cachedFile, artifactFile);
  });
  return true;
}

const isClosureJobCacheMetadata = isObjectOf<ClosureJobCacheMetadata>({
  artifacts: recordOf(
    isObjectOf<FileContentSnapshot[string]>({
      digest: isString,
      size: isNumber,
    }),
  ),
  version: isNumber,
});

export async function persistCachedClosureJob(
  prepared: PreparedClosureJobCache,
) {
  if (!(await closureJobInputsMatch(prepared))) {
    return;
  }
  const { artifactFiles, jobCacheDir } = prepared;
  await fs.rm(jobCacheDir, { force: true, recursive: true });
  await ensureDirectory(jobCacheDir);
  const artifactNames = artifactFiles.map((artifactFile) =>
    path.basename(artifactFile),
  );
  await runWithConcurrency(
    zipExact(
      artifactFiles,
      artifactNames,
      "Closure artifacts and artifact names",
    ),
    16,
    ([artifactFile, artifactName]) =>
      fs.copyFile(artifactFile, path.join(jobCacheDir, artifactName)),
  );
  const artifacts = await collectFileContentSnapshot(
    artifactNames.map((artifactName) => path.join(jobCacheDir, artifactName)),
  );
  await writeJson(path.join(jobCacheDir, "meta.json"), {
    artifacts,
    version: CLOSURE_JOB_CACHE_VERSION,
  } satisfies ClosureJobCacheMetadata);
}

async function hashClosureJobInputs(
  job: ClosureCompileJobConfig,
): Promise<ClosureJobInputHashes> {
  return {
    externHash: await hashFilesInOrder(job.externs),
    jsHash: await hashFilesInOrder(job.js),
    renamingMapHash: await hashFilesInOrder(
      [job.propertyMapInputFile, job.variableMapInputFile].filter(
        (filePath): filePath is string => typeof filePath === "string",
      ),
    ),
  };
}

async function closureJobInputsMatch(prepared: PreparedClosureJobCache) {
  try {
    const current = await hashClosureJobInputs(prepared.job);
    return (
      current.externHash.length === prepared.inputHashes.externHash.length &&
      current.externHash.every(
        (hash, index) => hash === prepared.inputHashes.externHash[index],
      ) &&
      current.jsHash.length === prepared.inputHashes.jsHash.length &&
      current.jsHash.every(
        (hash, index) => hash === prepared.inputHashes.jsHash[index],
      ) &&
      current.renamingMapHash.length ===
        prepared.inputHashes.renamingMapHash.length &&
      current.renamingMapHash.every(
        (hash, index) => hash === prepared.inputHashes.renamingMapHash[index],
      )
    );
  } catch {
    return false;
  }
}

async function hashFilesInOrder(filePaths: string[]) {
  return runWithConcurrency(filePaths, 16, async (filePath) =>
    crypto
      .createHash("sha256")
      .update(await fs.readFile(filePath))
      .digest("hex"),
  );
}
