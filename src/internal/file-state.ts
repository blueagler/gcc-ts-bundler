import fs from "fs";
import path from "path";

import {
  collectFileStates,
  collectPublishedOutputStats as collectPublishedOutputStatsNative,
  matchFileStates,
  publishedOutputSnapshotMatches,
  publishedOutputsMatch as publishedOutputsMatchNative,
} from "../native/load";

export interface FileStateSnapshot {
  mtimeMs: number;
  size: number;
}

interface PublishedOutputSnapshot {
  name: string;
  size: number;
}

function uniqueSorted(filePaths: string[]) {
  return [...new Set(filePaths)].sort((left, right) =>
    left.localeCompare(right),
  );
}

export async function collectTrackedFiles(
  filePaths: string[],
): Promise<Record<string, FileStateSnapshot>> {
  const states = collectFileStates(uniqueSorted(filePaths));
  return Object.fromEntries(
    states
      .filter((state) => state.exists)
      .map((state) => [
        state.filePath,
        {
          mtimeMs: state.mtimeMs,
          size: state.size,
        },
      ]),
  );
}

export async function trackedFilesMatch(
  trackedFiles: Record<string, FileStateSnapshot>,
): Promise<boolean> {
  return matchFileStates(
    Object.entries(trackedFiles).map(([filePath, state]) => ({
      exists: true,
      filePath,
      mtimeMs: state.mtimeMs,
      size: state.size,
    })),
  );
}

export async function filesExist(filePaths: string[]): Promise<boolean> {
  return collectFileStates(uniqueSorted(filePaths)).every(
    (state) => state.exists,
  );
}

export async function publishedOutputsMatch(
  outputFiles: string[],
  outDir: string,
): Promise<boolean> {
  return publishedOutputsMatchNative(uniqueSorted(outputFiles), outDir);
}

export async function publishedOutputsMatchSnapshot(
  publishedOutputs: PublishedOutputSnapshot[],
  outDir: string,
): Promise<boolean> {
  return publishedOutputSnapshotMatches(publishedOutputs, outDir);
}

export async function collectPublishedOutputStats(outputFiles: string[]) {
  return collectPublishedOutputStatsNative(uniqueSorted(outputFiles));
}

export async function copyOrLinkFiles(sourceFiles: string[], outDir: string) {
  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const destinationFile = path.join(outDir, path.basename(sourceFile));
      try {
        await fs.promises.link(sourceFile, destinationFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
          throw error;
        }

        await fs.promises.copyFile(sourceFile, destinationFile);
      }
    }),
  );
}
