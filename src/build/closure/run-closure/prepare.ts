import path from "path";

import { prepareClosureJobs } from "../../../native/load";
import { logInternalDetail } from "../../../shared/timing";
import { resolveChunkOutputType } from "../../resolve/options";
import { remapOffModeEntryOutputs } from "../stage-outputs";
import type { ClosureStageInput } from "./types";

export function prepareClosureStageJobs(input: ClosureStageInput) {
  const chunkOutputType = resolveChunkOutputType({
    chunkMode: input.options.chunks.mode,
    languageOut: input.options.languageOut,
    outputType: input.options.chunks.outputType,
  });
  logInternalDetail("closure:chunk-output-type", chunkOutputType);

  const prepared = prepareClosureJobs({
    chunkLoader: "script",
    chunkMode: input.options.chunks.mode,
    chunkOutputType,
    chunkPlan: input.chunkPlan,
    compilationLevel: input.options.compilationLevel,
    diagnosticsVerbose: input.options.diagnostics.verbose,
    emittedOutDir: input.emittedOutDir,
    explicitExternPaths: input.explicitExternPaths,
    explicitJsInputs: input.options.js,
    finalCacheDir: input.finalCacheDir,
    generatedExterns: input.generatedExterns.map((extern) => ({
      path: extern.path,
      entryFiles: extern.entryFiles.map((filePath) => {
        const index = input.options.entries.findIndex(
          (entry) => entry.file === filePath,
        );
        const sourcePath = input.entryFiles[index]?.sourcePath;
        if (!sourcePath) {
          throw new TypeError(
            `Missing resolved entry ownership for typed extern ${extern.path}: ${filePath}`,
          );
        }
        const relativePath = path.relative(
          path.join(input.projectCacheDir, "workspace"),
          sourcePath,
        );
        return relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)
          ? sourcePath
          : relativePath;
      }),
    })),
    languageOut: input.options.languageOut,
    manifestFile: input.options.chunks.manifestFile,
    hasPreservedModules: input.preservedModules.length > 0,
    nativeExternPath: input.nativeExternPath,
    needsCssRuntime: input.options.cssRuntime,
    outDir: input.outDir,
    packageRoot: input.packageRoot,
    publicPath: input.options.chunks.publicPath,
    supportFiles: input.supportFiles,
    typeMetadata: input.typeMetadata,
  });

  if (input.options.chunks.mode === "off") {
    remapOffModeEntryOutputs({
      chunkPlan: input.chunkPlan,
      entryFiles: input.entryFiles,
      outDir: input.outDir,
      prepared,
    });
  }

  return { chunkOutputType, prepared };
}
