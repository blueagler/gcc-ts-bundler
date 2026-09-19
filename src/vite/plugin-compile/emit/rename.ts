import fs from "node:fs/promises";

import { parseGccRuntimeManifest } from "../../../build/closure/runtime-manifest/parse";
import { logInternalDetail } from "../../../shared/timing";
import { parseJson } from "../../../shared/validation";
import {
  buildChunkModuleIdLookup,
  buildRuntimeModuleIdMap,
} from "../../chunk-modules";
import { resolveBaseChunkName } from "../../config";
import { augmentCompiledViteCss } from "../../css";
import type {
  GccRuntimeManifest,
  NormalizedOutputOptions,
} from "../../internal-types";
import type { BaseOutputSeed, DeferredChunkSeed } from "../../naming/helpers";
import { renameCompiledNonBaseJsOutputs } from "../../naming";
import { isRuntimeModuleSourceMap } from "../../naming/runtime";
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
  manifest: GccRuntimeManifest;
  chunkModuleIds: Map<string, Set<string>>;
}

export function compiledRenameInput(
  input: CompiledEmitRenameInput,
  outputFiles: string[],
  runtime: Pick<CompiledEmitRenames, "manifest" | "chunkModuleIds">,
) {
  const { compiled } = input;
  return {
    baseChunkName: resolveBaseChunkName(input.options),
    chunkOutputType: compiled.chunkOutputType,
    chunkModuleIds: runtime.chunkModuleIds,
    dynamicRootModuleIds: compiled.dynamicRootModuleIds,
    jsChunks: compiled.jsChunks,
    manifest: runtime.manifest,
    manifestFilePath: compiled.manifestFilePath,
    outDir: compiled.compiledCoreOutputs.finalOutDir,
    outputFiles,
    outputOptions: input.outputOptions,
    publicPath: compiled.publicPath,
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
  const runtimeModuleSourceMap = parseJson(
    await fs.readFile(compiled.runtimeModuleSourceMapFilePath, "utf8"),
    isRuntimeModuleSourceMap,
    compiled.runtimeModuleSourceMapFilePath,
  );
  const runtimeModuleIdToOriginalIds = buildRuntimeModuleIdMap({
    materialized: compiled.materialized,
    runtimeModuleSourceMap,
  });
  // Renames and CSS augmentation mutate URLs/rows, never chunk membership.
  const chunkModuleIds = buildChunkModuleIdLookup({
    jsChunks: compiled.jsChunks,
    manifest,
    runtimeModuleIdToOriginalIds,
  });
  const renamedNonBaseOutputs = await renameCompiledNonBaseJsOutputs(
    compiledRenameInput(input, compiled.compiledCoreOutputs.outputFiles, {
      manifest,
      chunkModuleIds,
    }),
  );
  if (compiled.cssOwnership.enabled) {
    await measureAsync(input.timingTotals, "cssAugmentMs", () =>
      augmentCompiledViteCss({
        baseChunkFilePath: renamedNonBaseOutputs.baseChunkFilePath,
        manifest,
        manifestFilePath: compiled.manifestFilePath,
        ownership: compiled.cssOwnership,
        runtimeModuleIdToOriginalIds,
      }),
    );
  }
  return { ...renamedNonBaseOutputs, chunkModuleIds };
}
