import fs from "fs";
import path from "path";

import { collectFileStates, matchFileStates } from "../native/load";

export interface FileStateSnapshot {
  mtimeMs: number;
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
  try {
    const outEntries = (await fs.promises.readdir(outDir)).sort();
    const expectedEntries = outputFiles
      .map((outputFile) => path.basename(outputFile))
      .sort();

    if (
      outEntries.length !== expectedEntries.length ||
      outEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      return false;
    }

    const destinationFiles = outputFiles.map((outputFile) =>
      path.join(outDir, path.basename(outputFile)),
    );
    const states = collectFileStates([...outputFiles, ...destinationFiles]);
    const stateMap = new Map(states.map((state) => [state.filePath, state]));

    return outputFiles.every((outputFile, index) => {
      const sourceState = stateMap.get(outputFile);
      const destinationState = stateMap.get(destinationFiles[index]);
      return (
        sourceState?.exists === true &&
        destinationState?.exists === true &&
        sourceState.size === destinationState.size
      );
    });
  } catch {
    return false;
  }
}

export async function publishedOutputsMatchSnapshot(
  publishedOutputs: Array<{ name: string; size: number }>,
  outDir: string,
): Promise<boolean> {
  try {
    const outEntries = (await fs.promises.readdir(outDir)).sort();
    const expectedEntries = publishedOutputs.map(({ name }) => name).sort();

    if (
      outEntries.length !== expectedEntries.length ||
      outEntries.some((entry, index) => entry !== expectedEntries[index])
    ) {
      return false;
    }

    const states = collectFileStates(
      publishedOutputs.map(({ name }) => path.join(outDir, name)),
    );
    const stateMap = new Map(states.map((state) => [state.filePath, state]));

    return publishedOutputs.every(({ name, size }) => {
      const state = stateMap.get(path.join(outDir, name));
      return state?.exists === true && state.size === size;
    });
  } catch {
    return false;
  }
}

export async function collectPublishedOutputStats(outputFiles: string[]) {
  const states = collectFileStates(outputFiles);
  return states
    .filter((state) => state.exists)
    .map((state) => ({
      name: path.basename(state.filePath),
      size: state.size,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
