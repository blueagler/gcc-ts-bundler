import type {
  GccRuntimeManifest,
  NormalizedOutputOptions,
} from "../internal-types";
import { assignEsmRenameMap, rewriteEsmChunkContents } from "./esm-apply";
import { listEsmChunks, requireBaseEsmChunk } from "./esm-chunks";
import { computeEsmFinalHashes, tokeniseEsmChunks } from "./esm-hash";
import type { BaseOutputSeed, DeferredChunkSeed } from "./helpers";
import { applyFileRenames, mapOutputFiles, writeManifest } from "./helpers";

/**
 * ES module output embeds chunk file names in two directions at once: every
 * lazy chunk carries `import ... from "./<base>.js"`, and the base chunk
 * carries the lazy chunk names in the runtime manifest. Hashing either side
 * changes the other, so content hashes cannot be taken over the shipped bytes.
 *
 * This is Rollup's placeholder scheme: every chunk reference is replaced with
 * a stable token, each chunk is hashed over that tokenised text, and a chunk's
 * final hash additionally folds in the tokenised hashes of every chunk it can
 * reach. Cycles are fine because the folded-in hashes are themselves
 * cycle-free, and a change anywhere in a chunk's reference closure still
 * changes its name.
 */
export async function finalizeEsmChunkNames(input: {
  baseSeed: BaseOutputSeed;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
  outDir: string;
  outputOptions: NormalizedOutputOptions;
  publicPath: string;
}) {
  const { manifest } = input;
  const chunks = listEsmChunks(manifest);
  const baseChunk = requireBaseEsmChunk(chunks, manifest.baseChunk);
  const { referencesByChunkId, tokenByChunkId, tokenisedByChunkId } =
    await tokeniseEsmChunks({
      chunks,
      outDir: input.outDir,
    });
  const finalHashByChunkId = computeEsmFinalHashes(
    chunks,
    tokenisedByChunkId,
    referencesByChunkId,
  );
  const renameMap = assignEsmRenameMap({
    baseChunk,
    baseChunkId: manifest.baseChunk,
    baseSeed: input.baseSeed,
    chunks,
    deferredChunkSeeds: input.deferredChunkSeeds,
    finalHashByChunkId,
    outputOptions: input.outputOptions,
  });
  await rewriteEsmChunkContents({
    chunks,
    outDir: input.outDir,
    publicPath: input.publicPath,
    renameMap,
    tokenByChunkId,
    tokenisedByChunkId,
  });
  await writeManifest(input.manifestFilePath, manifest);

  const emittedOutputFiles = mapOutputFiles(
    input.emittedOutputFiles,
    input.outDir,
    renameMap,
  );
  await applyFileRenames(input.outDir, renameMap);

  return {
    baseScriptFileName:
      renameMap.get(baseChunk.oldFileName) ?? baseChunk.oldFileName,
    emittedOutputFiles,
  };
}
