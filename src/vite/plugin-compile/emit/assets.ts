import type { ResolvedConfig } from "vite";

import type {
  NormalizedOutputOptions,
  PluginContext,
} from "../../internal-types";
import {
  finalizeBaseJsOutputName,
  renameCompiledNonBaseJsOutputs,
} from "../../naming";
import { resolveViteAssetUrls } from "../../output";
import type { CompiledViteGraph } from "../compile";
import {
  compiledRenameInput,
  type CompiledEmitRenameInput,
  type CompiledEmitRenames,
} from "./rename";

function finalizeBaseFromRename(
  compiled: CompiledViteGraph,
  renamed: CompiledEmitRenames,
  outputOptions: NormalizedOutputOptions,
) {
  return finalizeBaseJsOutputName({
    baseChunkFilePath: renamed.baseChunkFilePath,
    baseSeed: renamed.baseSeed,
    chunkOutputType: compiled.chunkOutputType,
    deferredChunkSeeds: renamed.deferredChunkSeeds,
    emittedOutputFiles: renamed.emittedOutputFiles,
    manifestFilePath: compiled.manifestFilePath,
    outputOptions,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    publicPath: compiled.publicPath,
  });
}

export async function resolveCompiledEmitAssets(
  pluginContext: PluginContext,
  input: CompiledEmitRenameInput & { config: ResolvedConfig },
  renamedNonBaseOutputs: CompiledEmitRenames,
) {
  const { compiled } = input;
  // Vite resolves relative asset URLs against the host chunk's shipped path.
  // Name once to establish that path, render the URLs, then hash/name again
  // over the resolved bytes so asset changes invalidate the JavaScript name.
  const preliminaryBaseOutput = await finalizeBaseFromRename(
    compiled,
    renamedNonBaseOutputs,
    input.outputOptions,
  );
  const resolvedAssetUrls = await resolveViteAssetUrls({
    chunkOutputType: compiled.chunkOutputType,
    config: input.config,
    jsChunks: compiled.jsChunks,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles: preliminaryBaseOutput.emittedOutputFiles,
    outputOptions: input.outputOptions,
    pluginContext,
  });
  if (!resolvedAssetUrls) {
    return preliminaryBaseOutput;
  }
  const finalRenamedOutputs = await renameCompiledNonBaseJsOutputs(
    compiledRenameInput(input, preliminaryBaseOutput.emittedOutputFiles),
  );
  return finalizeBaseFromRename(
    compiled,
    finalRenamedOutputs,
    input.outputOptions,
  );
}
