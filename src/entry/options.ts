import minimist from "minimist";
import path from "path";

import { usage } from "../utils/file-utils";

export interface BuildOptions {
  compilationLevel?: string;
  cwd?: string;
  entryPoints?: string | string[];
  externs?: string[];
  fatalWarnings?: boolean;
  js?: string[];
  languageOut?: string;
  outputDir?: string;
  preserveCache?: boolean;
  srcDir?: string;
  verbose?: boolean;
  workspaceDir?: string;
}

export interface NormalizedBuildOptions {
  compilationLevel: string;
  compilerEntryPoints: string[];
  cwd: string;
  entryPoints: string[];
  externs: string[];
  fatalWarnings: boolean;
  js: string[];
  languageOut: string;
  outputDir: string;
  preserveCache: boolean;
  srcDir: string;
  verbose: boolean;
}

export type Settings = NormalizedBuildOptions;

export interface CliParseResult {
  options: BuildOptions;
  showHelp: boolean;
}

export const DEFAULT_BUILD_OPTIONS: Readonly<
  Omit<Required<BuildOptions>, "workspaceDir"> & { workspaceDir?: string }
> = Object.freeze({
  compilationLevel: "ADVANCED",
  cwd: process.cwd(),
  entryPoints: [],
  externs: [],
  fatalWarnings: false,
  js: [],
  languageOut: "ECMASCRIPT_NEXT",
  outputDir: "./dist",
  preserveCache: false,
  srcDir: "./src",
  verbose: false,
  workspaceDir: undefined,
});

function normalizeEntryPoints(
  entryPoints: string | string[] | undefined,
): string[] {
  if (!entryPoints) {
    return [];
  }

  return Array.isArray(entryPoints) ? entryPoints : [entryPoints];
}

export function normalizeBuildOptions(options: BuildOptions = {}): Settings {
  const cwd = path.resolve(options.cwd ?? DEFAULT_BUILD_OPTIONS.cwd);
  const srcDir = path.resolve(
    cwd,
    options.srcDir ?? DEFAULT_BUILD_OPTIONS.srcDir,
  );
  const entryPoints = normalizeEntryPoints(options.entryPoints).map(
    (entryPoint) =>
      path.isAbsolute(entryPoint)
        ? entryPoint
        : path.resolve(srcDir, entryPoint),
  );

  return {
    compilationLevel:
      options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    compilerEntryPoints: entryPoints.map((entryPoint) => {
      const relativePath = path.relative(srcDir, entryPoint);
      return `goog:_gcc_${relativePath
        .replace(/\.[^/.]+$/, "")
        .replace(/[\\/]/g, ".")}`;
    }),
    cwd,
    entryPoints,
    externs: [...(options.externs ?? DEFAULT_BUILD_OPTIONS.externs)],
    fatalWarnings: options.fatalWarnings ?? DEFAULT_BUILD_OPTIONS.fatalWarnings,
    js: [...(options.js ?? DEFAULT_BUILD_OPTIONS.js)],
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outputDir: path.resolve(
      cwd,
      options.outputDir ?? DEFAULT_BUILD_OPTIONS.outputDir,
    ),
    preserveCache: options.preserveCache ?? DEFAULT_BUILD_OPTIONS.preserveCache,
    srcDir,
    verbose: options.verbose ?? DEFAULT_BUILD_OPTIONS.verbose,
  };
}

export function parseCliArgs(args: string[]): CliParseResult {
  const parsedArgs = minimist(args);
  if (parsedArgs.h || parsedArgs.help) {
    return { options: {}, showHelp: true };
  }

  return {
    options: {
      compilationLevel:
        parsedArgs.compilation_level ?? parsedArgs.compilationLevel,
      entryPoints: parsedArgs.entry_point ?? parsedArgs.entryPoint,
      fatalWarnings: Boolean(
        parsedArgs.fatal_warnings ?? parsedArgs.fatalWarnings,
      ),
      languageOut: parsedArgs.language_out ?? parsedArgs.languageOut,
      outputDir: parsedArgs.output_dir ?? parsedArgs.outputDir,
      preserveCache: Boolean(
        parsedArgs.preserve_cache ?? parsedArgs.preserveCache,
      ),
      srcDir: parsedArgs.src_dir ?? parsedArgs.srcDir,
      verbose: Boolean(parsedArgs.verbose),
      workspaceDir: parsedArgs.workspace_dir ?? parsedArgs.workspaceDir,
    },
    showHelp: false,
  };
}

export function loadSettingsFromArgs(args: string[]): { settings: Settings } {
  const { options, showHelp } = parseCliArgs(args);
  if (showHelp) {
    usage();
    process.exit(0);
  }

  return { settings: normalizeBuildOptions(options) };
}
