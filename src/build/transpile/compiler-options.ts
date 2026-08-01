import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import { hashJson } from "../../shared/hash";
import {
  isRecord,
  isRecordOf,
  isString,
  isStringArray,
} from "../../shared/validation";

const compilerOptionsCache = new Map<string, ts.CompilerOptions>();
const declarationFileCache = new Map<string, string[]>();

/**
 * The `.d.ts` files this tsconfig puts in the program via `files`/`include`.
 *
 * Ambient declarations are global by design and imported by nobody, so they
 * never appear in the module graph. `tsc` still type-checks against them
 * because it seeds the program from the config, not from the import graph.
 * Reading them from the same parsed config the build already loads is how the
 * checker reaches parity with `tsc` — no heuristics, no name lists.
 *
 * Only declaration files are taken: implementation sources are reached through
 * the graph, and adding them would widen the analysis set rather than the
 * type-checking context.
 */
export async function loadTsConfigDeclarationFiles(configPath: string) {
  const configStat = await fs.promises.stat(configPath);
  const cacheKey = hashJson({
    configPath,
    kind: "declaration-files",
    mtimeMs: configStat.mtimeMs,
    size: configStat.size,
  });
  const cached = declarationFileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    // A malformed tsconfig is reported by `loadCompilerOptions`; parity is a
    // best-effort widening and must never be the thing that fails a build.
    declarationFileCache.set(cacheKey, []);
    return [];
  }
  const parsed = ts.parseJsonConfigFileContent(
    isRecord(configFile.config) ? configFile.config : {},
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const declarationFiles = parsed.fileNames
    .filter((fileName) => fileName.endsWith(".d.ts"))
    .map((fileName) => path.resolve(fileName))
    .sort();
  declarationFileCache.set(cacheKey, declarationFiles);
  return declarationFiles;
}

export async function loadCompilerOptions(
  configPath: string,
  extraOptions: ts.CompilerOptions = {},
) {
  const configStat = await fs.promises.stat(configPath);
  const cacheKey = hashJson({
    configPath,
    extraOptions,
    mtimeMs: configStat.mtimeMs,
    size: configStat.size,
  });
  const cached = compilerOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const configDir = path.dirname(configPath);
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const rawConfig: unknown = configFile.config;
  const config = isRecord(rawConfig) ? rawConfig : {};
  const compilerConfig = isRecord(config.compilerOptions)
    ? config.compilerOptions
    : {};
  const configuredBaseUrl = isString(compilerConfig.baseUrl)
    ? compilerConfig.baseUrl
    : undefined;
  const configuredIgnoreDeprecations = isString(
    compilerConfig.ignoreDeprecations,
  )
    ? compilerConfig.ignoreDeprecations
    : undefined;
  const configuredPaths = isRecordOf(compilerConfig.paths, isStringArray)
    ? compilerConfig.paths
    : {};
  const parsedConfig = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    configDir,
    {
      ...extraOptions,
      baseUrl: extraOptions.baseUrl ?? configuredBaseUrl ?? configDir,
      ignoreDeprecations:
        extraOptions.ignoreDeprecations ??
        configuredIgnoreDeprecations ??
        "6.0",
      paths: {
        ...configuredPaths,
        ...(extraOptions.paths ?? {}),
      },
    },
    configPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsedConfig.errors,
        ts.createCompilerHost({}),
      ),
    );
  }

  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
}
