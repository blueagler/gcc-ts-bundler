import { build, cleanCache, generateExterns } from "../api/build";
import { getErrorMessage } from "../shared/validation";
import { parseCleanCacheCliArgs } from "./parse/clean-cache";
import { parseExternsCliArgs } from "./parse/externs";
import { parseCliArgs } from "./parse/options";
import { usage } from "./usage";

export async function runCli(args: string[]): Promise<number> {
  try {
    return await runCommand(args);
  } catch (error) {
    console.error(`gcc-ts-bundler: ${getErrorMessage(error)}`);
    return 1;
  }
}

async function runCommand(args: string[]): Promise<number> {
  const [firstArg, ...restArgs] = args;
  if (firstArg === undefined) {
    usage();
    return 0;
  }

  if (firstArg === "clean-cache") {
    const { options, showHelp } = parseCleanCacheCliArgs(restArgs);
    if (showHelp) {
      usage();
      return 0;
    }

    await cleanCache(options);
    return 0;
  }

  if (firstArg === "externs") {
    const { options, showHelp } = parseExternsCliArgs(restArgs);
    if (showHelp) {
      usage();
      return 0;
    }
    if (options.modules.length === 0) {
      throw new Error("externs requires at least one --module");
    }

    const result = await generateExterns(options);
    for (const warning of result.barrierWarnings) {
      console.warn(`gcc-ts-bundler: ${warning.message}`);
    }
    if (!result.outputFile) {
      process.stdout.write(result.text);
    }
    return 0;
  }

  if (firstArg !== "build" && !firstArg.startsWith("-")) {
    throw new Error(`Unknown command: ${firstArg}`);
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
