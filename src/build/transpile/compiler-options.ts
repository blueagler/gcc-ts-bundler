import fs from "fs";
import path from "path";
import ts from "typescript";

import { hashJson } from "../../shared/hash";
import {
  isRecord,
  isRecordOf,
  isString,
  isStringArray,
} from "../../shared/validation";

const compilerOptionsCache = new Map<string, ts.CompilerOptions>();

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
