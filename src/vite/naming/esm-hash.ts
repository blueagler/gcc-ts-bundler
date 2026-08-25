import fs from "node:fs/promises";
import path from "node:path";

import type { EsmNamedChunk } from "./esm-chunks";
import {
  chunkNameToken,
  collectReferenceClosure,
  replaceChunkSpecifier,
} from "./esm-tokens";
import { hashText, relativeSpecifier } from "./helpers";

export async function tokeniseEsmChunks(input: {
  chunks: EsmNamedChunk[];
  outDir: string;
}) {
  const tokenByChunkId = new Map(
    input.chunks.map((chunk, index) => [chunk.chunkId, chunkNameToken(index)]),
  );
  const tokenisedByChunkId = new Map<string, string>();
  const referencesByChunkId = new Map<string, Set<string>>();
  for (const chunk of input.chunks) {
    const sourceText = await fs.readFile(
      path.join(input.outDir, chunk.oldFileName),
      "utf8",
    );
    const references = new Set<string>();
    let tokenised = sourceText;
    for (const other of input.chunks) {
      const token = tokenByChunkId.get(other.chunkId) ?? "";
      for (const alias of other.aliases) {
        for (const specifier of [
          alias,
          alias.startsWith(".") ? alias : `./${alias}`,
          relativeSpecifier(chunk.oldFileName, alias),
        ]) {
          const replaced = replaceChunkSpecifier(tokenised, specifier, token);
          if (replaced !== tokenised) {
            references.add(other.chunkId);
            tokenised = replaced;
          }
        }
      }
    }
    tokenisedByChunkId.set(chunk.chunkId, tokenised);
    referencesByChunkId.set(chunk.chunkId, references);
  }
  return { referencesByChunkId, tokenByChunkId, tokenisedByChunkId };
}

export function computeEsmFinalHashes(
  chunks: EsmNamedChunk[],
  tokenisedByChunkId: Map<string, string>,
  referencesByChunkId: Map<string, Set<string>>,
) {
  return new Map(
    chunks.map((chunk) => [
      chunk.chunkId,
      hashText(
        [
          tokenisedByChunkId.get(chunk.chunkId) ?? "",
          ...[
            ...collectReferenceClosure(chunk.chunkId, referencesByChunkId),
          ].map((referencedId) =>
            hashText(tokenisedByChunkId.get(referencedId) ?? ""),
          ),
        ].join("\u0000"),
      ),
    ]),
  );
}
