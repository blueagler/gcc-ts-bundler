import fs from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists } from "../../shared/cache-store";
import type {
  GccRuntimeManifest,
  MaterializedGraph,
  NormalizedOutputOptions,
  OutputChunk,
  ViteChunkOutputType,
} from "../internal-types";
import { buildChunkModuleIdLookup } from "../chunk-modules";
import { joinPublicPath, stripPublicPathPrefix } from "../output";
import { parseGccRuntimeManifest } from "../../build/closure/runtime-manifest/parse";
import type { BaseOutputSeed, DeferredChunkSeed } from "./helpers";
import {
  applyFileRenames,
  createFallbackChunkInfo,
  deriveBaseOutputSeed,
  ensureUniqueJsFileName,
  findPreferredRollupChunkSeed,
  hashText,
  isRuntimeModuleSourceMap,
  mapOutputFiles,
  patchRuntimeChunkUrls,
  renderPatternFileName,
  writeManifest,
} from "./helpers";

interface RenamedNonBaseOutputs {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
}

export async function renameCompiledNonBaseJsOutputs(input: {
  baseChunkName: string;
  chunkOutputType: ViteChunkOutputType;
  dynamicRootModuleIds: string[];
  jsChunks: OutputChunk[];
  manifestFilePath: string;
  materialized: MaterializedGraph;
  outDir: string;
  outputFiles: string[];
  outputOptions: NormalizedOutputOptions;
  publicPath: string;
  runtimeModuleSourceMapFilePath: string;
}) {
  const deferNaming = input.chunkOutputType === "esm";
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const baseChunkId = manifest.baseChunk;
  const baseChunk = manifest.chunks[baseChunkId];
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not find the base runtime chunk.");
  }

  const runtimeModuleSourceMap = await readJsonIfExists(
    input.runtimeModuleSourceMapFilePath,
    isRuntimeModuleSourceMap,
  );
  const chunkModuleIds = buildChunkModuleIdLookup({
    jsChunks: input.jsChunks,
    manifest,
    materialized: input.materialized,
    runtimeModuleSourceMap: runtimeModuleSourceMap ?? {},
  });
  const dynamicRootModuleIds = new Set(input.dynamicRootModuleIds);
  const deferredChunkSeeds: DeferredChunkSeed[] = [];
  const renameMap = new Map<string, string>();
  const reservedNames = new Set<string>([
    stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
  ]);
  const outputFilesByRelativePath = new Map(
    input.outputFiles.map((filePath) => [
      path.relative(input.outDir, filePath).replace(/\\/g, "/"),
      filePath,
    ]),
  );

  const nonBaseChunks = Object.entries(manifest.chunks)
    .filter(([chunkId]) => chunkId !== baseChunkId)
    .map(([chunkId, chunk]) => ({
      chunk,
      chunkId,
      oldFileName: stripPublicPathPrefix(chunk.url, manifest.publicPath),
      sourceModuleIds: chunkModuleIds.get(chunkId) ?? new Set<string>(),
    }))
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));

  for (const chunk of nonBaseChunks) {
    const currentFilePath = outputFilesByRelativePath.get(chunk.oldFileName);
    if (!currentFilePath) {
      throw new Error(
        `gccTsBundler() could not locate compiled chunk ${chunk.oldFileName}.`,
      );
    }
    const sourceText = await fs.readFile(currentFilePath, "utf8");
    // The plan mirrors Rollup's chunk graph, so every compiled chunk has one
    // Rollup chunk with the same modules and the overlap seed is exact.
    const preferredSeed = findPreferredRollupChunkSeed({
      chunkModuleIds: chunk.sourceModuleIds,
      dynamicRootModuleIds,
      jsChunks: input.jsChunks,
    });
    const renderableInfo =
      preferredSeed?.info ??
      createFallbackChunkInfo({
        chunkId: chunk.chunkId,
        dynamicRootModuleIds,
        moduleIds: chunk.sourceModuleIds,
      });
    if (deferNaming) {
      deferredChunkSeeds.push({
        chunkId: chunk.chunkId,
        info: renderableInfo,
        preferredName: preferredSeed?.preferredName ?? null,
      });
      continue;
    }
    const contentHash = hashText(sourceText);
    const renderedFileName = ensureUniqueJsFileName(
      preferredSeed?.preferredName ??
        renderPatternFileName(
          input.outputOptions.chunkFileNames,
          renderableInfo,
          contentHash,
          input.outputOptions.format,
        ),
      contentHash,
      reservedNames,
    );
    reservedNames.add(renderedFileName);
    renameMap.set(chunk.oldFileName, renderedFileName);
  }

  if (renameMap.size > 0) {
    const baseChunkFilePath = path.join(
      input.outDir,
      stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
    );
    const baseChunkSource = await fs.readFile(baseChunkFilePath, "utf8");
    const patchedBaseChunk = patchRuntimeChunkUrls(baseChunkSource, renameMap);
    await fs.writeFile(baseChunkFilePath, patchedBaseChunk, "utf8");
  }

  for (const [chunkId, chunk] of Object.entries(manifest.chunks)) {
    if (chunkId === baseChunkId) {
      continue;
    }
    const oldFileName = stripPublicPathPrefix(chunk.url, manifest.publicPath);
    const renamedFileName = renameMap.get(oldFileName);
    if (renamedFileName) {
      chunk.url = joinPublicPath(input.publicPath, renamedFileName);
    }
  }
  await writeManifest(input.manifestFilePath, manifest);

  const renamedOutputFiles = mapOutputFiles(
    input.outputFiles,
    input.outDir,
    renameMap,
  );
  await applyFileRenames(input.outDir, renameMap);

  return {
    baseChunkFilePath: path.join(
      input.outDir,
      stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
    ),
    baseSeed: deriveBaseOutputSeed({
      baseChunkName: input.baseChunkName,
      entryModuleIds: [...(chunkModuleIds.get(baseChunkId)?.values() ?? [])],
      jsChunks: input.jsChunks,
    }),
    deferredChunkSeeds,
    emittedOutputFiles: renamedOutputFiles,
    manifest,
    manifestFilePath: input.manifestFilePath,
  } satisfies RenamedNonBaseOutputs;
}
