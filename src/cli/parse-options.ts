import minimist from "minimist";
import path from "path";

import {
  BuildOptions,
  CliParseResult,
  DEFAULT_BUILD_OPTIONS,
  NormalizedBuildOptions,
} from "../api/types";

function asStringArray(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

export function normalizeBuildOptions(
  options: BuildOptions,
): NormalizedBuildOptions {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path.resolve(projectRoot, options.srcDir ?? "src");
  const outDir = path.resolve(projectRoot, options.outDir ?? "dist");

  return {
    cache: {
      dir: options.cache?.dir
        ? path.resolve(projectRoot, options.cache.dir)
        : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode,
    },
    compilationLevel:
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings:
        options.diagnostics?.fatalWarnings ??
        DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight:
        options.diagnostics?.preflight ??
        DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose:
        options.diagnostics?.verbose ??
        DEFAULT_BUILD_OPTIONS.diagnostics.verbose,
    },
    entries: options.entries.map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(srcDir, entry),
    ),
    externs: [...(options.externs ?? [])].map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(projectRoot, entry),
    ),
    js: [...(options.js ?? [])].map((entry) =>
      path.isAbsolute(entry) ? entry : path.resolve(projectRoot, entry),
    ),
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    postProcess: {
      minify:
        options.postProcess?.minify ?? DEFAULT_BUILD_OPTIONS.postProcess.minify,
      rewriteExports:
        options.postProcess?.rewriteExports ??
        DEFAULT_BUILD_OPTIONS.postProcess.rewriteExports,
    },
    projectRoot,
    srcDir,
  };
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
