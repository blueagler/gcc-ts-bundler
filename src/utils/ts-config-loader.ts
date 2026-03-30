import fs from "fs";
import ts from "typescript";

export interface TsConfigLoadOptions {
  args?: string[];
  configSearchDir?: string;
  outDir: string;
  projectDir: string;
  rootDir?: string;
}

export async function loadTscConfig({
  args = [],
  configSearchDir,
  outDir,
  projectDir,
  rootDir = "./",
}: TsConfigLoadOptions): Promise<{
  errors: ts.Diagnostic[];
  fileNames: string[];
  options: ts.CompilerOptions;
}> {
  const parsedCommandLine = ts.parseCommandLine(args);
  if (parsedCommandLine.errors.length > 0) {
    return { errors: parsedCommandLine.errors, fileNames: [], options: {} };
  }
  const tsFileArguments = parsedCommandLine.fileNames;
  const possibleConfigFile = ts.findConfigFile(
    configSearchDir ?? projectDir,
    (fileName: string) => ts.sys.fileExists(fileName),
  );
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
  const projectFiles = await collectProjectFiles(projectDir);
  result.config.compilerOptions.rootDir = rootDir;
  result.config.compilerOptions.outDir = outDir;
  result.config.compilerOptions.module = "CommonJS";
  result.config.compilerOptions.moduleResolution = "Node";
  result.config.compilerOptions.ignoreDeprecations = "6.0";
  result.config.compilerOptions.target = "ESNext";
  result.config.compilerOptions.skipLibCheck = true;
  result.config.exclude = [];
  result.config.files = projectFiles;
  result.config.include = [];
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

async function collectProjectFiles(projectDir: string): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs = [projectDir];
  const allowedExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop()!;
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.name === "node_modules") {
        continue;
      }

      const entryPath = ts.sys.resolvePath(`${currentDir}/${entry.name}`);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }

      if (
        allowedExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))
      ) {
        files.push(entryPath);
      }
    }
  }

  return files;
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
