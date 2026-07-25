import fs from "fs";
import path from "path";
import ts from "typescript";

import type { DiagnosticsPreflight } from "../../api/types";
import { uniqueSortedStrings } from "../../internal/files";
import { filesExist } from "../../internal/file-state";
import { logInternalDetail, withInternalTiming } from "../../internal/timing";
import {
  hasErrorCode,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  parseJson,
} from "../../internal/validation";
import type {
  LazyImport,
  NormalizedBuildOptions,
  PackageAlias,
} from "../../internal/types";
import { collectFileStates, transpileSources } from "../../native/load";
import {
  type ClosureIrFileMetadata,
  collectNativeClosureIrFromContext,
  createNativeTypeAnalysisContext,
  scanNativeTypeAnalysisContext,
} from "./closure-ir";
import { classifyClosureIrSourceFile } from "./closure-ir/metadata/scan";
import {
  collectNativePreflightDiagnostics,
  loadViteAuthoredFiles,
} from "./closure-ir/preflight";

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

interface QuickScannedNativeFile {
  fileName: string;
  features: ReturnType<typeof classifyClosureIrSourceFile>;
  parseDiagnostics: ts.Diagnostic[];
}

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
  if (usesPersistentCache) {
    logInternalDetail("cache:native-emit", cachedResult ? "hit" : "miss");
  }
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

  const analysis = await collectNativeAnalysis({
    fileNames: combinedFileNames,
    options,
    tsConfigPath,
    workspaceDir,
  });
  const analysisDiagnostics = [
    ...analysis.preflightDiagnostics,
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

async function collectNativeAnalysis({
  fileNames,
  options,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  options: NormalizedBuildOptions;
  tsConfigPath: string;
  workspaceDir: string;
}) {
  if (!canUseJsAnalysisFastPath(fileNames)) {
    const analysisContext = await withInternalTiming(
      "native-emit:analysis-context",
      () =>
        createNativeTypeAnalysisContext({
          fileNames,
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
          collectNativePreflightDiagnostics({
            preflight: options.diagnostics.preflight,
            program: analysisContext.program,
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
    return {
      diagnostics: analysis.diagnostics,
      files: analysis.files,
      preflightDiagnostics,
    };
  }

  const authoredFiles = loadViteAuthoredFiles();
  const quickScanFiles = await withInternalTiming(
    "native-emit:quick-scan",
    () => scanNativeFilesQuickly(fileNames),
  );
  const checkerRequiredFileNames = quickScanFiles
    .filter(
      ({ features, fileName }) =>
        features.shouldAnalyze ||
        (features.needsSemanticPreflight &&
          (authoredFiles ? authoredFiles.has(fileName) : true)),
    )
    .map(({ fileName }) => fileName);
  const checkerRequiredFileSet = new Set(checkerRequiredFileNames);
  const trivialJsFiles = quickScanFiles.filter(
    ({ fileName }) => !checkerRequiredFileSet.has(fileName),
  );
  logInternalDetail(
    "native-emit:checker-required-files",
    `${checkerRequiredFileNames.length}`,
  );
  logInternalDetail("native-emit:trivial-js-files", `${trivialJsFiles.length}`);

  const analysisContext =
    checkerRequiredFileNames.length > 0 ||
    options.diagnostics.preflight !== "off"
      ? await withInternalTiming("native-emit:analysis-context", () =>
          createNativeTypeAnalysisContext({
            fileNames: checkerRequiredFileNames,
            tsConfigPath,
            workspaceDir,
          }),
        )
      : null;
  const analysisScan = analysisContext
    ? await withInternalTiming("native-emit:analysis-scan", () =>
        Promise.resolve(
          scanNativeTypeAnalysisContext({ context: analysisContext }),
        ),
      )
    : null;
  if (!analysisScan) {
    logInternalDetail(
      "native-emit:analysis-scan:files",
      `0/${quickScanFiles.length}`,
    );
  }
  const preflightDiagnostics =
    analysisContext && analysisScan
      ? await withInternalTiming("native-emit:preflight", () =>
          Promise.resolve(
            collectNativePreflightDiagnostics({
              additionalSyntacticDiagnostics: quickScanFiles.flatMap(
                ({ parseDiagnostics }) => parseDiagnostics,
              ),
              authoredFiles,
              preflight: options.diagnostics.preflight,
              program: analysisContext.program,
              scan: analysisScan,
            }),
          ),
        )
      : [];

  const checkerAnalysis: {
    diagnostics: ts.Diagnostic[];
    files: ClosureIrFileMetadata[];
  } =
    analysisContext && analysisScan && checkerRequiredFileNames.length > 0
      ? await withInternalTiming("native-emit:closure-ir", () =>
          Promise.resolve(
            collectNativeClosureIrFromContext({
              context: analysisContext,
              scan: analysisScan,
            }),
          ),
        )
      : { diagnostics: [], files: [] };
  const checkerFileMap = new Map(
    checkerAnalysis.files.map(
      (file): readonly [string, ClosureIrFileMetadata] => [file.filePath, file],
    ),
  );

  return {
    diagnostics: checkerAnalysis.diagnostics,
    files: fileNames.map(
      (fileName) =>
        checkerFileMap.get(fileName) ?? createTrivialClosureIrFile(fileName),
    ),
    preflightDiagnostics,
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
    runtimeModuleSourceMapFile:
      process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE || undefined,
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
    const parsed = parseJson(raw, isNativeEmitMetadata, metadataPath);
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
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

async function scanNativeFilesQuickly(fileNames: string[]) {
  const files = await Promise.all(
    fileNames.map(async (fileName) => {
      const text = await fs.promises.readFile(fileName, "utf8");
      const sourceFile = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        true,
        resolveScriptKind(fileName),
      );
      return {
        features: classifyClosureIrSourceFile(sourceFile),
        fileName,
        parseDiagnostics: getSourceFileParseDiagnostics(sourceFile),
      } satisfies QuickScannedNativeFile;
    }),
  );
  return files;
}

function canUseJsAnalysisFastPath(fileNames: string[]) {
  if (!process.env.GCC_VITE_AUTHORED_FILES_FILE) {
    return false;
  }
  return fileNames.every((fileName) => /\.(?:[cm]?jsx?)$/u.test(fileName));
}

function createTrivialClosureIrFile(filePath: string): ClosureIrFileMetadata {
  return {
    decoratedOutputText: undefined,
    enumDeclarations: [],
    filePath,
    topLevelDocs: [],
    typeDeclarations: [],
  };
}

function resolveScriptKind(fileName: string) {
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

const isNativeEmitMetadata = isObjectOf<NativeEmitMetadata>({
  dependencyModules: isStringArray,
  dependencyRuntimeFiles: isStringArray,
  emittedFiles: isStringArray,
  externsPath: isString,
  metadataPath: isString,
  supportFiles: isStringArray,
  version: isNumber,
});

function getSourceFileParseDiagnostics(sourceFile: ts.SourceFile) {
  return hasParseDiagnostics(sourceFile)
    ? [...sourceFile.parseDiagnostics]
    : [];
}

function hasParseDiagnostics(
  sourceFile: ts.SourceFile,
): sourceFile is ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
} {
  return (
    "parseDiagnostics" in sourceFile &&
    Array.isArray(sourceFile.parseDiagnostics)
  );
}
