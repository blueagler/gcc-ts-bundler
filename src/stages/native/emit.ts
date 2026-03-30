import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight, NormalizedBuildOptions } from "../../api/types";
import { transpileSources } from "../../native/load";

export interface NativeEmitStageResult {
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
}

interface NativeEmitMetadata {
  emittedFiles: string[];
  externsPath: string;
}

export async function emitNativeStage({
  cacheDir,
  fileNames,
  metadataPath,
  options,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  fileNames: string[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "modules-externs.js");
  const cachedMetadata = await readMetadata(metadataPath);
  if (
    cachedMetadata &&
    (await pathExists(cachedMetadata.externsPath)) &&
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

  const diagnostics = getPreflightDiagnostics({
    fileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir,
  });
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
    };
  }

  const result = transpileSources({
    externsPath,
    fileNames,
    outDir,
    workspaceDir,
  });

  await fs.promises.writeFile(
    metadataPath,
    JSON.stringify(
      {
        emittedFiles: result.emittedFiles,
        externsPath: result.externsPath,
      } satisfies NativeEmitMetadata,
      null,
      2,
    ),
    "utf-8",
  );

  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
  };
}

function getPreflightDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
  workspaceDir: string;
}): ts.Diagnostic[] {
  if (preflight === "off") {
    return [];
  }

  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const finalCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };

  if (preflight !== "full") {
    return [];
  }

  const compilerHost = ts.createCompilerHost(finalCompilerOptions);
  const program = ts.createProgram(
    fileNames,
    finalCompilerOptions,
    compilerHost,
  );
  return [...ts.getPreEmitDiagnostics(program)];
}

function loadCompilerOptions(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    {},
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

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    return JSON.parse(raw) as NativeEmitMetadata;
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
