import path from "node:path";

import type { RollupChunkInput } from "../build/types";
import type { MaterializedGraph, OutputChunk } from "./internal-types";

/**
 * Serializes the host bundler's final chunk layout for the native planner.
 *
 * Rollup has already split this graph, and that split ships today; mirroring it
 * lets Closure optimize inside those boundaries instead of re-deriving its own
 * from the flat dependency graph, which collapses an app into one eager chunk.
 * This side only joins identities: Rollup module ids to the materialized files
 * the compiler will actually read. Modules with no materialized file (CSS,
 * assets, anything Rollup rendered but the capture dropped) are simply absent,
 * and materialized files no Rollup chunk claims (prebundle atoms, dependency
 * bundles, the virtual runtime) are placed by the planner, which is the side
 * that owns the chunk DAG.
 */
export function serializeRollupChunkGraph(input: {
  jsChunks: readonly OutputChunk[];
  materialized: MaterializedGraph;
}): RollupChunkInput[] {
  const filesBySourceModuleId = new Map<string, string[]>();
  for (const module of input.materialized.modules) {
    const relativePath = path
      .relative(input.materialized.srcDir, module.filePath)
      .replace(/\\/g, "/");
    for (const sourceModuleId of module.sourceModuleIds) {
      const files = filesBySourceModuleId.get(sourceModuleId);
      if (files) {
        files.push(relativePath);
        continue;
      }
      filesBySourceModuleId.set(sourceModuleId, [relativePath]);
    }
  }

  const chunkFileNames = new Set(input.jsChunks.map((chunk) => chunk.fileName));
  const sorted = (values: Iterable<string>) =>
    [...new Set(values)].sort((left, right) => left.localeCompare(right));
  return input.jsChunks.map((chunk) => ({
    dynamicImportedChunkFileNames: sorted(
      chunk.dynamicImports.filter((fileName) => chunkFileNames.has(fileName)),
    ),
    fileName: chunk.fileName,
    importedChunkFileNames: sorted(
      chunk.imports.filter((fileName) => chunkFileNames.has(fileName)),
    ),
    isEntry: chunk.isEntry,
    moduleFiles: sorted(
      Object.keys(chunk.modules).flatMap(
        (moduleId) => filesBySourceModuleId.get(moduleId) ?? [],
      ),
    ),
    name: chunk.name,
  }));
}
