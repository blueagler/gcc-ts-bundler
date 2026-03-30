import { BuildOptions, BuildResult, CleanCacheOptions } from "./types";
import { usage } from "../cli/usage";
import { parseCliArgs } from "../cli/parse-options";
import {
  build as runBuild,
  cleanCache as runCleanCache,
} from "../pipeline/build-pipeline";
import { normalizeBuildOptions, resolveBuild } from "../pipeline/resolve-build";

export async function build(options: BuildOptions): Promise<BuildResult> {
  return runBuild(options);
}

export { cleanCache, normalizeBuildOptions, resolveBuild };

export async function runCli(args: string[]): Promise<number> {
  const { options, showHelp } = parseCliArgs(args);
  if (showHelp) {
    usage();
    return 0;
  }

  const result = await runBuild(options);
  return result.exitCode;
}

export async function main(args: string[]): Promise<number> {
  return runCli(args);
}

async function cleanCache(options: CleanCacheOptions = {}) {
  return runCleanCache(options);
}
