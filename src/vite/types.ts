import type { BuildOptions, ChunkLoaderInput } from "../api/types";
import type { GenerateExternsMode } from "../api/externs";

export interface GccTsBundlerGeneratedExternsOptions {
  appendLines?: string[];
  includeDependencies?: boolean;
  mode?: GenerateExternsMode;
  modules: string[];
  outputFile?: string;
}

export interface GccTsBundlerVitePluginOptions {
  compiler?: Omit<
    BuildOptions,
    "entries" | "languageOut" | "outDir" | "packages" | "projectRoot" | "srcDir"
  >;
  runtime?: {
    loader?: ChunkLoaderInput;
    manifestFile?: string;
    publicPath?: string;
  };
  externs?: {
    generate?: GccTsBundlerGeneratedExternsOptions;
  };
  html?: {
    rewriteEntryScripts?: boolean;
  };
  debug?: {
    dumpCapturedGraphDir?: string;
  };
}
