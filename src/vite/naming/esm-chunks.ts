import type {
  GccRuntimeManifest,
  GccRuntimeManifestChunk,
} from "../internal-types";
import { stripPublicPathPrefix } from "../output";

export interface EsmNamedChunk {
  aliases: string[];
  chunkId: string;
  chunk: GccRuntimeManifestChunk;
  oldFileName: string;
}

export function listEsmChunks(manifest: GccRuntimeManifest) {
  return Object.entries(manifest.chunks)
    .map(([chunkId, chunk]) => {
      const oldFileName = stripPublicPathPrefix(chunk.url, manifest.publicPath);
      return {
        // Closure names its outputs after the chunk id and the base chunk is
        // renamed on the way out of the compiler, so sibling chunks can still
        // import it under `./<chunkId>.js`. Both spellings resolve here.
        aliases: [...new Set([oldFileName, `${chunkId}.js`])],
        chunkId,
        chunk,
        oldFileName,
      };
    })
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
}

export function requireBaseEsmChunk(
  chunks: EsmNamedChunk[],
  baseChunkId: string,
) {
  const baseChunk = chunks.find((chunk) => chunk.chunkId === baseChunkId);
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not resolve the base runtime chunk.");
  }
  return baseChunk;
}
