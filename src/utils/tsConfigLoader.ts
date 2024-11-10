import fs from "fs";
import path from "path";
import ts from "typescript";
export async function loadTscConfig(args: string[]): Promise<{
  errors: ts.Diagnostic[];
  fileNames: string[];
  options: ts.CompilerOptions;
}> {
  const parsedCommandLine = ts.parseCommandLine(args);
  if (parsedCommandLine.errors.length > 0) {
    return { errors: parsedCommandLine.errors, fileNames: [], options: {} };
  }
  const tsFileArguments = parsedCommandLine.fileNames;
  const projectDir = parsedCommandLine.options.project || process.cwd();
  const possibleConfigFile = ts.findConfigFile(projectDir, ts.sys.fileExists);
  if (!possibleConfigFile) {
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
  const configFileText = fs.readFileSync(possibleConfigFile, "utf-8");
  const result = ts.parseConfigFileTextToJson(
    possibleConfigFile,
    configFileText,
  );
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
    possibleConfigFile,
  );
  if (configParseResult.errors.length > 0) {
    return { errors: configParseResult.errors, fileNames: [], options: {} };
  }
  const fileNames =
    tsFileArguments.length > 0 ? tsFileArguments : configParseResult.fileNames;
  if (fileNames.length > 0) {
    try {
      await validateFiles(fileNames);
    } catch (error) {
      return {
        errors: [
          {
            category: ts.DiagnosticCategory.Error,
            code: 0,
            file: undefined,
            length: undefined,
            messageText:
              error instanceof Error
                ? error.message
                : "Unknown error validating files",
            start: undefined,
          },
        ],
        fileNames: [],
        options: {},
      };
    }
  }
  return { errors: [], fileNames, options: configParseResult.options };
}
async function validateFiles(files: string[]): Promise<void> {
  const fileChecks = await Promise.all(
    files.map(async (file) => {
      try {
        await fs.promises.access(file);
        return { exists: true, file };
      } catch {
        return { exists: false, file };
      }
    }),
  );
  const nonExistentFiles = fileChecks
    .filter((check) => !check.exists)
    .map((check) => check.file);
  if (nonExistentFiles.length > 0) {
    throw new Error(`Files do not exist: ${nonExistentFiles.join(", ")}`);
  }
}
