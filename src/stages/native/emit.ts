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

  const finalCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
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
  const diagnostics = getPreflightDiagnostics(
    program,
    options.diagnostics.preflight,
  );
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
