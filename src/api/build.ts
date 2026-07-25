import type { BuildOptions, BuildResult, CleanCacheOptions } from "./types";
import { generateExterns } from "../externs";
import { usage } from "../cli/usage";
import { parseCliArgs } from "../cli/parse-options";
import { parseExternsCliArgs } from "../cli/parse-externs-options";

async function loadBuildPipeline() {
  return import("../build/pipeline");
}

export async function cleanCache(
  options: CleanCacheOptions = {},
): Promise<void> {
  const pipeline = await loadBuildPipeline();
  return pipeline.cleanCache(options);
}

export const build = async (options: BuildOptions): Promise<BuildResult> => {
  const pipeline = await loadBuildPipeline();
  return pipeline.build(options);
};
export { generateExterns };

export async function runCli(args: string[]): Promise<number> {
  const [firstArg, ...restArgs] = args;
  if (!firstArg || firstArg === "-h" || firstArg === "--help") {
    usage();
    return 0;
  }

  if (firstArg === "clean-cache") {
    const { options, showHelp } = parseCliArgs(restArgs);
    if (showHelp) {
      usage();
      return 0;
    }

    await cleanCache({
      cacheDir: options.cache?.dir,
      projectRoot: options.projectRoot,
    });
    return 0;
  }

  if (firstArg === "externs") {
    const { options, showHelp } = parseExternsCliArgs(restArgs);
    if (showHelp || options.modules.length === 0) {
      usage();
      return showHelp ? 0 : 1;
    }

    const result = await generateExterns(options);
    if (!result.outputFile) {
      process.stdout.write(result.text);
    }
    return 0;
  }

  const buildArgs = firstArg === "build" ? restArgs : args;
  const { options, showHelp } = parseCliArgs(buildArgs);
  if (showHelp) {
    usage();
    return 0;
  }

  const result = await build(options);
  if (result.ok) {
    return 0;
  }
  for (const diagnostic of result.diagnostics) {
    const location =
      diagnostic.file === undefined
        ? ""
        : `${diagnostic.file}${diagnostic.line === undefined ? "" : `:${diagnostic.line}`}: `;
    console.error(`${location}${diagnostic.message}`);
  }
  return 1;
}
