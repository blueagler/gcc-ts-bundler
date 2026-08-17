import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { collectFileStates, matchFileStates } from "../native/load";
import { uniqueSortedStrings } from "./files";

export interface ContentIdentity {
  digest: string;
  size: number;
}

export type FileContentSnapshot = Record<string, ContentIdentity>;

export interface FileStateSnapshot extends ContentIdentity {
  mtimeMs: number;
}

export interface PublishedOutputSnapshot extends ContentIdentity {
  name: string;
}

export async function collectFileContentSnapshot(
  filePaths: string[],
): Promise<FileContentSnapshot> {
  const entries = await Promise.all(
    uniqueSortedStrings(filePaths).map(async (filePath) => {
      const stat = await fs.stat(filePath);
      return [
        filePath,
        {
          digest: await hashFile(filePath),
          size: stat.size,
        } satisfies ContentIdentity,
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function fileContentSnapshotMatches(
  snapshot: FileContentSnapshot,
  expectedFilePaths: string[] = Object.keys(snapshot),
): Promise<boolean> {
  const expected = uniqueSortedStrings(expectedFilePaths);
  if (
    expected.length !== Object.keys(snapshot).length ||
    expected.some((filePath) => !(filePath in snapshot))
  ) {
    return false;
  }

  const states = collectFileStates(expected);
  if (
    states.some((state) => {
      const identity = snapshot[state.filePath];
      return !identity || !state.exists || state.size !== identity.size;
    })
  ) {
    return false;
  }

  const digests = await Promise.all(
    expected.map((filePath) => hashFile(filePath).catch(() => null)),
  );
  return expected.every(
    (filePath, index) => digests[index] === snapshot[filePath]?.digest,
  );
}

export async function collectTrackedFiles(
  filePaths: string[],
): Promise<Record<string, FileStateSnapshot>> {
  const states = collectFileStates(uniqueSortedStrings(filePaths)).filter(
    (state) => state.exists,
  );
  const entries = await Promise.all(
    states.map(
      async (state) =>
        [
          state.filePath,
          {
            digest: await hashFile(state.filePath),
            mtimeMs: state.mtimeMs,
            size: state.size,
          } satisfies FileStateSnapshot,
        ] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export async function trackedFilesMatch(
  trackedFiles: Record<string, FileStateSnapshot>,
): Promise<boolean> {
  const entries = Object.entries(trackedFiles);
  if (
    !matchFileStates(
      entries.map(([filePath, state]) => ({
        exists: true,
        filePath,
        mtimeMs: state.mtimeMs,
        size: state.size,
      })),
    )
  ) {
    return false;
  }

  const digests = await Promise.all(
    entries.map(([filePath]) => hashFile(filePath).catch(() => null)),
  );
  return entries.every(([, state], index) => digests[index] === state.digest);
}

export async function filesExist(filePaths: string[]): Promise<boolean> {
  return collectFileStates(uniqueSortedStrings(filePaths)).every(
    (state) => state.exists,
  );
}

export async function publishedOutputsMatchSnapshot(
  publishedOutputs: PublishedOutputSnapshot[],
  outDir: string,
): Promise<boolean> {
  const expectedNames = publishedOutputs
    .map((output) => output.name)
    .sort((left, right) => left.localeCompare(right));
  const actualNames = await listRelativeFiles(outDir);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    return false;
  }

  const outputPaths = publishedOutputs.map(({ name }) =>
    path.join(outDir, name),
  );
  const states = collectFileStates(outputPaths);
  if (
    states.some(
      (state, index) =>
        !state.exists || state.size !== publishedOutputs[index]?.size,
    )
  ) {
    return false;
  }

  const digests = await Promise.all(
    outputPaths.map((filePath) => hashFile(filePath).catch(() => null)),
  );
  return publishedOutputs.every(
    (output, index) => digests[index] === output.digest,
  );
}

export async function collectPublishedOutputStats(
  outputFiles: string[],
  outDir: string,
) {
  const outputs = await Promise.all(
    uniqueSortedStrings(outputFiles).map(async (filePath) => {
      const stat = await fs.stat(filePath);
      const name = normalizeRelativePath(path.relative(outDir, filePath));
      if (name === ".." || name.startsWith("../") || path.isAbsolute(name)) {
        throw new Error(`Published output escaped outDir: ${filePath}`);
      }
      return {
        digest: await hashFile(filePath),
        name,
        size: stat.size,
      } satisfies PublishedOutputSnapshot;
    }),
  );
  const names = new Set(outputs.map((output) => output.name));
  if (names.size !== outputs.length) {
    throw new Error("Published output file names must be unique.");
  }
  return outputs.sort((left, right) => left.name.localeCompare(right.name));
}

async function listRelativeFiles(rootDir: string, currentDir = rootDir) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(rootDir, entryPath)));
    } else {
      files.push(normalizeRelativePath(path.relative(rootDir, entryPath)));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(relativePath: string) {
  return relativePath.replace(/\\/gu, "/");
}

async function hashFile(filePath: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}
