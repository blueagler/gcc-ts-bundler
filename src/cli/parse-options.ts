import minimist from "minimist";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import { CliParseResult } from "../internal/types";

function asStringArray(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function parseCliArgs(args: string[]): CliParseResult {
  const parsedArgs = minimist(args, {
    alias: {
      h: "help",
    },
    boolean: ["fatal-warnings", "help", "verbose"],
    string: [
      "cache-dir",
      "cache-mode",
      "chunk-base-name",
      "chunk-loader",
      "chunk-manifest",
      "chunk-public-path",
      "chunks",
      "compilation-level",
      "entry",
      "entry-point",
      "language-out",
      "out-dir",
      "packages",
      "preflight",
      "project-root",
      "src-dir",
    ],
  });

  if (parsedArgs.help) {
    return { options: { entries: [] }, showHelp: true };
  }

  const entries = asStringArray(parsedArgs.entry);

  return {
    options: {
      cache: {
        dir: parsedArgs["cache-dir"],
        mode: parsedArgs["cache-mode"] ?? DEFAULT_BUILD_OPTIONS.cache.mode,
      },
      chunks: {
        baseChunkName: parsedArgs["chunk-base-name"],
        loader: parsedArgs["chunk-loader"],
        manifestFile: parsedArgs["chunk-manifest"],
        mode: parsedArgs.chunks ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
        publicPath: parsedArgs["chunk-public-path"],
      },
      compilationLevel: parsedArgs["compilation-level"],
      diagnostics: {
        fatalWarnings: Boolean(parsedArgs["fatal-warnings"]),
        preflight:
          parsedArgs.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
        verbose: Boolean(parsedArgs.verbose),
      },
      entries,
      externs: asStringArray(parsedArgs.externs),
      js: asStringArray(parsedArgs.js),
      languageOut: parsedArgs["language-out"],
      outDir: parsedArgs["out-dir"],
      projectRoot: parsedArgs["project-root"],
      packages: {
        mode: parsedArgs.packages ?? DEFAULT_BUILD_OPTIONS.packages.mode,
      },
      srcDir: parsedArgs["src-dir"],
    },
    showHelp: false,
  };
}
