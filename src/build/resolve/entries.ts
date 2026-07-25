import path from "path";

import { zipExact } from "../../shared/arrays";
import type { BuildEntry } from "../types";

export function resolveOutputNames(
  entries: Array<{ name: string | null; relativePath: string }>,
): string[] {
  const basenameCounts = new Map<string, number>();
  const basenames = entries.map((entry) =>
    path.basename(entry.relativePath).replace(/\.[^/.]+$/, ".js"),
  );

  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }

  return zipExact(entries, basenames, "entries and basenames").map(
    ([entry, basename]) => {
      if (entry.name !== null) {
        return entry.name;
      }
      if ((basenameCounts.get(basename) ?? 0) === 1) {
        return basename;
      }

      return `${entry.relativePath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
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
