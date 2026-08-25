import type {
  ChunkPlanChunk,
  PreservedImport,
  PreservedModule,
} from "../../types";
import type { prepareClosureJobs } from "../../../native/load";
import { emitPreservedModuleFiles } from "./emit";
import { rewritePreservedModulePaths } from "./rewrite";

export async function emitPreservedModules(input: {
  chunkPlan: ChunkPlanChunk[];
  imports: PreservedImport[];
  modules: PreservedModule[];
  outDir: string;
  postprocessActions: ReturnType<
    typeof prepareClosureJobs
  >["postprocessActions"];
}) {
  if (input.modules.length === 0 && input.imports.length === 0) {
    return [];
  }
  if (input.chunkPlan.length !== input.postprocessActions.length) {
    throw new Error(
      "Preserved-module emission could not align Closure chunks with output actions.",
    );
  }

  const outputFiles = await emitPreservedModuleFiles({
    modules: input.modules,
    outDir: input.outDir,
  });
  await rewritePreservedModulePaths(input);
  return outputFiles;
}
