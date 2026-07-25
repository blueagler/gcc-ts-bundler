import fs from "fs/promises";
import path from "path";

import { hashContent } from "./hash";
import { hasErrorCode } from "./validation";

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

export type PublishFilesMode = "copy" | "link-or-copy";

export interface DirectoryEntry {
  content: string | Uint8Array;
  relativePath: string;
}

export async function publishFilesToDirectory(
  sourceFiles: string[],
  outDir: string,
  mode: PublishFilesMode,
) {
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const destinationFile = path.join(outDir, path.basename(sourceFile));
      if (mode === "copy") {
        await fs.copyFile(sourceFile, destinationFile);
        return;
      }
      try {
        await fs.link(sourceFile, destinationFile);
      } catch (error) {
        if (
          !hasErrorCode(error, "EXDEV") &&
          !hasErrorCode(error, "EEXIST") &&
          !hasErrorCode(error, "EPERM")
        ) {
          throw error;
        }

        await fs.copyFile(sourceFile, destinationFile);
      }
    }),
  );
}

export async function syncDirectoryEntries(
  rootDir: string,
  entries: DirectoryEntry[],
  options: {
    preserve?: (relativePath: string) => boolean;
  } = {},
) {
  await ensureDirectory(rootDir);
  const expectedEntries = new Map(
    entries.map((entry) => [normalizeRelativePath(entry.relativePath), entry]),
  );
  const existingFiles = await listRelativeFiles(rootDir);

  await Promise.all(
    existingFiles
      .filter(
        (relativePath) =>
          !expectedEntries.has(relativePath) &&
          !(options.preserve?.(relativePath) ?? false),
      )
      .map((relativePath) =>
        fs.rm(path.join(rootDir, relativePath), { force: true }),
      ),
  );
  await removeEmptyDirectories(rootDir);

  await Promise.all(
    [...expectedEntries.values()].map(async (entry) => {
      const filePath = path.join(
        rootDir,
        normalizeRelativePath(entry.relativePath),
      );
      await ensureParentDirectory(filePath);
      await writeFileIfChanged(filePath, entry.content);
    }),
  );
}

export async function writeFileIfChanged(
  filePath: string,
  content: string | Uint8Array,
) {
  const nextContent =
    typeof content === "string" ? content : Buffer.from(content);
  let currentContent: string | Buffer | null = null;
  try {
    currentContent = await fs.readFile(
      filePath,
      typeof content === "string" ? "utf8" : undefined,
    );
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  if (
    currentContent !== null &&
    fileContentsEqual(currentContent, nextContent)
  ) {
    return;
  }

  await fs.writeFile(filePath, nextContent);
}

async function listRelativeFiles(rootDir: string, currentDir = rootDir) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(rootDir, entryPath)));
      continue;
    }
    files.push(normalizeRelativePath(path.relative(rootDir, entryPath)));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function removeEmptyDirectories(rootDir: string, currentDir = rootDir) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const entryPath = path.join(currentDir, entry.name);
        await removeEmptyDirectories(rootDir, entryPath);
        const nestedEntries = await fs.readdir(entryPath).catch((error) => {
          if (hasErrorCode(error, "ENOENT")) {
            return [];
          }
          throw error;
        });
        if (nestedEntries.length === 0 && entryPath !== rootDir) {
          await fs.rmdir(entryPath).catch((error) => {
            if (!hasErrorCode(error, "ENOENT")) {
              throw error;
            }
          });
        }
      }),
  );
}

function fileContentsEqual(
  currentContent: string | Buffer,
  nextContent: string | Buffer,
) {
  if (typeof currentContent === "string" && typeof nextContent === "string") {
    return currentContent === nextContent;
  }
  const currentBuffer =
    typeof currentContent === "string"
      ? Buffer.from(currentContent)
      : currentContent;
  const nextBuffer =
    typeof nextContent === "string" ? Buffer.from(nextContent) : nextContent;
  return currentBuffer.equals(nextBuffer);
}

function normalizeRelativePath(relativePath: string) {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/u, "");
}
