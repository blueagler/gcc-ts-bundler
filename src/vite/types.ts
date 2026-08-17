import type { ExternsProtocolHelpers, GenerateExternsMode } from "../externs";
import type { BuildOptions, ChunkOptions } from "../api/types";

export interface GccTsBundlerGeneratedExternsOptions {
  appendLines?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly string[];
  outputFile?: string | undefined;
  protocolHelpers?: ExternsProtocolHelpers | undefined;
}

export interface GccTsBundlerVitePluginOptions {
  /**
   * Core `BuildOptions` minus the fields Vite owns.
   *
   * `compilationLevel` stays settable, but anything other than `"ADVANCED"`
   * warns: `"SIMPLE"` measured +9.9% gzip against plain esbuild on a
   * 2352-module React app, and `"WHITESPACE_ONLY"` is worse again.
   *
   * `externs` is deliberately still accepted. `createCompilerOptions` does
   * replace the field, but with the `renameBarriers` list that
   * `resolveCompilerExterns` builds *from* these paths — `src/vite/externs.ts`
   * resolves each against `projectRoot` and unions it with the generated
   * extern file — so they do reach Closure. This is a different field from the
   * plugin-level `externs.generate` below.
   *
   * `hideWarningsFor: []` keeps `jscomp_warning=checkTypes` but reports type
   * diagnostics. The default (`undefined`) still hides them with
   * `--hide_warnings_for=/`.
   */
  compiler?:
    | (Omit<
        BuildOptions,
        | "chunks"
        | "entries"
        | "languageOut"
        | "outDir"
        | "packages"
        | "projectRoot"
        | "srcDir"
      > & {
        /**
         * Chunk options except `mode`, which the plugin owns:
         * `createCompilerOptions` hardcodes `mode: "bundler-runtime"`, so a
         * caller-supplied value was overwritten before any reader saw it and
         * measured byte-identical. It is a type error rather than a no-op.
         */
        chunks?: Omit<ChunkOptions, "mode"> | undefined;
      })
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
