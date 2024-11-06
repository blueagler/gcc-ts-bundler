import fs from "fs";
import path from "path";
import ts from "typescript";

export function loadTscConfig(args: string[]): {
  errors: ts.Diagnostic[];
  fileNames: string[];
  options: ts.CompilerOptions;
} {
  const parsedCommandLine = ts.parseCommandLine(args);

  if (parsedCommandLine.errors.length > 0) {
    return { errors: parsedCommandLine.errors, fileNames: [], options: {} };
  }

  const tsFileArguments = parsedCommandLine.fileNames;
  const projectDir = parsedCommandLine.options.project || process.cwd();
  const configFileName = ts.findConfigFile(projectDir, (file) =>
    ts.sys.fileExists(file),
  );

  if (!configFileName) {
    return {
      errors: [
        {
          category: ts.DiagnosticCategory.Error,
          code: 0,
          file: undefined,
          length: undefined,
          messageText: "Cannot find tsconfig.json",
          start: undefined,
        },
      ],
      fileNames: [],
      options: {},
    };
  }

  const configFileText = fs.readFileSync(configFileName, "utf-8");
  const result = ts.parseConfigFileTextToJson(configFileName, configFileText);

  if (result.error) {
    return { errors: [result.error], fileNames: [], options: {} };
  }

  result.config.compilerOptions.rootDir = "./";
  result.config.compilerOptions.outDir = path.join(projectDir, "../.closured");
  result.config.compilerOptions.module = "CommonJS";
  result.config.compilerOptions.moduleResolution = "Node";
  result.config.compilerOptions.target = "ESNext";
  result.config.compilerOptions.skipLibCheck = true;
  result.config.exclude = [];
  result.config.include = [path.join(projectDir, "*.ts")];

  const configParseResult = ts.parseJsonConfigFileContent(
    result.config,
    ts.sys,
    projectDir,
    parsedCommandLine.options,
    configFileName,
  );

  if (configParseResult.errors.length > 0) {
    return { errors: configParseResult.errors, fileNames: [], options: {} };
  }

  const fileNames =
    tsFileArguments.length > 0 ? tsFileArguments : configParseResult.fileNames;

  return { errors: [], fileNames, options: configParseResult.options };
}
