import fs from "fs/promises";
import path from "path";

import { hashJson } from "../../cache/hash";
import { readJsonIfExists, writeJson } from "../../cache/store";
import { zipExact } from "../../internal/arrays";
import { ensureDirectory, hashFilesInOrder } from "../../internal/files";
import { isNumber, isObjectOf, isStringArray } from "../../internal/validation";

export interface ClosureJobCacheMetadata {
  artifactFiles: string[];
  version: number;
}

export const CLOSURE_JOB_CACHE_VERSION = 2;

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
}) {
  const artifacts = getCompileJobOutputFiles(job);
  if (job.propertyRenamingReportPath) {
    artifacts.push(job.propertyRenamingReportPath);
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
  job: {
    assumeFunctionWrapper: boolean;
    chunk?: string[] | null;
    compilationLevel: string;
    dependencyMode?: string | null;
    entryPoint?: string[] | null;
    externs: string[];
    js: string[];
    jsOutputFile?: string | null;
    languageIn: string;
    languageOut: string;
    propertyRenamingReportPath?: string | null;
    rewritePolyfills: boolean;
    warningLevel: string;
  };
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
  const filesReady = await Promise.all(
    cachedFiles.map((filePath) =>
      fs
        .stat(filePath)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (filesReady.some((ready) => !ready)) {
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
  job: {
    assumeFunctionWrapper: boolean;
    chunk?: string[] | null;
    compilationLevel: string;
    dependencyMode?: string | null;
    entryPoint?: string[] | null;
    externs: string[];
    js: string[];
    jsOutputFile?: string | null;
    languageIn: string;
    languageOut: string;
    propertyRenamingReportPath?: string | null;
    rewritePolyfills: boolean;
    warningLevel: string;
  };
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
  await writeJson(path.join(jobCacheDir, "meta.json"), {
    artifactFiles: artifactNames,
    version: CLOSURE_JOB_CACHE_VERSION,
  } satisfies ClosureJobCacheMetadata);
}

async function getClosureJobCacheDir(
  cacheDir: string,
  job: {
    assumeFunctionWrapper: boolean;
    chunk?: string[] | null;
    compilationLevel: string;
    dependencyMode?: string | null;
    entryPoint?: string[] | null;
    externs: string[];
    js: string[];
    jsOutputFile?: string | null;
    languageIn: string;
    languageOut: string;
    propertyRenamingReportPath?: string | null;
    rewritePolyfills: boolean;
    warningLevel: string;
  },
  compilerVersion: string,
) {
  const outputFiles = getCompileJobOutputFiles(job);
  const jsHash = await hashFilesInOrder(job.js);
  const externHash = await hashFilesInOrder(job.externs);
  const cacheKey = hashJson({
    compilerVersion,
    externHash,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      hasPropertyRenamingReport: Boolean(job.propertyRenamingReportPath),
      jsOutputKinds: outputFiles.map((outputFile) => path.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel,
    },
    jsHash,
    version: CLOSURE_JOB_CACHE_VERSION,
  });
  return path.join(cacheDir, cacheKey);
}
