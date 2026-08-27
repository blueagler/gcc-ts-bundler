import fs from "fs/promises";
import path from "path";

import { hashContent } from "./hash";
import { hasErrorCode, isString } from "./validation";

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

export interface DirectoryEntry {
  content: string | Uint8Array;
  relativePath: string;
}

export async function syncDirectoryEntries(
  rootDir: string,
  entries: DirectoryEntry[],
  options: {
    preserve?: (relativePath: string) => boolean;
  } = {},
) {
  const expectedEntries = new Map(
    entries.map((entry) => {
      const relativePath = normalizeRelativePath(entry.relativePath);
      return [
        relativePath,
        {
          content: entry.content,
          filePath: resolveContainedEntryPath(rootDir, relativePath),
        },
      ] as const;
    }),
  );
  await ensureDirectory(rootDir);
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
    [...expectedEntries.values()].map(async ({ content, filePath }) => {
      await ensureParentDirectory(filePath);
      await writeFileIfChanged(filePath, content);
    }),
  );
}

/**
 * Joins an already-normalized entry path onto `rootDir` and refuses any result
 * that lands outside it. Callers derive entry paths with `path.relative` from a
 * source root, so a module resolved outside that root (a `file:`/`link:`
 * workspace dependency, a symlinked source file) yields `../…` and would
 * otherwise write dependency-controlled content outside the staging tree, where
 * the stale-file sweep can never reclaim it.
 */
function resolveContainedEntryPath(rootDir: string, relativePath: string) {
  const filePath = path.join(rootDir, relativePath);
  const contained = normalizeRelativePath(path.relative(rootDir, filePath));
  if (
    contained === ".." ||
    contained.startsWith("../") ||
    path.isAbsolute(contained)
  ) {
    throw new Error(
      `Directory entry escaped ${rootDir}: ${relativePath} resolves to ${filePath}`,
    );
  }
  return filePath;
}

export async function writeFileIfChanged(
  filePath: string,
  content: string | Uint8Array,
) {
  const nextContent = isString(content) ? content : Buffer.from(content);
  let currentContent: string | Buffer | null = null;
  try {
    currentContent = await fs.readFile(
      filePath,
      isString(content) ? "utf8" : undefined,
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

export interface ListRelativeFilesOptions {
  onMissing?: "empty" | "throw";
  onError?: "empty" | "throw";
}

export async function listRelativeFiles(
  rootDir: string,
  options: ListRelativeFilesOptions = {},
) {
  return walkRelativeFiles(rootDir, rootDir, {
    onMissing: options.onMissing ?? "empty",
    onError: options.onError ?? "throw",
  });
}

async function walkRelativeFiles(
  rootDir: string,
  currentDir: string,
  policy: Required<ListRelativeFilesOptions>,
) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    const action = hasErrorCode(error, "ENOENT")
      ? policy.onMissing
      : policy.onError;
    if (action === "empty") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRelativeFiles(rootDir, entryPath, policy)));
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
  if (isString(currentContent) && isString(nextContent)) {
    return currentContent === nextContent;
  }
  const currentBuffer = isString(currentContent)
    ? Buffer.from(currentContent)
    : currentContent;
  const nextBuffer = isString(nextContent)
    ? Buffer.from(nextContent)
    : nextContent;
  return currentBuffer.equals(nextBuffer);
}

export function normalizeRelativePath(relativePath: string) {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/u, "");
}
