import fs from "fs";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { uniqueSortedStrings } from "../../internal/files";
import { filesExist } from "../../internal/file-state";
import { logInternalDetail, withInternalTiming } from "../../internal/timing";
import {
  LazyImport,
  NormalizedBuildOptions,
  PackageAlias,
} from "../../internal/types";
import { collectFileStates, transpileSources } from "../../native/load";
import {
  collectNativeClosureIrFromContext,
  collectNativePreflightDiagnosticsFromContext,
  createNativeTypeAnalysisContext,
  scanNativeTypeAnalysisContext,
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

const NATIVE_EMIT_METADATA_VERSION = 8;

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
  const paths = createNativeEmitPaths({
    cacheDir,
    tsxRuntimeSourceFiles,
    workspaceDir,
  });
  const combinedFileNames = uniqueSortedStrings([
    ...fileNames,
    ...tsxRuntimeSourceFiles,
  ]);
  const dependencyModules = collectDependencyModules(packageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir: paths.outDir,
    sourceFiles: combinedFileNames,
    workspaceDir,
  });

  const cachedResult = await restoreCachedNativeEmitResult({
    dependencyModules,
    dependencyRuntimeFiles,
    metadataPath,
    outDir: paths.outDir,
    usesPersistentCache,
  });
  if (cachedResult) {
    return cachedResult;
  }

  const missingInputDiagnostics = await getMissingInputDiagnostics({
    externFileNames: options.externs,
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
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      supportFiles: [],
    };
  }

  await resetNativeEmitOutDir(paths.outDir);

  const analysisContext = await withInternalTiming(
    "native-emit:analysis-context",
    () =>
      createNativeTypeAnalysisContext({
        fileNames: combinedFileNames,
        tsConfigPath,
        workspaceDir,
      }),
  );
  const analysisScan = await withInternalTiming(
    "native-emit:analysis-scan",
    () =>
      Promise.resolve(
        scanNativeTypeAnalysisContext({ context: analysisContext }),
      ),
  );
  const preflightDiagnostics = await withInternalTiming(
    "native-emit:preflight",
    () =>
      Promise.resolve(
        collectNativePreflightDiagnosticsFromContext({
          context: analysisContext,
          preflight: options.diagnostics.preflight,
          scan: analysisScan,
        }),
      ),
  );
  const analysis = await withInternalTiming("native-emit:closure-ir", () =>
    Promise.resolve(
      collectNativeClosureIrFromContext({
        context: analysisContext,
        scan: analysisScan,
      }),
    ),
  );
  const analysisDiagnostics = [
    ...preflightDiagnostics,
    ...analysis.diagnostics,
  ];
  if (analysisDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysisDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      supportFiles: [],
    };
  }

  await fs.promises.writeFile(
    paths.metadataPathForNative,
    JSON.stringify(analysis.files, null, 2),
    "utf-8",
  );
  const result = await withInternalTiming("native-emit:transpile", () =>
    Promise.resolve(
      runNativeTranspile({
        chunkMode: options.chunks.mode,
        combinedFileNames,
        explicitExternPaths: options.externs,
        externsPath: paths.externsPath,
        lazyImports,
        metadataPath: paths.metadataPathForNative,
        outDir: paths.outDir,
        packageAliases,
        packageJsonFiles,
        workspaceDir,
      }),
    ),
  );
  const finalSupportFiles = uniqueSortedStrings([
    ...paths.runtimeSupportFiles,
    ...result.supportFiles,
  ]);
  logInternalDetail(
    "native-emit:extern-preserved-properties",
    `${result.explicitExternPropertyCount}`,
  );

  if (usesPersistentCache) {
    await persistNativeEmitMetadata({
      dependencyModules,
      dependencyRuntimeFiles,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath,
      metadataPathForNative: paths.metadataPathForNative,
      supportFiles: finalSupportFiles,
    });
  }

  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir: paths.outDir,
    supportFiles: finalSupportFiles,
  };
}

function createNativeEmitPaths({
  cacheDir,
  tsxRuntimeSourceFiles,
  workspaceDir,
}: {
  cacheDir: string;
  tsxRuntimeSourceFiles: string[];
  workspaceDir: string;
}) {
  const outDir = path.join(cacheDir, "out");
  return {
    externsPath: path.join(cacheDir, "native-generated.externs.js"),
    metadataPathForNative: path.join(cacheDir, "closure-ir.json"),
    outDir,
    runtimeSupportFiles: tsxRuntimeSourceFiles.map((fileName) =>
      toEmittedPath(fileName, outDir, workspaceDir),
    ),
  };
}

async function restoreCachedNativeEmitResult({
  dependencyModules,
  dependencyRuntimeFiles,
  metadataPath,
  outDir,
  usesPersistentCache,
}: {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  metadataPath: string;
  outDir: string;
  usesPersistentCache: boolean;
}) {
  if (!usesPersistentCache) {
    return null;
  }

  const cachedMetadata = await readMetadata(metadataPath);
  if (
    !cachedMetadata ||
    !(await filesExist([
      cachedMetadata.externsPath,
      cachedMetadata.metadataPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
    ]))
  ) {
    return null;
  }

  return {
    dependencyModules:
      cachedMetadata.dependencyModules.length > 0
        ? cachedMetadata.dependencyModules
        : dependencyModules,
    dependencyRuntimeFiles:
      cachedMetadata.dependencyRuntimeFiles.length > 0
        ? cachedMetadata.dependencyRuntimeFiles
        : dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: cachedMetadata.emittedFiles,
    externsPath: cachedMetadata.externsPath,
    outDir,
    supportFiles: cachedMetadata.supportFiles,
  } satisfies NativeEmitStageResult;
}

async function resetNativeEmitOutDir(outDir: string) {
  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });
}

function runNativeTranspile({
  chunkMode,
  combinedFileNames,
  explicitExternPaths,
  externsPath,
  lazyImports,
  metadataPath,
  outDir,
  packageAliases,
  packageJsonFiles,
  workspaceDir,
}: {
  chunkMode: string;
  combinedFileNames: string[];
  explicitExternPaths: string[];
  externsPath: string;
  lazyImports: LazyImport[];
  metadataPath: string;
  outDir: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  workspaceDir: string;
}) {
  return transpileSources({
    chunkMode,
    explicitExternPaths,
    metadataPath,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases,
    packageJsonFiles,
    workspaceDir,
  });
}

async function persistNativeEmitMetadata({
  dependencyModules,
  dependencyRuntimeFiles,
  emittedFiles,
  externsPath,
  metadataPath,
  metadataPathForNative,
  supportFiles,
}: {
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  metadataPathForNative: string;
  supportFiles: string[];
}) {
  await fs.promises.writeFile(
    metadataPath,
    JSON.stringify(
      {
        dependencyModules,
        dependencyRuntimeFiles,
        emittedFiles,
        externsPath,
        metadataPath: metadataPathForNative,
        supportFiles,
        version: NATIVE_EMIT_METADATA_VERSION,
      } satisfies NativeEmitMetadata,
      null,
      2,
    ),
    "utf-8",
  );
}

async function getMissingInputDiagnostics({
  externFileNames,
  fileNames,
  preflight,
  tsConfigPath,
}: {
  externFileNames: string[];
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
}): Promise<ts.Diagnostic[]> {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([
    tsConfigPath,
    ...fileNames,
    ...externFileNames,
  ]);
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
