import path from "path";

import { zipExact } from "../../shared/arrays";
import type { BuildEntry } from "../types";
import type { ResolveMetadata } from "./cache";

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

/**
 * `outFile` is a caller-supplied destination, not something the build derives,
 * so a restored entry must never carry a cached value: a snapshot written by a
 * build whose `outFile` lived under a different absolute root would republish
 * the entry to that stale path, leaving the current output tree missing the
 * file. It is therefore passed in from the live options on every path.
 *
 * Positional association with `options.entries` is exact rather than
 * convenient: entry names and source-relative paths are part of
 * `getOptionsSignature`, in order, so a cache hit already proves the entry list
 * and its order are unchanged.
 */
export function toBuildEntry(
  entry: ResolveMetadata["entryFiles"][number],
  sourceRoot: string,
  outFile: string | undefined,
): BuildEntry {
  return {
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    ...(outFile === undefined ? {} : { outFile }),
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
