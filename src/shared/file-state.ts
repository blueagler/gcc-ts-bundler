import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { collectFileStates } from "../native/load";
import { runWithConcurrency } from "./concurrency";
import { normalizeRelativePath, uniqueSortedStrings } from "./files";

export interface ContentIdentity {
  digest: string;
  size: number;
}

export type FileContentSnapshot = Record<string, ContentIdentity>;

export interface PublishedOutputSnapshot extends ContentIdentity {
  name: string;
}

export async function collectFileContentSnapshot(
  filePaths: string[],
): Promise<FileContentSnapshot> {
  const entries = await runWithConcurrency(
    uniqueSortedStrings(filePaths),
    8,
    async (filePath) => {
      const stat = await fs.stat(filePath);
      return [
        filePath,
        {
          digest: await hashFile(filePath),
          size: stat.size,
        } satisfies ContentIdentity,
      ] as const;
    },
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

  return fileStatesMatchSnapshot(expected, snapshot);
}

export async function filesExist(filePaths: string[]): Promise<boolean> {
  return collectFileStates(uniqueSortedStrings(filePaths)).every(
    (state) => state.exists,
  );
}

export async function collectPublishedOutputStats(
  outputFiles: string[],
  outDir: string,
) {
  const outputs = await runWithConcurrency(
    uniqueSortedStrings(outputFiles),
    8,
    async (filePath) => {
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
    },
  );
  const names = new Set(outputs.map((output) => output.name));
  if (names.size !== outputs.length) {
    throw new Error("Published output file names must be unique.");
  }
  return outputs.sort((left, right) => left.name.localeCompare(right.name));
}

async function fileStatesMatchSnapshot(
  expected: string[],
  snapshot: Record<string, ContentIdentity>,
): Promise<boolean> {
  const states = collectFileStates(expected);
  if (
    states.some((state) => {
      const identity = snapshot[state.filePath];
      return !identity || !state.exists || state.size !== identity.size;
    })
  ) {
    return false;
  }

  const digests = await runWithConcurrency(expected, 8, (filePath) =>
    hashFile(filePath).catch(() => null),
  );
  return expected.every(
    (filePath, index) => digests[index] === snapshot[filePath]?.digest,
  );
}

async function hashFile(filePath: string) {
  return crypto
    .createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}
