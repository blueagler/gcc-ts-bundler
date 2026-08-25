import path from "node:path";

import { firstOrUndefined } from "../../shared/arrays";
import type { OutputChunk } from "../internal-types";
import type { RenderableChunkInfo } from "./render";
import { sanitizeName } from "./sanitize";

export interface BaseOutputSeed {
  info: RenderableChunkInfo;
  preferredName: string | null;
}

/**
 * A non-base chunk whose final name has been deferred to the finalize pass.
 * Under ES module output every chunk name is embedded in its siblings, so
 * names cannot be assigned until every chunk's final bytes exist (see
 * `finalizeEsmChunkNames`).
 */
export interface DeferredChunkSeed {
  chunkId: string;
  info: RenderableChunkInfo;
  preferredName: string | null;
}

export function deriveBaseOutputSeed(input: {
  baseChunkName: string;
  entryModuleIds: string[];
  jsChunks: OutputChunk[];
}): BaseOutputSeed {
  const entryChunks = input.jsChunks.filter((chunk) => chunk.isEntry);
  const onlyEntryChunk = firstOrUndefined(entryChunks);
  if (entryChunks.length === 1 && onlyEntryChunk !== undefined) {
    return {
      info: toRenderableChunkInfo(onlyEntryChunk),
      preferredName: null,
    };
  }

  const entryFacadeModuleId = input.entryModuleIds[0];
  const info: RenderableChunkInfo = {
    exports: [],
    isDynamicEntry: false,
    isEntry: true,
    moduleIds: [...input.entryModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    name: sanitizeName(input.baseChunkName),
  };
  if (entryFacadeModuleId !== undefined) {
    info.facadeModuleId = entryFacadeModuleId;
  }
  return {
    info,
    preferredName: null,
  };
}

export function findPreferredRollupChunkSeed(input: {
  chunkModuleIds: Set<string>;
  dynamicRootModuleIds: Set<string>;
  jsChunks: OutputChunk[];
}) {
  const dynamicMatch = input.jsChunks.find(
    (chunk) =>
      chunk.isDynamicEntry &&
      chunk.facadeModuleId &&
      input.chunkModuleIds.has(chunk.facadeModuleId),
  );
  if (dynamicMatch) {
    return {
      info: toRenderableChunkInfo(dynamicMatch),
      preferredName: null,
    };
  }

  const candidates = input.jsChunks
    .map((chunk) => ({
      chunk,
      overlap: countOverlap(
        input.chunkModuleIds,
        new Set(Object.keys(chunk.modules)),
      ),
    }))
    .filter(({ chunk, overlap }) => !chunk.isEntry && overlap > 0)
    .sort((left, right) => {
      if (right.overlap !== left.overlap) {
        return right.overlap - left.overlap;
      }
      if (left.chunk.isDynamicEntry !== right.chunk.isDynamicEntry) {
        return left.chunk.isDynamicEntry ? -1 : 1;
      }
      return left.chunk.name.localeCompare(right.chunk.name);
    });
  const candidate = candidates[0]?.chunk;
  if (!candidate) {
    return null;
  }

  return {
    info: toRenderableChunkInfo(candidate),
    preferredName: null,
  };
}

export function createFallbackChunkInfo(input: {
  chunkId: string;
  dynamicRootModuleIds: Set<string>;
  moduleIds: Set<string>;
}): RenderableChunkInfo {
  const dynamicRoot = [...input.moduleIds]
    .filter((moduleId) => input.dynamicRootModuleIds.has(moduleId))
    .sort((left, right) => left.localeCompare(right))[0];
  const name = dynamicRoot
    ? sanitizeName(path.basename(dynamicRoot).replace(/\.[^/.]+$/u, ""))
    : sanitizeName(`shared-${input.chunkId.slice(0, 8)}`);
  const info: RenderableChunkInfo = {
    exports: [],
    isDynamicEntry: Boolean(dynamicRoot),
    isEntry: false,
    moduleIds: [...input.moduleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    name,
  };
  if (dynamicRoot !== undefined) {
    info.facadeModuleId = dynamicRoot;
  }
  return info;
}

function toRenderableChunkInfo(chunk: OutputChunk): RenderableChunkInfo {
  const info: RenderableChunkInfo = {
    exports: [...chunk.exports],
    isDynamicEntry: chunk.isDynamicEntry,
    isEntry: chunk.isEntry,
    moduleIds: Object.keys(chunk.modules).sort((left, right) =>
      left.localeCompare(right),
    ),
    name: sanitizeName(chunk.name),
  };
  if (chunk.facadeModuleId !== undefined && chunk.facadeModuleId !== null) {
    info.facadeModuleId = chunk.facadeModuleId;
  }
  return info;
}

export function countOverlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}
