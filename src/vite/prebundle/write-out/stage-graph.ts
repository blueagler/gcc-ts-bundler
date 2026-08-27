import fs from "node:fs/promises";
import path from "node:path";

import { syncDirectoryEntries } from "../../../shared/files";
import type { MaterializedGraph } from "../../internal-types";
import { withOneToOneTypeProvenance } from "../../type-metadata";
import { remapRuntimeModuleToSrcDir } from "./remap-runtime-module";
import { normalizePath } from "../shared";
import type { PrebundleContext } from "../types";

/**
 * No dependency bundles: the graph Closure compiles is the materialized graph
 * itself, so every module keeps one-to-one type provenance. When the runtime
 * dir is the materialized dir the modules already sit at their final paths and
 * nothing is written; otherwise one `syncDirectoryEntries` pass stages each
 * module exactly once, because the returned `srcDir` has to hold the tree the
 * compiler, the type-metadata mapping, and `debug.dumpCapturedGraphDir` read.
 */
export async function stageGraphWithoutBundles(
  context: PrebundleContext,
): Promise<MaterializedGraph> {
  const { materialized, runtimeSrcDir } = context;
  if (normalizePath(runtimeSrcDir) === normalizePath(materialized.srcDir)) {
    return {
      ...materialized,
      modules: materialized.modules.map(withOneToOneTypeProvenance),
    };
  }
  const stagedEntries = await Promise.all(
    [
      ...new Set(
        materialized.modules.map((module) => normalizePath(module.filePath)),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => {
        const relativePath = path
          .relative(materialized.srcDir, filePath)
          .replace(/\\/g, "/");
        if (
          relativePath === ".." ||
          relativePath.startsWith("../") ||
          path.isAbsolute(relativePath)
        ) {
          throw new Error(
            `Cannot stage module outside the materialized source root: ${filePath} is not under ${materialized.srcDir}.`,
          );
        }
        return {
          content: await fs.readFile(filePath, "utf8"),
          relativePath,
        };
      }),
  );
  await syncDirectoryEntries(runtimeSrcDir, stagedEntries);
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
