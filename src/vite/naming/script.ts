import fs from "node:fs/promises";

import type { NormalizedOutputOptions } from "../internal-types";
import { joinPublicPath, stripPublicPathPrefix } from "../output";
import { parseGccRuntimeManifest } from "../../build/closure/runtime-manifest";
import type { BaseOutputSeed } from "./helpers";
import {
  applyFileRenames,
  ensureUniqueJsFileName,
  hashText,
  mapOutputFiles,
  renderPatternFileName,
  writeManifest,
} from "./helpers";

export async function finalizeScriptChunkNames(input: {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  emittedOutputFiles: string[];
  manifestFilePath: string;
  outputOptions: NormalizedOutputOptions;
  outDir: string;
  publicPath: string;
}) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const baseChunk = manifest.chunks[manifest.baseChunk];
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not resolve the base runtime chunk.");
  }
  const sourceText = await fs.readFile(input.baseChunkFilePath, "utf8");
  const currentBaseFileName = stripPublicPathPrefix(
    baseChunk.url,
    manifest.publicPath,
  );
  const reservedNames = new Set(
    Object.values(manifest.chunks)
      .filter((chunk) => chunk !== baseChunk)
      .map((chunk) => stripPublicPathPrefix(chunk.url, manifest.publicPath)),
  );
  const contentHash = hashText(sourceText);
  const finalBaseFileName = ensureUniqueJsFileName(
    input.baseSeed.preferredName ??
      renderPatternFileName(
        input.outputOptions.entryFileNames,
        input.baseSeed.info,
        contentHash,
        input.outputOptions.format,
      ),
    contentHash,
    reservedNames,
  );
  if (finalBaseFileName === currentBaseFileName) {
    return {
      baseScriptFileName: finalBaseFileName,
      emittedOutputFiles: input.emittedOutputFiles,
    };
  }

  const renameMap = new Map([[currentBaseFileName, finalBaseFileName]]);
  await applyFileRenames(input.outDir, renameMap);
  baseChunk.url = joinPublicPath(input.publicPath, finalBaseFileName);
  await writeManifest(input.manifestFilePath, manifest);

  return {
    baseScriptFileName: finalBaseFileName,
    emittedOutputFiles: mapOutputFiles(
      input.emittedOutputFiles,
      input.outDir,
      renameMap,
    ),
  };
}
