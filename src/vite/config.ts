import type { ResolvedConfig, UserConfig } from "vite";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import type { BuildOptions, LanguageOut } from "../api/types";
import { isRecord } from "../shared/validation";
import { normalizeChunkLoader } from "../build/resolve/options";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type { ManifestFileSettings } from "./internal-types";

export const INTERNAL_VITE_MANIFEST_FILE = ".gcc-ts-bundler-vite-manifest.json";
export const INTERNAL_VITE_RUNTIME_MODULE_SOURCES_FILE =
  ".gcc-ts-bundler-vite-runtime-module-sources.json";
export const INTERNAL_VITE_AUTHORED_FILES_FILE =
  ".gcc-ts-bundler-vite-authored-files.json";
export const VITE_LANGUAGE_OUT_ERROR =
  "gccTsBundler() does not accept compiler.languageOut. Set Vite build.target instead.";

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
  config: ResolvedConfig;
  entries: string[];
  externs: string[];
  manifestFile: string;
  options: GccTsBundlerVitePluginOptions;
  outDir: string;
  projectRoot: string;
  publicPath: string;
  srcDir: string;
}): BuildOptions {
  assertNoViteLanguageOut(input.options);
  assertValidViteChunkLoader(input.options);
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
    languageOut: resolveViteLanguageOut(input.config),
    chunks: {
      ...compilerChunks,
      baseChunkName:
        compilerChunks.baseChunkName ??
        DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      loader: normalizeChunkLoader(
        input.options.runtime?.loader ??
          compilerChunks.loader ??
          DEFAULT_BUILD_OPTIONS.chunks.loader,
      ),
      manifestFile: input.manifestFile,
      mode: "bundler-runtime",
      publicPath: input.publicPath,
    },
  };
}

export function assertNoViteLanguageOut(
  options: GccTsBundlerVitePluginOptions,
) {
  if (
    !isRecord(options.compiler) ||
    !Object.hasOwn(options.compiler, "languageOut")
  ) {
    return;
  }
  throw new Error(VITE_LANGUAGE_OUT_ERROR);
}

export function assertValidViteChunkLoader(
  options: GccTsBundlerVitePluginOptions,
) {
  normalizeChunkLoader(
    options.runtime?.loader ?? DEFAULT_BUILD_OPTIONS.chunks.loader,
  );
}

export function resolveViteLanguageOut(config: ResolvedConfig): LanguageOut {
  const targets = normalizeViteTargets(config.build.target);
  if (targets.length === 0) {
    return "ECMASCRIPT6";
  }

  let resolvedLanguageOut: LanguageOut | null = null;
  for (const target of targets) {
    const mapped = mapSingleViteTarget(target);
    if (!mapped) {
      throw new Error(
        `gccTsBundler() could not derive a compiler output level from Vite build.target ${JSON.stringify(target)}. ` +
          'Use false, "esnext", "es3", "es5", "baseline-widely-available", or an "es2015+" target.',
      );
    }
    if (
      !resolvedLanguageOut ||
      languageOutRank(mapped) < languageOutRank(resolvedLanguageOut)
    ) {
      resolvedLanguageOut = mapped;
    }
  }

  return resolvedLanguageOut ?? "ECMASCRIPT6";
}

function normalizeViteTargets(
  target: ResolvedConfig["build"]["target"],
): Array<string | false> {
  if (target === undefined) {
    return ["baseline-widely-available"];
  }
  return Array.isArray(target) ? [...target] : [target];
}

function mapSingleViteTarget(target: string | false): LanguageOut | null {
  if (target === false) {
    return "ECMASCRIPT_NEXT";
  }
  const normalized = target.trim().toLowerCase();
  if (normalized === "esnext") {
    return "ECMASCRIPT_NEXT";
  }
  if (normalized === "es3") {
    return "ECMASCRIPT3";
  }
  if (normalized === "es5") {
    return "ECMASCRIPT5";
  }
  if (normalized === "baseline-widely-available") {
    return "ECMASCRIPT6";
  }
  if (/^es20(?:1[5-9]|[2-9]\d)$/u.test(normalized)) {
    return "ECMASCRIPT6";
  }
  return null;
}

function languageOutRank(languageOut: LanguageOut) {
  switch (languageOut) {
    case "ECMASCRIPT3":
      return 0;
    case "ECMASCRIPT5":
      return 1;
    case "ECMASCRIPT6":
      return 2;
    case "ECMASCRIPT_NEXT":
      return 3;
  }
}
