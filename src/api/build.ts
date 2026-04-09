import { BuildOptions, BuildResult } from "./types";
import { generateExterns } from "./externs";
import { usage } from "../cli/usage";
import { parseCliArgs } from "../cli/parse-options";
import { parseExternsCliArgs } from "../cli/parse-externs-options";

async function loadBuildPipeline() {
  return import("../pipeline/build-pipeline");
}

export async function cleanCache(options: {
  cacheDir?: string;
  projectRoot?: string;
}): Promise<void> {
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
  return result.exitCode;
}

export async function main(args: string[]): Promise<number> {
  return runCli(args);
}
