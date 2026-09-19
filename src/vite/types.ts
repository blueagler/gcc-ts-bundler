import type { ExternsProtocolHelpers, GenerateExternsMode } from "../externs";
import type { BuildOptions, ChunkOptions } from "../api/types";

export interface GccTsBundlerGeneratedExternsOptions {
  appendLines?: readonly string[] | undefined;
  includeDependencies?: boolean | undefined;
  mode?: GenerateExternsMode | undefined;
  modules: readonly string[];
  outputFile?: string | undefined;
  propertyPolicy?: { renameable: readonly string[] } | undefined;
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
   * `resolveCompilerExterns` builds *from* these paths — `src/vite/compiler-externs.ts`
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
         * Chunk options except fields the plugin owns.
         *
         * `mode` is hardcoded to `"bundler-runtime"`.
         * `publicPath` is overwritten from `runtime.publicPath ?? config.base`.
         * `vendorChunk` is ignored: Vite mirrors Rollup's chunk graph, so
         * there is nothing left for the standalone vendor split to partition.
         * Caller-supplied values are type errors rather than no-ops.
         */
        chunks?:
          Omit<ChunkOptions, "mode" | "publicPath" | "vendorChunk"> | undefined;
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
  debug?:
    | {
        dumpCapturedGraphDir?: string | undefined;
      }
    | undefined;
  /**
   * Write a machine-readable evidence report (JSON) after emit: JS byte
   * delta vs the Vite chunks the plugin replaced (raw and gzip, zlib level
   * 9), modules Vite rendered that the linked whole-program graph proved
   * unreferenced, and the property names pinned as rename barriers. `file`
   * is resolved against the project root and defaults to
   * `"gcc-report.json"`. The report is useful even when you ship stock
   * Vite output: dead modules and pinned properties are findings about
   * your graph, not about this bundler.
   */
  report?:
    | {
        file?: string | undefined;
      }
    | undefined;
}
/**
 * Evidence report for one build: what the whole-program pass proved, stated
 * against the Vite output it replaced. Every number is measured on this
 * build's artifacts — nothing is estimated. Gzip is zlib level 9, matching
 * `verify:examples`, so report deltas and the canary gate are directly
 * comparable.
 */
export interface ViteBuildReport {
  version: 1;
  javascript: {
    /** The Vite-emitted JS chunks this plugin replaced. */
    baseline: { chunkCount: number; gzipBytes: number; rawBytes: number };
    /** The Closure-compiled JS the plugin emitted instead. */
    output: { fileCount: number; gzipBytes: number; rawBytes: number };
    /** Output relative to baseline; negative means smaller. */
    deltaPct: { gzip: number; raw: number };
  };
  modules: {
    capturedCount: number;
    compiledCount: number;
    /**
     * Modules Vite rendered into chunks that the linked whole-program graph
     * proved unreferenced: the plugin excluded them from compilation, so the
     * baseline bytes they occupy are deletable even under stock Vite.
     */
    deadModules: Array<{ id: string; renderedBytes: number }>;
    prunedEmptyCount: number;
  };
  properties: {
    /**
     * Property names pinned as rename barriers (`Object.prototype.<name>`
     * lines in the extern files). Each is a boundary Closure must not
     * rename; shrinking this list is the size lever.
     */
    pinned: string[];
    renameBarrierFiles: string[];
    typedExternFiles: string[];
  };
}
