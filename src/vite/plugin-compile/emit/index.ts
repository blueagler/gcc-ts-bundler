import type { ResolvedConfig } from "vite";

import type {
  NormalizedOutputOptions,
  OutputBundle,
  PluginContext,
} from "../../internal-types";
import type { ViteTimingTotals } from "../../plugin-graph";
import type { GccTsBundlerVitePluginOptions } from "../../types";
import type { CompiledViteGraph } from "../compile";
import { resolveCompiledEmitAssets } from "./assets";
import { finalizeCompiledEmit } from "./outputs";
import { renameCompiledEmitOutputs } from "./rename";

export async function emitViteGraph(
  this: PluginContext,
  input: {
    bundle: OutputBundle;
    compiled: CompiledViteGraph;
    config: ResolvedConfig;
    options: GccTsBundlerVitePluginOptions;
    outputOptions: NormalizedOutputOptions;
    timingTotals: ViteTimingTotals;
  },
) {
  const renamedNonBaseOutputs = await renameCompiledEmitOutputs(input);
  const finalizedBaseOutput = await resolveCompiledEmitAssets(
    this,
    input,
    renamedNonBaseOutputs,
  );
  return await finalizeCompiledEmit(this, input, finalizedBaseOutput);
}
