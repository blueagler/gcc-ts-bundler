import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { readJsonIfExists, writeJson } from "../../shared/cache-store";
import { zipExact } from "../../shared/arrays";
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
  isStringArray,
  recordOf,
} from "../../shared/validation";
import type { NativeTypeMetadataCounts } from "../../native/load";
import type { ClosureCompilerOptions } from "./compiler";

interface ClosureJobCacheMetadata {
  artifacts: FileContentSnapshot;
  artifactFiles: string[];
  version: number;
}

const CLOSURE_JOB_CACHE_VERSION = 6;

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

export async function tryRestoreCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  artifactFiles,
}: {
  cacheDir: string;
  compilerVersion: string;
  job: ClosureCompileJobConfig;
  artifactFiles: string[];
}) {
  const jobCacheDir = await getClosureJobCacheDir(
    cacheDir,
    job,
    compilerVersion,
  );
  const metadata = await readJsonIfExists(
    path.join(jobCacheDir, "meta.json"),
    isClosureJobCacheMetadata,
  );
  if (
    !metadata ||
    metadata.version !== CLOSURE_JOB_CACHE_VERSION ||
    metadata.artifactFiles.length !== artifactFiles.length
  ) {
    return false;
  }

  const cachedFiles = metadata.artifactFiles.map((fileName) =>
    path.join(jobCacheDir, fileName),
  );
  if (!(await fileContentSnapshotMatches(metadata.artifacts, cachedFiles))) {
    return false;
  }

  await Promise.all(
    zipExact(
      artifactFiles,
      cachedFiles,
      "Closure artifacts and cached files",
    ).map(async ([artifactFile, cachedFile]) => {
      await ensureDirectory(path.dirname(artifactFile));
      await fs.copyFile(cachedFile, artifactFile);
    }),
  );
  return true;
}

const isClosureJobCacheMetadata = isObjectOf<ClosureJobCacheMetadata>({
  artifacts: recordOf(
    isObjectOf<FileContentSnapshot[string]>({
      digest: isString,
      size: isNumber,
    }),
  ),
  artifactFiles: isStringArray,
  version: isNumber,
});

export async function persistCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  artifactFiles,
}: {
  cacheDir: string;
  job: ClosureCompileJobConfig;
  artifactFiles: string[];
  compilerVersion: string;
}) {
  const jobCacheDir = await getClosureJobCacheDir(
    cacheDir,
    job,
    compilerVersion,
  );
  await fs.rm(jobCacheDir, { force: true, recursive: true });
  await ensureDirectory(jobCacheDir);
  const artifactNames = artifactFiles.map((artifactFile) =>
    path.basename(artifactFile),
  );
  await Promise.all(
    zipExact(
      artifactFiles,
      artifactNames,
      "Closure artifacts and artifact names",
    ).map(([artifactFile, artifactName]) =>
      fs.copyFile(artifactFile, path.join(jobCacheDir, artifactName)),
    ),
  );
  const artifacts = await collectFileContentSnapshot(
    artifactNames.map((artifactName) => path.join(jobCacheDir, artifactName)),
  );
  await writeJson(path.join(jobCacheDir, "meta.json"), {
    artifacts,
    artifactFiles: artifactNames,
    version: CLOSURE_JOB_CACHE_VERSION,
  } satisfies ClosureJobCacheMetadata);
}

async function getClosureJobCacheDir(
  cacheDir: string,
  job: ClosureCompileJobConfig,
  compilerVersion: string,
) {
  const outputFiles = getCompileJobOutputFiles(job);
  const jsHash = await hashFilesInOrder(job.js);
  const externHash = await hashFilesInOrder(job.externs);
  const renamingMapHash = await hashFilesInOrder(
    [job.propertyMapInputFile, job.variableMapInputFile].filter(
      (filePath): filePath is string => typeof filePath === "string",
    ),
  );
  const cacheKey = hashJson({
    compilerEnvironment: job.compilerEnvironment ?? {},
    compilerVersion,
    externHash,
    renamingMapHash,
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
    jsHash,
    version: CLOSURE_JOB_CACHE_VERSION,
  });
  return path.join(cacheDir, cacheKey);
}

async function hashFilesInOrder(filePaths: string[]) {
  return Promise.all(
    filePaths.map(async (filePath) =>
      crypto
        .createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex"),
    ),
  );
}
