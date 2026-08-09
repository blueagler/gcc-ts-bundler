import type {
  GccRuntimeManifest,
  MaterializedGraph,
  OutputChunk,
} from "./internal-types";

/**
 * Maps each compiled chunk back to the host module ids it carries.
 *
 * Three identities have to be joined: the runtime module id Closure emitted,
 * the materialized file it was compiled from, and the Rollup module ids that
 * file was captured from. The middle one is the awkward step - the compiler
 * reads the materialized tree through a symlink inside the build workspace, so
 * the recorded source path and the captured file path name the same file with
 * different strings. Matching on the relative-path suffix is what closes that
 * gap; without it every chunk looks empty and every Rollup chunk collapses onto
 * whichever compiled chunk happens to be first.
 */
export function buildChunkModuleIdLookup(input: {
  jsChunks: readonly OutputChunk[];
  manifest: GccRuntimeManifest;
  materialized: MaterializedGraph;
  runtimeModuleSourceMap: Record<string, string>;
}) {
  const normalizedMaterializedByFilePath = new Map<string, string[]>();
  const normalizedMaterializedByRelativePath = new Map<string, string[]>();
  for (const module of input.materialized.modules) {
    normalizedMaterializedByFilePath.set(normalizePath(module.filePath), [
      ...module.sourceModuleIds,
    ]);
    normalizedMaterializedByRelativePath.set(
      normalizePath(module.relativePath),
      [...module.sourceModuleIds],
    );
  }

  const runtimeModuleIdToOriginalIds = new Map<string, string[]>();
  for (const [runtimeModuleId, sourceFilePath] of Object.entries(
    input.runtimeModuleSourceMap,
  )) {
    const normalizedSourceFilePath = normalizePath(sourceFilePath);
    const matchedOriginalIds =
      normalizedMaterializedByFilePath.get(normalizedSourceFilePath) ??
      findModuleIdByRelativeSuffix(
        normalizedSourceFilePath,
        normalizedMaterializedByRelativePath,
      );
    if (matchedOriginalIds) {
      runtimeModuleIdToOriginalIds.set(runtimeModuleId, [
        ...matchedOriginalIds,
      ]);
    }
  }

  const chunkModuleIds = new Map<string, Set<string>>();
  for (const [chunkId, chunk] of Object.entries(input.manifest.chunks)) {
    const moduleIds = new Set<string>();
    for (const runtimeModuleId of chunk.modules) {
      const originalIds = runtimeModuleIdToOriginalIds.get(runtimeModuleId);
      if (!originalIds) {
        continue;
      }
      for (const originalId of originalIds) {
        moduleIds.add(originalId);
      }
    }
    chunkModuleIds.set(chunkId, moduleIds);
  }

  const entryChunk = input.jsChunks.find((chunk) => chunk.isEntry);
  if (entryChunk && chunkModuleIds.get(input.manifest.baseChunk)?.size === 0) {
    chunkModuleIds.set(
      input.manifest.baseChunk,
      new Set(Object.keys(entryChunk.modules)),
    );
  }

  return chunkModuleIds;
}

function findModuleIdByRelativeSuffix(
  sourceFilePath: string,
  moduleIdByRelativePath: Map<string, string[]>,
) {
  for (const [relativePath, moduleIds] of moduleIdByRelativePath.entries()) {
    if (
      sourceFilePath === relativePath ||
      sourceFilePath.endsWith(`/${relativePath}`)
    ) {
      return moduleIds;
    }
  }
  return undefined;
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}
