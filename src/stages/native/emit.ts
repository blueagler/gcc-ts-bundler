import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { uniqueSortedStrings } from "../../internal/files";
import { filesExist } from "../../internal/file-state";
import { withInternalTiming } from "../../internal/timing";
import {
  LazyImport,
  NormalizedBuildOptions,
  PackageAlias,
} from "../../internal/types";
import { collectFileStates, transpileSources } from "../../native/load";
import {
  collectNativeTypeAnalysisFromContext,
  createNativeTypeAnalysisContext,
} from "./closure-ir";

export interface NativeEmitStageResult {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
  supportFiles: string[];
}

interface NativeEmitMetadata {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  supportFiles: string[];
  version: number;
}

const NATIVE_EMIT_METADATA_VERSION = 7;

export async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsxRuntimeSourceFiles,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  fileNames: string[];
  lazyImports: LazyImport[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  tsxRuntimeSourceFiles: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const usesPersistentCache = options.cache.mode === "persistent";
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "native-generated.externs.js");
  const metadataPathForNative = path.join(cacheDir, "closure-ir.json");
  const runtimeSupportFiles = tsxRuntimeSourceFiles.map((fileName) =>
    toEmittedPath(fileName, outDir, workspaceDir),
  );
  const combinedFileNames = uniqueSortedStrings([
    ...fileNames,
    ...tsxRuntimeSourceFiles,
  ]);
  const dependencyModules = collectDependencyModules(packageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir,
    sourceFiles: combinedFileNames,
    workspaceDir,
  });

  const cachedMetadata = usesPersistentCache
    ? await readMetadata(metadataPath)
    : null;
  if (
    cachedMetadata &&
    (await filesExist([
      cachedMetadata.externsPath,
      cachedMetadata.metadataPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
    ]))
  ) {
    return {
      dependencyModules: cachedMetadata.dependencyModules,
      dependencyRuntimeFiles: cachedMetadata.dependencyRuntimeFiles,
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles,
    };
  }

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const missingInputDiagnostics = await getMissingInputDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }

  const analysisContext = await withInternalTiming(
    "native-emit:analysis-context",
    () =>
      createNativeTypeAnalysisContext({
        fileNames: combinedFileNames,
        tsConfigPath,
        workspaceDir,
      }),
  );
  const analysis = await withInternalTiming("native-emit:closure-ir", () =>
    collectNativeTypeAnalysisFromContext({
      context: analysisContext,
      preflight: options.diagnostics.preflight,
    }),
  );
  if (analysis.diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysis.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }

  await fs.promises.writeFile(
    metadataPathForNative,
    JSON.stringify(analysis.files, null, 2),
    "utf-8",
  );
  const result = await withInternalTiming("native-emit:transpile", () =>
    Promise.resolve(
      transpileSources({
        chunkMode: options.chunks.mode,
        metadataPath: metadataPathForNative,
        externsPath,
        fileNames: combinedFileNames,
        lazyImports,
        outDir,
        packageAliases,
        packageJsonFiles,
        workspaceDir,
      }),
    ),
  );
  const finalSupportFiles = uniqueSortedStrings([
    ...runtimeSupportFiles,
    ...result.supportFiles,
  ]);

  if (usesPersistentCache) {
    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify(
        {
          dependencyModules,
          dependencyRuntimeFiles,
          emittedFiles: result.emittedFiles,
          externsPath: result.externsPath,
          metadataPath: metadataPathForNative,
          supportFiles: finalSupportFiles,
          version: NATIVE_EMIT_METADATA_VERSION,
        } satisfies NativeEmitMetadata,
        null,
        2,
      ),
      "utf-8",
    );
  }

  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles,
  };
}

async function getMissingInputDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
}): Promise<ts.Diagnostic[]> {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates
    .filter((state) => !state.exists)
    .map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(
        `Missing required build input(s): ${missingFiles.join(", ")}`,
      ),
    ];
  }

  return [];
}

function createSimpleDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined,
  };
}

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NativeEmitMetadata>;
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      dependencyModules: parsed.dependencyModules ?? [],
      dependencyRuntimeFiles: parsed.dependencyRuntimeFiles ?? [],
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      metadataPath: parsed.metadataPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function toEmittedPath(
  sourcePath: string,
  outDir: string,
  workspaceDir: string,
) {
  return path
    .join(outDir, path.relative(workspaceDir, sourcePath))
    .replace(/\.[^/.]+$/, ".js");
}

function collectDependencyModules(packageAliases: PackageAlias[]) {
  return uniqueSortedStrings(
    packageAliases
      .filter((alias) => isDependencyFile(alias.targetPath))
      .map((alias) =>
        alias.subpath === "."
          ? alias.packageName
          : `${alias.packageName}/${alias.subpath.replace(/^\.\//, "")}`,
      ),
  );
}

function collectDependencyRuntimeFiles({
  outDir,
  sourceFiles,
  workspaceDir,
}: {
  outDir: string;
  sourceFiles: string[];
  workspaceDir: string;
}) {
  return uniqueSortedStrings(
    sourceFiles
      .filter((filePath) => isDependencyFile(filePath))
      .map((filePath) => toEmittedPath(filePath, outDir, workspaceDir)),
  );
}

function isDependencyFile(filePath: string) {
  return path.resolve(filePath).includes(`${path.sep}node_modules${path.sep}`);
}
