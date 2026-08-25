import fs from "node:fs/promises";
import path from "node:path";

import type { NormalizedOutputOptions } from "../internal-types";
import { joinPublicPath } from "../output";
import type { EsmNamedChunk } from "./esm-chunks";
import type { BaseOutputSeed, DeferredChunkSeed } from "./helpers";
import {
  createFallbackChunkInfo,
  ensureUniqueJsFileName,
  relativeSpecifier,
  renderPatternFileName,
} from "./helpers";

export function assignEsmRenameMap(input: {
  baseChunk: EsmNamedChunk;
  baseChunkId: string;
  baseSeed: BaseOutputSeed;
  chunks: EsmNamedChunk[];
  deferredChunkSeeds: DeferredChunkSeed[];
  finalHashByChunkId: Map<string, string>;
  outputOptions: NormalizedOutputOptions;
}) {
  const seedByChunkId = new Map(
    input.deferredChunkSeeds.map((seed) => [seed.chunkId, seed]),
  );
  const reservedNames = new Set<string>();
  const renameMap = new Map<string, string>();
  // The base chunk is named first so that its entryFileNames pattern wins any
  // collision against a lazy chunk that renders to the same name.
  for (const chunk of [
    input.baseChunk,
    ...input.chunks.filter(
      (candidate) => candidate.chunkId !== input.baseChunkId,
    ),
  ]) {
    const isBase = chunk.chunkId === input.baseChunkId;
    const seed = seedByChunkId.get(chunk.chunkId);
    const chunkHash = input.finalHashByChunkId.get(chunk.chunkId) ?? "";
    const info =
      (isBase ? input.baseSeed.info : seed?.info) ??
      createFallbackChunkInfo({
        chunkId: chunk.chunkId,
        dynamicRootModuleIds: new Set<string>(),
        moduleIds: new Set<string>(),
      });
    const preferredName = isBase
      ? input.baseSeed.preferredName
      : (seed?.preferredName ?? null);
    const renderedFileName = ensureUniqueJsFileName(
      preferredName ??
        renderPatternFileName(
          isBase
            ? input.outputOptions.entryFileNames
            : input.outputOptions.chunkFileNames,
          info,
          chunkHash,
          input.outputOptions.format,
        ),
      chunkHash,
      reservedNames,
    );
    reservedNames.add(renderedFileName);
    renameMap.set(chunk.oldFileName, renderedFileName);
  }
  return renameMap;
}

export async function rewriteEsmChunkContents(input: {
  chunks: EsmNamedChunk[];
  outDir: string;
  publicPath: string;
  renameMap: Map<string, string>;
  tokenByChunkId: Map<string, string>;
  tokenisedByChunkId: Map<string, string>;
}) {
  for (const chunk of input.chunks) {
    let contents = input.tokenisedByChunkId.get(chunk.chunkId) ?? "";
    const importerFileName =
      input.renameMap.get(chunk.oldFileName) ?? chunk.oldFileName;
    for (const other of input.chunks) {
      // Specifiers resolve from the importing module after both chunks move.
      const target =
        input.renameMap.get(other.oldFileName) ?? other.oldFileName;
      contents = contents
        .split(input.tokenByChunkId.get(other.chunkId) ?? "")
        .join(relativeSpecifier(importerFileName, target));
    }
    await fs.writeFile(
      path.join(input.outDir, chunk.oldFileName),
      contents,
      "utf8",
    );
    const renamedFileName = input.renameMap.get(chunk.oldFileName);
    if (renamedFileName) {
      chunk.chunk.url = joinPublicPath(input.publicPath, renamedFileName);
    }
  }
}
