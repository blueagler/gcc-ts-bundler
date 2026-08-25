import type { BuildOptions, BuildResult, CleanCacheOptions } from "./types";
import { auditExternFiles, generateExterns } from "../externs";
import * as pipeline from "../build/pipeline";

export async function cleanCache(
  options: CleanCacheOptions = {},
): Promise<void> {
  return pipeline.cleanCache(options);
}

export const build = async (options: BuildOptions): Promise<BuildResult> => {
  // Explicit extern files are barriers too, and hand-written ones are the
  // least likely to have been counted. Non-fatal: this is a cost signal.
  for (const warning of await auditExternFiles(
    options.externs ?? [],
    options.projectRoot,
  )) {
    console.warn(`gcc-ts-bundler: ${warning.message}`);
  }
  return pipeline.build(options);
};
export { generateExterns };
