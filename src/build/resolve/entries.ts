import path from "path";

import { zipExact } from "../../shared/arrays";
import type { BuildEntry } from "../types";

export function resolveOutputNames(
  entryPaths: string[],
  outputNames: string[],
): string[] {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }

    return outputNames;
  }

  const basenameCounts = new Map<string, number>();
  const basenames = entryPaths.map((entryPath) =>
    path.basename(entryPath).replace(/\.[^/.]+$/, ".js"),
  );

  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }

  return zipExact(entryPaths, basenames, "entries and basenames").map(
    ([entryPath, basename]) => {
      if ((basenameCounts.get(basename) ?? 0) === 1) {
        return basename;
      }

      return `${entryPath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
    },
  );
}

export function sanitizeChunkName(outputName: string) {
  return outputName.replace(/\.js$/, "").replace(/[^\w-]/g, "-");
}

export function toBuildEntry(
  entry: {
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourceRelativePath: string;
  },
  sourceRoot: string,
): BuildEntry {
  return {
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: path.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath,
  };
}

export function toShimFiles(
  entryFiles: BuildEntry[],
  shimDir: string,
): string[] {
  return entryFiles.map((entry) => path.join(shimDir, `${entry.chunkName}.ts`));
}
