import type { GenerateExternsMode } from "../externs";
import type { BuildOptions } from "../api/types";

export interface GccTsBundlerGeneratedExternsOptions {
  appendLines?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly string[];
  outputFile?: string | undefined;
}

export interface GccTsBundlerVitePluginOptions {
  compiler?:
    | Omit<
        BuildOptions,
        | "entries"
        | "languageOut"
        | "outDir"
        | "packages"
        | "projectRoot"
        | "srcDir"
      >
    | undefined;
  runtime?:
    | {
        manifestFile?: string | undefined;
        publicPath?: string | undefined;
      }
    | undefined;
  externs?:
    | {
        generate?: GccTsBundlerGeneratedExternsOptions | undefined;
      }
    | undefined;
  html?:
    | {
        rewriteEntryScripts?: boolean | undefined;
      }
    | undefined;
  debug?:
    | {
        dumpCapturedGraphDir?: string | undefined;
      }
    | undefined;
}
