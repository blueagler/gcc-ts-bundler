import { build, cleanCache, generateExterns } from "../api/build";
import { parseCliArgs, parseExternsCliArgs } from "./parse";
import { usage } from "./usage";

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
    for (const warning of result.barrierWarnings) {
      console.warn(`gcc-ts-bundler: ${warning.message}`);
    }
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
