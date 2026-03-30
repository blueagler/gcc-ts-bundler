import minimist from "minimist";

import { CliParseResult, DEFAULT_BUILD_OPTIONS } from "../api/types";

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
    boolean: ["fatal-warnings", "help", "no-rewrite-exports", "verbose"],
    string: [
      "cache-dir",
      "cache-mode",
      "compilation-level",
      "entry",
      "entry-point",
      "language-out",
      "out-dir",
      "post-minify",
      "preflight",
      "project-root",
      "src-dir",
    ],
  });

  if (parsedArgs.help) {
    return { options: { entries: [] }, showHelp: true };
  }

  const entries = asStringArray(
    parsedArgs.entry ?? parsedArgs.entry_point ?? parsedArgs.entryPoint,
  );

  return {
    options: {
      cache: {
        dir: parsedArgs["cache-dir"] ?? parsedArgs.cache_dir,
        mode:
          parsedArgs["cache-mode"] ??
          parsedArgs.cache_mode ??
          DEFAULT_BUILD_OPTIONS.cache.mode,
      },
      compilationLevel:
        parsedArgs["compilation-level"] ??
        parsedArgs.compilation_level ??
        parsedArgs.compilationLevel,
      diagnostics: {
        fatalWarnings: Boolean(
          parsedArgs["fatal-warnings"] ??
          parsedArgs.fatal_warnings ??
          parsedArgs.fatalWarnings,
        ),
        preflight:
          parsedArgs.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
        verbose: Boolean(parsedArgs.verbose),
      },
      entries,
      externs: asStringArray(parsedArgs.externs),
      js: asStringArray(parsedArgs.js),
      languageOut:
        parsedArgs["language-out"] ??
        parsedArgs.language_out ??
        parsedArgs.languageOut,
      outDir:
        parsedArgs["out-dir"] ?? parsedArgs.output_dir ?? parsedArgs.outputDir,
      postProcess: {
        minify: parsedArgs["post-minify"] === "swc" ? "swc" : false,
        rewriteExports: !parsedArgs["no-rewrite-exports"],
      },
      projectRoot: parsedArgs["project-root"] ?? parsedArgs.project_root,
      srcDir: parsedArgs["src-dir"] ?? parsedArgs.src_dir ?? parsedArgs.srcDir,
    },
    showHelp: false,
  };
}
