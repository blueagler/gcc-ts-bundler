import type { ResolvedConfig, UserConfig } from "vite";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import type { BuildOptions } from "../api/types";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type { ManifestFileSettings } from "./internal-types";

export const INTERNAL_VITE_MANIFEST_FILE = ".gcc-ts-bundler-vite-manifest.json";
export const INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE =
  ".gcc-ts-bundler-vite-runtime-module-sources.json";

export function applyViteBuildGuards(userConfig: UserConfig): UserConfig {
  if (userConfig.build?.ssr) {
    throw new Error("gccTsBundler() does not support Vite SSR builds.");
  }
  if (userConfig.build?.lib) {
    throw new Error("gccTsBundler() does not support Vite library mode.");
  }
  if (userConfig.build?.manifest) {
    throw new Error(
      "gccTsBundler() does not support Vite build.manifest output.",
    );
  }
  if (userConfig.build?.sourcemap) {
    throw new Error("gccTsBundler() does not support Vite sourcemaps.");
  }

  return {
    build: {
      modulePreload: false,
      target: userConfig.build?.target ?? "es2018",
    },
  };
}

export function resolveBaseChunkName(options: GccTsBundlerVitePluginOptions) {
  return (
    options.compiler?.chunks?.baseChunkName ??
    DEFAULT_BUILD_OPTIONS.chunks.baseChunkName
  );
}

export function resolveManifestFileSettings(
  options: GccTsBundlerVitePluginOptions,
): ManifestFileSettings {
  const requestedFile =
    options.runtime?.manifestFile ?? options.compiler?.chunks?.manifestFile;
  if (requestedFile && requestedFile.length > 0) {
    return {
      fileName: requestedFile,
      isInternal: false,
    };
  }

  return {
    fileName: INTERNAL_VITE_MANIFEST_FILE,
    isInternal: true,
  };
}

export function resolvePublicPath(
  config: ResolvedConfig,
  options: GccTsBundlerVitePluginOptions,
) {
  const value = options.runtime?.publicPath ?? config.base ?? "./";
  if (value.length === 0) {
    return "./";
  }
  return value.endsWith("/") ? value : `${value}/`;
}

export function createCompilerOptions(input: {
  entries: string[];
  externs: string[];
  manifestFile: string;
  options: GccTsBundlerVitePluginOptions;
  outDir: string;
  projectRoot: string;
  publicPath: string;
  srcDir: string;
}): BuildOptions {
  const compiler = input.options.compiler ?? {};
  const compilerChunks = compiler.chunks ?? {};

  return {
    ...compiler,
    entries: input.entries,
    externs: input.externs,
    outDir: input.outDir,
    packages: { mode: "off" },
    projectRoot: input.projectRoot,
    srcDir: input.srcDir,
    chunks: {
      ...compilerChunks,
      baseChunkName:
        compilerChunks.baseChunkName ??
        DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      loader:
        input.options.runtime?.loader ??
        compilerChunks.loader ??
        DEFAULT_BUILD_OPTIONS.chunks.loader,
      manifestFile: input.manifestFile,
      mode: "bundler-runtime",
      publicPath: input.publicPath,
    },
  };
}
