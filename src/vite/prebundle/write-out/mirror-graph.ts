import fs from "node:fs/promises";
import path from "node:path";

import { syncDirectoryEntries } from "../../../shared/files";
import type { MaterializedGraph } from "../../internal-types";
import { withOneToOneTypeProvenance } from "../../type-metadata";
import { remapRuntimeModuleToSrcDir } from "./remap-runtime-module";
import { normalizePath } from "../shared";
import type { PrebundleContext } from "../types";

/** No dependency bundles: mirror the graph into the runtime dir unchanged. */
export async function mirrorGraphWithoutBundles(
  context: PrebundleContext,
): Promise<MaterializedGraph> {
  const { materialized, runtimeSrcDir } = context;
  if (runtimeSrcDir === materialized.srcDir) {
    return {
      ...materialized,
      modules: materialized.modules.map(withOneToOneTypeProvenance),
    };
  }
  const runtimeEntries = await Promise.all(
    [
      ...new Set(
        materialized.modules.map((module) => normalizePath(module.filePath)),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        content: await fs.readFile(filePath, "utf8"),
        relativePath: path
          .relative(materialized.srcDir, filePath)
          .replace(/\\/g, "/"),
      })),
  );
  await syncDirectoryEntries(runtimeSrcDir, runtimeEntries);
  return {
    ...materialized,
    authoredFiles: materialized.authoredFiles
      .map((filePath) =>
        normalizePath(
          path.join(
            runtimeSrcDir,
            path.relative(materialized.srcDir, filePath),
          ),
        ),
      )
      .sort((left, right) => left.localeCompare(right)),
    modules: materialized.modules.map((module) =>
      withOneToOneTypeProvenance(
        remapRuntimeModuleToSrcDir(module, materialized.srcDir, runtimeSrcDir),
      ),
    ),
    srcDir: runtimeSrcDir,
  };
}
