import fs from "node:fs/promises";

import { finalizeJavaScriptOutputs } from "../../../build/closure/final-minify";
import { parseGccRuntimeManifest } from "../../../build/closure/runtime-manifest";
import type { OutputBundle, PluginContext } from "../../internal-types";
import { preserveCompiledChunkIdentities } from "../../naming";
import { logOutputStats, rewritePreservedImportSpecifiers } from "../../output";
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
  await rewritePreservedImportSpecifiers({
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles: finalizedBaseOutput.emittedOutputFiles,
  });
  await finalizeJavaScriptOutputs({
    outputFiles: finalizedBaseOutput.emittedOutputFiles,
  });
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
}
