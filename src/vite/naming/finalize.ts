import type {
  NormalizedOutputOptions,
  ViteChunkOutputType,
} from "../internal-types";
import type { BaseOutputSeed, DeferredChunkSeed } from "./helpers";
import { finalizeEsmChunkNames } from "./esm";
import { finalizeScriptChunkNames } from "./script";

export async function finalizeBaseJsOutputName(input: {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  chunkOutputType: ViteChunkOutputType;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifestFilePath: string;
  outputOptions: NormalizedOutputOptions;
  outDir: string;
  publicPath: string;
}) {
  if (input.chunkOutputType === "esm") {
    return finalizeEsmChunkNames(input);
  }
  return finalizeScriptChunkNames(input);
}
