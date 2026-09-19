import { parseArgs } from "node:util";

import type { CleanCacheOptions } from "../../api/types";

export function parseCleanCacheCliArgs(args: string[]): {
  options: CleanCacheOptions;
  showHelp: boolean;
} {
  const { values } = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "cache-dir": { type: "string" },
      help: { short: "h", type: "boolean" },
      "project-root": { type: "string" },
    },
    strict: true,
  });

  return {
    options: {
      cacheDir: values["cache-dir"],
      projectRoot: values["project-root"],
    },
    showHelp: values.help ?? false,
  };
}
