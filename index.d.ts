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

export interface CliParseResult {
  options: BuildOptions;
  showHelp: boolean;
}

export interface BuildResult {
  diagnostics: unknown[];
  emitSkipped: boolean;
  exitCode: number;
  options: NormalizedBuildOptions;
  outputFiles: string[];
  workspaceDir: string;
}

export declare const DEFAULT_BUILD_OPTIONS: Readonly<Required<BuildOptions>>;

export declare function build(options?: BuildOptions): Promise<BuildResult>;
export declare function main(args: string[]): Promise<number>;
export declare function normalizeBuildOptions(
  options?: BuildOptions,
): NormalizedBuildOptions;
export declare function parseCliArgs(args: string[]): CliParseResult;
export declare function runCli(args: string[]): Promise<number>;
