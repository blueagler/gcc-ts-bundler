import fs from "node:fs/promises";
import path from "node:path";

import type {
  GccRuntimeManifest,
  OutputBundle,
  OutputChunk,
  PluginContext,
} from "../internal-types";
import { stripPublicPathPrefix } from "../output";
import { countOverlap, relativeSpecifier, writeManifest } from "./helpers";
import {
  applyChunkMetadata,
  rewriteAndRenameCompiledFiles,
} from "./identities-rewrite";

export async function preserveCompiledChunkIdentities(input: {
  bundle: OutputBundle;
  chunkModuleIds: Map<string, Set<string>>;
  jsChunks: OutputChunk[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
  outDir: string;
  outputFiles: string[];
  pluginContext: PluginContext;
  publicPath: string;
}) {
  const compiledChunks = Object.entries(input.manifest.chunks).map(
    ([chunkId, chunk]) => ({
      chunkId,
      fileName: stripPublicPathPrefix(chunk.url, input.publicPath),
      moduleIds: input.chunkModuleIds.get(chunkId) ?? new Set<string>(),
    }),
  );
  const base =
    compiledChunks.find(
      (chunk) => chunk.chunkId === input.manifest.baseChunk,
    ) ?? compiledChunks[0];
  if (!base) {
    throw new Error("gccTsBundler() emitted no runtime chunks.");
  }

  const targetByRollupChunk = new Map<
    OutputChunk,
    (typeof compiledChunks)[number]
  >();
  for (const chunk of input.jsChunks) {
    let target = chunk.isEntry ? base : undefined;
    if (!target && chunk.facadeModuleId) {
      target = compiledChunks.find((candidate) =>
        candidate.moduleIds.has(chunk.facadeModuleId ?? ""),
      );
    }
    target ??= [...compiledChunks].sort(
      (left, right) =>
        countOverlap(right.moduleIds, new Set(Object.keys(chunk.modules))) -
        countOverlap(left.moduleIds, new Set(Object.keys(chunk.modules))),
    )[0];
    targetByRollupChunk.set(chunk, target ?? base);
  }

  const rollupChunksByTarget = new Map<string, OutputChunk[]>();
  for (const [chunk, target] of targetByRollupChunk) {
    const chunks = rollupChunksByTarget.get(target.chunkId) ?? [];
    chunks.push(chunk);
    rollupChunksByTarget.set(target.chunkId, chunks);
  }
  const ownerByTarget = new Map<string, OutputChunk>();
  for (const target of compiledChunks) {
    const candidates = rollupChunksByTarget.get(target.chunkId) ?? [];
    const owner = candidates.sort((left, right) => {
      if (left.isEntry !== right.isEntry) return left.isEntry ? -1 : 1;
      if (left.isDynamicEntry !== right.isDynamicEntry) {
        return left.isDynamicEntry ? -1 : 1;
      }
      return (
        countOverlap(target.moduleIds, new Set(Object.keys(right.modules))) -
        countOverlap(target.moduleIds, new Set(Object.keys(left.modules)))
      );
    })[0];
    if (owner) ownerByTarget.set(target.chunkId, owner);
  }

  const renameMap = new Map<string, string>();
  for (const target of compiledChunks) {
    const owner = ownerByTarget.get(target.chunkId);
    if (owner) renameMap.set(target.fileName, owner.fileName);
  }
  await rewriteAndRenameCompiledFiles(
    input.outDir,
    input.outputFiles,
    renameMap,
  );
  for (const target of compiledChunks) {
    const renamed = renameMap.get(target.fileName);
    const manifestChunk = input.manifest.chunks[target.chunkId];
    if (renamed && manifestChunk) {
      manifestChunk.url = `${input.publicPath}${renamed}`;
    }
  }
  await writeManifest(input.manifestFilePath, input.manifest);

  const claimedFiles = new Set(renameMap.values());
  for (const [chunk, target] of targetByRollupChunk) {
    const owner = ownerByTarget.get(target.chunkId);
    if (!owner) continue;
    if (chunk === owner) {
      chunk.code = await fs.readFile(
        path.join(input.outDir, owner.fileName),
        "utf8",
      );
      applyChunkMetadata(chunk);
      continue;
    }
    const specifier = relativeSpecifier(chunk.fileName, owner.fileName);
    chunk.code = `export * from ${JSON.stringify(specifier)};\n`;
    chunk.imports = [owner.fileName];
    chunk.dynamicImports = [];
  }

  const emittedPrivateFiles: string[] = [];
  for (const outputFile of input.outputFiles) {
    const oldFileName = path
      .relative(input.outDir, outputFile)
      .replace(/\\/g, "/");
    const fileName = renameMap.get(oldFileName) ?? oldFileName;
    if (claimedFiles.has(fileName)) continue;
    const filePath = path.join(input.outDir, fileName);
    const source = await fs.readFile(filePath);
    input.pluginContext.emitFile({ fileName, source, type: "asset" });
    emittedPrivateFiles.push(filePath);
  }
  const finalOutputFiles = input.outputFiles.map((outputFile) => {
    const oldFileName = path
      .relative(input.outDir, outputFile)
      .replace(/\\/g, "/");
    return path.join(input.outDir, renameMap.get(oldFileName) ?? oldFileName);
  });
  return {
    baseScriptFileName:
      ownerByTarget.get(input.manifest.baseChunk)?.fileName ?? base.fileName,
    emittedPrivateFiles,
    finalOutputFiles,
  };
}
