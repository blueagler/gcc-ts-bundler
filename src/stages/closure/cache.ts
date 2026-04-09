import fs from "fs/promises";
import path from "path";

import { hashContent, hashJson } from "../../cache/hash";
import { readJsonIfExists, writeJson } from "../../cache/store";

export interface ClosureJobCacheMetadata {
  outputFiles: string[];
  version: number;
}

export const CLOSURE_JOB_CACHE_VERSION = 1;
const closureInputHashCache = new Map<string, Promise<string>>();

export function getCompileJobOutputFiles(job: {
  chunkOutputPathPrefix?: string | null;
  chunk?: string[] | null;
  jsOutputFile?: string | null;
}) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) =>
      path.join(job.chunkOutputPathPrefix!, `${chunkSpec.split(":", 1)[0]}.js`),
    );
  }
  throw new Error("Closure compile job is missing output configuration.");
}

export async function tryRestoreCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  outputFiles,
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
    rewritePolyfills: boolean;
    warningLevel: string;
  };
  outputFiles: string[];
}) {
  const jobCacheDir = await getClosureJobCacheDir(
    cacheDir,
    job,
    compilerVersion,
  );
  const metadata = await readJsonIfExists<ClosureJobCacheMetadata>(
    path.join(jobCacheDir, "meta.json"),
  );
  if (
    !metadata ||
    metadata.version !== CLOSURE_JOB_CACHE_VERSION ||
    metadata.outputFiles.length !== outputFiles.length
  ) {
    return false;
  }

  const cachedFiles = metadata.outputFiles.map((fileName) =>
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
    outputFiles.map(async (outputFile, index) => {
      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      await fs.copyFile(cachedFiles[index], outputFile);
    }),
  );
  return true;
}

export async function persistCachedClosureJob({
  cacheDir,
  compilerVersion,
  job,
  outputFiles,
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
    rewritePolyfills: boolean;
    warningLevel: string;
  };
  outputFiles: string[];
  compilerVersion: string;
}) {
  const jobCacheDir = await getClosureJobCacheDir(
    cacheDir,
    job,
    compilerVersion,
  );
  await fs.rm(jobCacheDir, { force: true, recursive: true });
  await fs.mkdir(jobCacheDir, { recursive: true });
  const outputNames = outputFiles.map((outputFile) =>
    path.basename(outputFile),
  );
  await Promise.all(
    outputFiles.map((outputFile, index) =>
      fs.copyFile(outputFile, path.join(jobCacheDir, outputNames[index])),
    ),
  );
  await writeJson(path.join(jobCacheDir, "meta.json"), {
    outputFiles: outputNames,
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

async function hashFilesInOrder(filePaths: string[]) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}

async function hashFileInput(filePath: string) {
  const stat = await fs.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = closureInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = fs
    .readFile(filePath, "utf-8")
    .then((contents) => hashContent(contents));
  closureInputHashCache.set(cacheKey, pending);
  return pending;
}
