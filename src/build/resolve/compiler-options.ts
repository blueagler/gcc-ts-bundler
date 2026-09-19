import path from "path";
import ts from "@typescript/typescript6";

import { isRecord } from "../../shared/validation";

export interface ParsedTsConfig {
  configInputs: Record<string, string>;
  parsed: ts.ParsedCommandLine;
}

/** Parse afresh: inherited configs and newly included declarations are inputs too. */
export function parseTsConfig(
  configPath: string,
  explicitRootNames?: readonly string[],
): ParsedTsConfig {
  const configInputs: Record<string, string> = {};
  const readFile = (filePath: string) => {
    const resolvedPath = path.resolve(filePath);
    if (Object.hasOwn(configInputs, resolvedPath)) {
      return configInputs[resolvedPath];
    }
    const content = ts.sys.readFile(filePath);
    if (content !== undefined) configInputs[resolvedPath] = content;
    return content;
  };
  const config = ts.readConfigFile(configPath, readFile);
  if (config.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    );
  }
  const rawConfig = isRecord(config.config) ? config.config : {};
  const directoryInputs = new Map<string, string[]>();
  const host: ts.ParseConfigHost = {
    ...ts.sys,
    readFile,
    readDirectory(...args) {
      const key = JSON.stringify(args);
      const existing = directoryInputs.get(key);
      if (existing) return existing;
      const files = ts.sys.readDirectory(...args);
      directoryInputs.set(key, files);
      return files;
    },
  };
  // Resolve the config's own membership before adding graph roots. Supplying
  // files up front would replace inherited files and disable the default
  // include, losing unimported ambient declarations. TypeScript mutates raw.
  let parsed = ts.parseJsonConfigFileContent(
    { ...rawConfig },
    host,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (explicitRootNames?.length) {
    const files = rawConfig.files;
    // The bundler owns runtime roots, not tsconfig discovery. Validate that
    // actual combined input set rather than requiring a separate TS project.
    // Keep malformed files values intact so their diagnostics still survive.
    parsed = ts.parseJsonConfigFileContent(
      {
        ...rawConfig,
        ...(files === undefined ||
        (Array.isArray(files) &&
          files.every((file) => typeof file === "string"))
          ? { files: [...parsed.fileNames, ...explicitRootNames] }
          : {}),
      },
      host,
      path.dirname(configPath),
      undefined,
      configPath,
    );
  }
  if (parsed.errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsed.errors,
        ts.createCompilerHost({}),
      ),
    );
  }
  return { configInputs, parsed };
}

/** Ambient declarations belong to the program even when no module imports them. */
export async function loadTsConfigDeclarationFiles(
  configPath: string,
  tsConfig = parseTsConfig(configPath),
) {
  return tsConfig.parsed.fileNames
    .filter((fileName) => fileName.endsWith(".d.ts"))
    .map((fileName) => path.resolve(fileName))
    .sort();
}

export async function loadCompilerOptions(
  configPath: string,
  extraOptions: ts.CompilerOptions = {},
  tsConfig = parseTsConfig(configPath),
) {
  const { options } = tsConfig.parsed;
  return {
    ...options,
    ...extraOptions,
    baseUrl:
      extraOptions.baseUrl ?? options.baseUrl ?? path.dirname(configPath),
    ignoreDeprecations:
      extraOptions.ignoreDeprecations ?? options.ignoreDeprecations ?? "6.0",
    paths: { ...options.paths, ...extraOptions.paths },
  };
}
