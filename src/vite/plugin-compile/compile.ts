import fs from "node:fs/promises";
import path from "node:path";

import type { ResolvedConfig } from "vite";

import { build } from "../../api/build";
import {
  normalizeBuildOptions,
  resolveChunkOutputType,
} from "../../build/resolve/options";
import type { BuildOptions, LanguageOut } from "../../api/types";
import type {
  HostBuildExtensions,
  InternalBuildOptions,
} from "../../build/types";
import {
  createCompilerOptions,
  INTERNAL_VITE_AUTHORED_FILES_FILE,
  INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
} from "../config";
import { ownershipNeedsCssRuntime } from "../css";
import type {
  CompiledCoreOutputSet,
  PluginContext,
  ViteChunkOutputType,
} from "../internal-types";
import type { PreparedViteGraph } from "../plugin-graph";
import { serializeRollupChunkGraph } from "../rollup-chunks";
import type { GccTsBundlerVitePluginOptions } from "../types";
import { stageCompiledCoreOutputs } from "../workspace";

export interface CompiledViteGraph extends PreparedViteGraph {
  chunkOutputType: ViteChunkOutputType;
  compiledCoreOutputs: CompiledCoreOutputSet;
  manifestFilePath: string;
  runtimeModuleSourceMapFilePath: string;
}

/**
 * Runs the compiler options through the shared resolver, so the gating rules
 * for `chunks.outputType` (language level, chunk mode) live in exactly one
 * place and the Vite side just consumes the answer.
 */
function resolveViteChunkOutputType(
  compilerOptions: BuildOptions,
): ViteChunkOutputType {
  const resolved = normalizeBuildOptions(compilerOptions);
  return resolveChunkOutputType({
    chunkMode: resolved.chunks.mode,
    languageOut: resolved.languageOut,
    outputType: resolved.chunks.outputType,
  });
}

export async function compileViteGraph(
  this: PluginContext,
  input: {
    config: ResolvedConfig;
    languageOut: LanguageOut;
    options: GccTsBundlerVitePluginOptions;
    prepared: PreparedViteGraph;
  },
): Promise<CompiledViteGraph> {
  const { prepared } = input;
  const compilerOptions = createCompilerOptions({
    config: input.config,
    entries: prepared.materialized.entries,
    externs: prepared.externs.renameBarriers,
    manifestFile: prepared.manifestSettings.fileName,
    languageOut: input.languageOut,
    options: input.options,
    outDir: prepared.coreOutDir,
    projectRoot: input.config.root,
    publicPath: prepared.publicPath,
    srcDir: prepared.materialized.srcDir,
    typeMetadata: prepared.typeMetadata,
    typedExterns: prepared.externs.typedDeclarations,
  });
  const runtimeModuleSourceMapFilePath = path.join(
    prepared.captureRoot,
    INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE,
  );
  const authoredFilesFilePath = path.join(
    prepared.captureRoot,
    INTERNAL_VITE_AUTHORED_FILES_FILE,
  );
  await fs.writeFile(
    authoredFilesFilePath,
    JSON.stringify(prepared.materialized.authoredFiles, null, 2),
    "utf8",
  );
  // The runtime preamble is Closure input, but CSS rows are attached after the
  // compile, so the compiler cannot see for itself whether it will ever need
  // the `<link>` loader. This is the only place the answer exists in time.
  const hostExtensions: HostBuildExtensions = {
    cssRuntime: ownershipNeedsCssRuntime(prepared.cssOwnership),
    // Vite has a second output-finalization phase for hashed names, resolved
    // asset URLs, and preserved-import specifiers. Minify only after that.
    finalMinify: false,
    rollupChunks: serializeRollupChunkGraph({
      jsChunks: prepared.jsChunks,
      materialized: prepared.materialized,
    }),
    viteAuthoredFilesFile: authoredFilesFilePath,
    viteRuntimeSourceMapFile: runtimeModuleSourceMapFilePath,
  };
  const buildOptions: InternalBuildOptions = {
    ...compilerOptions,
    ...hostExtensions,
  };
  const result = await build(buildOptions);
  if (!result.ok) {
    this.error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n") ||
        "gccTsBundler() failed while compiling the captured Vite graph.",
    );
  }

  const compiledCoreOutputs = await stageCompiledCoreOutputs({
    coreOutDir: prepared.coreOutDir,
    finalOutDir: prepared.finalOutDir,
    outputFiles: result.outputFiles,
  });
  return {
    ...prepared,
    chunkOutputType: resolveViteChunkOutputType(compilerOptions),
    compiledCoreOutputs,
    manifestFilePath: path.join(
      compiledCoreOutputs.finalOutDir,
      prepared.manifestSettings.fileName,
    ),
    runtimeModuleSourceMapFilePath,
  };
}
