import path from "path";
import ts from "typescript";
import { fileURLToPath } from "url";

const RUNTIME_SPECIFIER = "gcc-ts-bundler/runtime";
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

export function loadCompilerOptions(
  configPath: string,
  extraOptions: ts.CompilerOptions = {},
) {
  const configDir = path.dirname(configPath);
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
        [RUNTIME_SPECIFIER]: [path.join(PACKAGE_ROOT, "src", "runtime", "index.ts")],
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

  return parsedConfig.options;
}
