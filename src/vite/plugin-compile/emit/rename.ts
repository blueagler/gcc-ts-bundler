import fs from "node:fs/promises";

import { parseGccRuntimeManifest } from "../../../build/closure/runtime-manifest/parse";
import { logInternalDetail } from "../../../shared/timing";
import { resolveBaseChunkName } from "../../config";
import { augmentCompiledViteCss } from "../../css";
import type { NormalizedOutputOptions } from "../../internal-types";
import type { BaseOutputSeed, DeferredChunkSeed } from "../../naming/helpers";
import { renameCompiledNonBaseJsOutputs } from "../../naming";
import type { ViteTimingTotals } from "../../plugin-graph";
import type { GccTsBundlerVitePluginOptions } from "../../types";
import type { CompiledViteGraph } from "../compile";
import { measureAsync } from "../measure";

export interface CompiledEmitRenameInput {
  compiled: CompiledViteGraph;
  options: GccTsBundlerVitePluginOptions;
  outputOptions: NormalizedOutputOptions;
}

export interface CompiledEmitRenames {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
}

export function compiledRenameInput(
  input: CompiledEmitRenameInput,
  outputFiles: string[],
) {
  const { compiled } = input;
  return {
    baseChunkName: resolveBaseChunkName(input.options),
    chunkOutputType: compiled.chunkOutputType,
    dynamicRootModuleIds: compiled.dynamicRootModuleIds,
    jsChunks: compiled.jsChunks,
    manifestFilePath: compiled.manifestFilePath,
    materialized: compiled.materialized,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles,
    outputOptions: input.outputOptions,
    publicPath: compiled.publicPath,
    runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
  };
}

export async function renameCompiledEmitOutputs(
  input: CompiledEmitRenameInput & { timingTotals: ViteTimingTotals },
): Promise<CompiledEmitRenames> {
  const { compiled } = input;
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(compiled.manifestFilePath, "utf8"),
    compiled.manifestFilePath,
  );
  logInternalDetail(
    "vite:gcc-runtime-modules",
    `${Object.keys(manifest.modules).length}`,
  );
  const renamedNonBaseOutputs = await renameCompiledNonBaseJsOutputs(
    compiledRenameInput(input, compiled.compiledCoreOutputs.outputFiles),
  );
  if (compiled.cssOwnership.enabled) {
    await measureAsync(input.timingTotals, "cssAugmentMs", () =>
      augmentCompiledViteCss({
        baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
        manifestFilePath: compiled.manifestFilePath,
        materialized: compiled.materialized,
        ownership: compiled.cssOwnership,
        runtimeModuleSourceMapFilePath: compiled.runtimeModuleSourceMapFilePath,
      }),
    );
  }
  return renamedNonBaseOutputs;
}
