import fs from "fs";
import path from "path";
import ts from "typescript";

import { hashJson } from "../../cache/hash";
import { getPackageRootFromBundle } from "../../internal/bundle-location";

const RUNTIME_SPECIFIER = "gcc-ts-bundler/runtime";
const PACKAGE_ROOT = getPackageRootFromBundle();
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
  const runtimePaths = (await shouldInjectRuntimePaths(configDir))
    ? {
        [RUNTIME_SPECIFIER]: [path.join(PACKAGE_ROOT, "src", "runtime", "index.ts")],
      }
    : {};
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    configDir,
    {
      ...extraOptions,
      baseUrl:
        extraOptions.baseUrl ??
        configFile.config.compilerOptions?.baseUrl ??
        configDir,
      ignoreDeprecations:
        extraOptions.ignoreDeprecations ??
        configFile.config.compilerOptions?.ignoreDeprecations ??
        "6.0",
      paths: {
        ...(configFile.config.compilerOptions?.paths ?? {}),
        ...(extraOptions.paths ?? {}),
        ...runtimePaths,
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

async function shouldInjectRuntimePaths(configDir: string) {
  let currentDir = configDir;

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    try {
      const raw = await fs.promises.readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as { name?: string };
      return parsed.name === "gcc-ts-bundler";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return false;
    }

    currentDir = parentDir;
  }
}
