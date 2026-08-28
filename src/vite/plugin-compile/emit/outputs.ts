import fs from "node:fs/promises";

import { parseGccRuntimeManifest } from "../../../build/closure/runtime-manifest/parse";
import type { OutputBundle, PluginContext } from "../../internal-types";
import { preserveCompiledChunkIdentities } from "../../naming";
import { logOutputStats } from "../../output";
import type { ViteTimingTotals } from "../../plugin-graph";
import type { CompiledViteGraph } from "../compile";
import { measureAsync } from "../measure";

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
        jsChunks: compiled.jsChunks,
        manifest: parseGccRuntimeManifest(
          await fs.readFile(compiled.manifestFilePath, "utf8"),
          compiled.manifestFilePath,
        ),
        manifestFilePath: compiled.manifestFilePath,
        materialized: compiled.materialized,
        outDir: compiled.compiledCoreOutputs.finalOutDir,
        outputFiles: emittedOutputFiles,
        pluginContext,
        publicPath: compiled.publicPath,
        runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
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
