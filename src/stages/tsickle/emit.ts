import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight, NormalizedBuildOptions } from "../../api/types";
import * as tsickle from "../../tsickle";
import { writeFileContent } from "../../utils/file-operations";

const MODULE_PREFIX = "_gcc_";

export interface TsickleStageResult {
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
}

interface TsickleCacheMetadata {
  emittedFiles: string[];
  externsPath: string;
}

export async function emitTsickleStage({
  cacheDir,
  compilerOptions,
  fileNames,
  metadataPath,
  options,
  workspaceDir,
}: {
  cacheDir: string;
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  workspaceDir: string;
}): Promise<TsickleStageResult> {
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readTsickleMetadata(metadataPath);
  if (
    cachedMetadata &&
    (await pathExists(externsPath)) &&
    (await Promise.all(cachedMetadata.emittedFiles.map(pathExists))).every(
      Boolean,
    )
  ) {
    return {
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
    };
  }

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const finalCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    outDir,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };

  const compilerHost = ts.createCompilerHost(finalCompilerOptions);
  const program = ts.createProgram(
    fileNames,
    finalCompilerOptions,
    compilerHost,
  );
  const preflightDiagnostics = getPreflightDiagnostics(
    program,
    options.diagnostics.preflight,
  );
  if (preflightDiagnostics.length > 0) {
    return {
      diagnostics: preflightDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
    };
  }

  const filesToProcess = new Set(
    fileNames.map((fileName) => path.resolve(fileName)),
  );
  const moduleNameCache = new Map<string, string>();
  const moduleIdCache = new Map<string, string>();
  const writePromises: Promise<void>[] = [];
  const asyncWriteFile: ts.WriteFileCallback = (
    fileName: string,
    content: string,
  ) => {
    writePromises.push(writeFileContent(fileName, content));
  };
  const transformerHost: tsickle.TsickleHost = {
    addDtsClutzAliases: false,
    fileNameToModuleId: (fileName) => {
      const cached = moduleIdCache.get(fileName);
      if (cached) {
        return cached;
      }

      const value =
        MODULE_PREFIX +
        path.relative(workspaceDir, fileName).replace(/\\/g, "/");
      moduleIdCache.set(fileName, value);
      return value;
    },
    generateExtraSuppressions: false,
    generateSummary: false,
    generateTsMigrationExportsShim: false,
    googmodule: true,
    logWarning: (warning) => {
      if (options.diagnostics.verbose) {
        console.error(
          ts.formatDiagnosticsWithColorAndContext([warning], compilerHost),
        );
      } else {
        console.error(
          ts.flattenDiagnosticMessageText(warning.messageText, "\n"),
        );
      }
    },
    options: finalCompilerOptions,
    pathToModuleName: (context, fileName) => {
      const cacheKey = `${context}::${fileName}`;
      const cached = moduleNameCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const value =
        fileName === "tslib"
          ? "tslib"
          : MODULE_PREFIX +
            tsickle.pathToModuleName(workspaceDir, context, fileName);
      moduleNameCache.set(cacheKey, value);
      return value;
    },
    provideExternalModuleDtsNamespace: true,
    rootDirsRelative: (fileName) => fileName,
    shouldIgnoreWarningsForPath: () => !options.diagnostics.fatalWarnings,
    shouldSkipTsickleProcessing: (fileName) =>
      !filesToProcess.has(path.resolve(fileName)),
    transformDecorators: true,
    transformDynamicImport: "closure",
    transformTypesToClosure: true,
    typeBlackListPaths: new Set(),
    untyped: false,
    useDeclarationMergingTransformation: true,
  };

  const result = tsickle.emit(program, transformerHost, asyncWriteFile);
  await Promise.all(writePromises);
  if (result.diagnostics.length > 0) {
    return {
      diagnostics: [...result.diagnostics],
      emitSkipped: result.emitSkipped,
      emittedFiles: [],
      externsPath,
      outDir,
    };
  }

  await writeFileContent(
    externsPath,
    tsickle.getGeneratedExterns(
      result.externs,
      finalCompilerOptions.rootDir || "",
    ),
  );

  const emittedFiles = await collectJavaScriptFiles(outDir);
  await writeFileContent(
    metadataPath,
    JSON.stringify(
      {
        emittedFiles,
        externsPath,
      } satisfies TsickleCacheMetadata,
      null,
      2,
    ),
  );

  return {
    diagnostics: [...result.diagnostics],
    emitSkipped: result.emitSkipped,
    emittedFiles,
    externsPath,
    outDir,
  };
}

function getPreflightDiagnostics(
  program: ts.Program,
  preflight: DiagnosticsPreflight,
): ts.Diagnostic[] {
  if (preflight === "off") {
    return [];
  }

  if (preflight === "full") {
    return [...ts.getPreEmitDiagnostics(program)];
  }

  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
}

async function collectJavaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pendingDirs = [dir];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop()!;
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
        continue;
      }

      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function readTsickleMetadata(
  metadataPath: string,
): Promise<null | TsickleCacheMetadata> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    return JSON.parse(raw) as TsickleCacheMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
