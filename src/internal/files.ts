import fs from "fs/promises";
import path from "path";

import { hashContent } from "../cache/hash";

const fileInputHashCache = new Map<string, Promise<string>>();

export function uniqueSortedStrings(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export async function ensureDirectory(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureParentDirectory(filePath: string) {
  await ensureDirectory(path.dirname(filePath));
}

export async function hashFileInput(filePath: string) {
  const stat = await fs.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = fileInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = fs
    .readFile(filePath, "utf-8")
    .then((contents) => hashContent(contents));
  fileInputHashCache.set(cacheKey, pending);
  return pending;
}

export async function hashFilesInOrder(filePaths: string[]) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}

export async function copyOrLinkFiles(sourceFiles: string[], outDir: string) {
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const destinationFile = path.join(outDir, path.basename(sourceFile));
      try {
        await fs.link(sourceFile, destinationFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
          throw error;
        }

        await fs.copyFile(sourceFile, destinationFile);
      }
    }),
  );
}

export async function copyFiles(sourceFiles: string[], outDir: string) {
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const destinationFile = path.join(outDir, path.basename(sourceFile));
      await fs.copyFile(sourceFile, destinationFile);
    }),
  );
}
