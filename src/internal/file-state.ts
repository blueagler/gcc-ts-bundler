import {
  collectFileStates,
  collectPublishedOutputStats as collectPublishedOutputStatsNative,
  matchFileStates,
  publishedOutputSnapshotMatches,
  publishedOutputsMatch as publishedOutputsMatchNative,
} from "../native/load";
import { uniqueSortedStrings } from "./files";

export interface FileStateSnapshot {
  mtimeMs: number;
  size: number;
}

interface PublishedOutputSnapshot {
  name: string;
  size: number;
}

export async function collectTrackedFiles(
  filePaths: string[],
): Promise<Record<string, FileStateSnapshot>> {
  const states = collectFileStates(uniqueSortedStrings(filePaths));
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
  return collectFileStates(uniqueSortedStrings(filePaths)).every(
    (state) => state.exists,
  );
}

export async function publishedOutputsMatch(
  outputFiles: string[],
  outDir: string,
): Promise<boolean> {
  return publishedOutputsMatchNative(uniqueSortedStrings(outputFiles), outDir);
}

export async function publishedOutputsMatchSnapshot(
  publishedOutputs: PublishedOutputSnapshot[],
  outDir: string,
): Promise<boolean> {
  return publishedOutputSnapshotMatches(publishedOutputs, outDir);
}

export async function collectPublishedOutputStats(outputFiles: string[]) {
  return collectPublishedOutputStatsNative(uniqueSortedStrings(outputFiles));
}
