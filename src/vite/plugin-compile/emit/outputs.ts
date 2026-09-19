import type { OutputBundle, PluginContext } from "../../internal-types";
import { preserveCompiledChunkIdentities } from "../../naming";
import { logOutputStats } from "../../output";
import type { ViteTimingTotals } from "../../plugin-graph";
import type { CompiledViteGraph } from "../compile";
import { measureAsync } from "../measure";
import type { CompiledEmitRenames } from "./rename";

function filterInternalOutputs(
  outputFiles: string[],
  compiled: CompiledViteGraph,
) {
  return outputFiles.filter(
    (filePath) =>
      filePath !== compiled.runtimeModuleSourceMapFilePath &&
      (!compiled.manifestSettings.isInternal ||
        filePath !== compiled.manifestFilePath),
  );
}

export async function finalizeCompiledEmit(
  pluginContext: PluginContext,
  input: {
    bundle: OutputBundle;
    compiled: CompiledViteGraph;
    timingTotals: ViteTimingTotals;
  },
  finalizedBaseOutput: { emittedOutputFiles: string[] },
  runtime: Pick<CompiledEmitRenames, "manifest" | "chunkModuleIds">,
) {
  const { compiled } = input;
  const emittedOutputFiles = filterInternalOutputs(
    finalizedBaseOutput.emittedOutputFiles,
    compiled,
  );
  const identityOutputs = await measureAsync(
    input.timingTotals,
    "emitOutputsMs",
    async () =>
      preserveCompiledChunkIdentities({
        bundle: input.bundle,
        chunkModuleIds: runtime.chunkModuleIds,
        jsChunks: compiled.jsChunks,
        manifest: runtime.manifest,
        manifestFilePath: compiled.manifestFilePath,
        outDir: compiled.compiledCoreOutputs.finalOutDir,
        outputFiles: emittedOutputFiles,
        pluginContext,
        publicPath: compiled.publicPath,
      }),
  );
  await logOutputStats({
    bundle: input.bundle,
    emittedOutputFiles: identityOutputs.finalOutputFiles,
    finalOutDir: compiled.compiledCoreOutputs.finalOutDir,
    finalScriptFileName: identityOutputs.baseScriptFileName,
  });
  return { finalOutputFiles: identityOutputs.finalOutputFiles };
}
