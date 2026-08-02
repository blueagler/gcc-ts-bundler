import crypto from "crypto";
import fs from "fs";
import path from "path";
import ts from "@typescript/typescript6";

import type { CompatClassMapCall, DiagnosticsPreflight } from "../../api/types";
import { readJsonIfExists, writeJson } from "../../shared/cache-store";
import { uniqueSortedStrings } from "../../shared/files";
import {
  collectFileContentSnapshot,
  fileContentSnapshotMatches,
  type FileContentSnapshot,
} from "../../shared/file-state";
import { logInternalDetail, withInternalTiming } from "../../shared/timing";
import {
  arrayOf,
  isBoolean,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  optional,
  recordOf,
} from "../../shared/validation";
import type {
  BuildTypeMetadataSidecar,
  ChunkPlanChunk,
  ExternalBoundary,
  LazyImport,
  PackageAlias,
  PreservedImport,
  PreservedModule,
  ResolvedBuildOptions,
  ResolvedImport,
} from "../types";
import { collectFileStates, transpileSources } from "../../native/load";
import type { NativeEmittedTypeMetadata } from "../../native/load";
import {
  type ClosureTypeMetadataFile,
  type TypeMetadataCounts,
  type TypeMetadataDiagnostic,
  collectNativeTypeMetadataFromContext,
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
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
}

interface NativeEmitMetadata {
  artifacts: FileContentSnapshot;
  chunkSignature: string;
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  optionsSignature: string;
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
  version: number;
}

const NATIVE_EMIT_METADATA_VERSION = 14;

/**
 * Hoisted bundler-runtime emission depends on chunk membership, so the native
 * emit cache must be invalidated when the chunk plan changes shape.
 */
function computeChunkSignature(
  chunkPlan: ChunkPlanChunk[],
  opaqueExternalSpecifiers: string[],
): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        chunks: chunkPlan.map((chunk) => ({
          files: chunk.files,
          name: chunk.name,
        })),
        opaqueExternalSpecifiers,
      }),
    )
    .digest("hex");
}

interface QuickScannedNativeFile {
  fileName: string;
  features: ReturnType<typeof classifyClosureIrSourceFile>;
  parseDiagnostics: ts.Diagnostic[];
}

export async function emitNativeStage({
  cacheDir,
  chunkPlan,
  externalBoundaries,
  fileNames,
  lazyImports,
  metadataPath,
  opaqueExternalSpecifiers,
  optionsSignature,
  options,
  packageAliases,
  packageJsonFiles,
  preservedModules,
  resolvedImports,
  tsxRuntimeSourceFiles,
  typeInferenceDisabled,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  chunkPlan: ChunkPlanChunk[];
  externalBoundaries: ExternalBoundary[];
  fileNames: string[];
  lazyImports: LazyImport[];
  metadataPath: string;
  opaqueExternalSpecifiers: string[];
  optionsSignature: string;
  options: ResolvedBuildOptions;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  resolvedImports: ResolvedImport[];
  tsxRuntimeSourceFiles: string[];
  typeInferenceDisabled: boolean;
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const usesPersistentCache = options.cache.mode === "persistent";
  const chunkSignature = computeChunkSignature(
    chunkPlan,
    opaqueExternalSpecifiers,
  );
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
    chunkSignature,
    dependencyModules,
    dependencyRuntimeFiles,
    metadataPath,
    optionsSignature,
    outDir: paths.outDir,
    runtimeModuleSourceMapFile:
      process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE || undefined,
    usesPersistentCache,
  });
  if (usesPersistentCache) {
    logInternalDetail("cache:native-emit", cachedResult ? "hit" : "miss");
  }
  if (cachedResult) {
    return cachedResult;
  }

  const missingInputDiagnostics = await getMissingInputDiagnostics({
    externFileNames: [...options.externs, ...options.typedExterns],
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
      preservedImports: [],
      supportFiles: [],
      typeMetadata: [],
      typeMetadataDependencies: {},
    };
  }

  await resetNativeEmitOutDir(paths.outDir);

  const analysis = options.typeMetadata
    ? analysisFromSidecar(options.typeMetadata, options.srcDir, workspaceDir)
    : await collectNativeAnalysis({
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
      preservedImports: [],
      supportFiles: [],
      typeMetadata: [],
      typeMetadataDependencies: {},
    };
  }
  const typeMetadataDependencies = await collectExistingContentSnapshot(
    analysis.dependencies,
  );
  logTypeMetadataCounts(
    "native-emit:type-metadata-extracted",
    analysis.extractedCounts,
    analysis.typeMetadataDiagnostics.length,
  );

  await fs.promises.writeFile(
    paths.metadataPathForNative,
    JSON.stringify(analysis.files, null, 2),
    "utf-8",
  );
  const result = await withInternalTiming("native-emit:transpile", () =>
    Promise.resolve(
      runNativeTranspile({
        chunkMode: options.chunks.mode,
        chunkPlan,
        classMapCalls: options.compat.classMapCalls,
        pureCallees: options.compat.pureCallees,
        combinedFileNames,
        externalBoundaries,
        explicitExternPaths: options.externs,
        externsPath: paths.externsPath,
        lazyImports,
        metadataPath: paths.metadataPathForNative,
        opaqueExternalSpecifiers,
        outDir: paths.outDir,
        packageAliases,
        packageJsonFiles,
        preservedModules,
        resolvedImports,
        target: options.target,
        typeInferenceDisabled,
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
  logDeliveredTypeMetadata(result.typeMetadata);

  if (usesPersistentCache) {
    await persistNativeEmitMetadata({
      artifacts: await collectFileContentSnapshot([
        result.externsPath,
        paths.metadataPathForNative,
        ...result.emittedFiles,
        ...finalSupportFiles,
        ...(process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE
          ? [process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE]
          : []),
      ]),
      chunkSignature,
      dependencyModules,
      dependencyRuntimeFiles,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath,
      optionsSignature,
      metadataPathForNative: paths.metadataPathForNative,
      preservedImports: result.preservedImports,
      supportFiles: finalSupportFiles,
      typeMetadata: result.typeMetadata,
      typeMetadataDependencies,
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
    preservedImports: result.preservedImports,
    supportFiles: finalSupportFiles,
    typeMetadata: result.typeMetadata,
    typeMetadataDependencies,
  };
}

async function collectNativeAnalysis({
  fileNames,
  options,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  options: ResolvedBuildOptions;
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
        collectNativeTypeMetadataFromContext({
          context: analysisContext,
          scan: analysisScan,
        }),
      ),
    );
    return {
      dependencies: collectAnalysisDependencies(
        analysisContext.program,
        fileNames,
        tsConfigPath,
      ),
      diagnostics: analysis.diagnostics,
      extractedCounts: analysis.extractedCounts,
      files: analysis.files,
      preflightDiagnostics,
      typeMetadataDiagnostics: analysis.typeMetadataDiagnostics,
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
    extractedCounts: TypeMetadataCounts;
    files: ClosureTypeMetadataFile[];
    typeMetadataDiagnostics: TypeMetadataDiagnostic[];
  } =
    analysisContext && analysisScan && checkerRequiredFileNames.length > 0
      ? await withInternalTiming("native-emit:closure-ir", () =>
          Promise.resolve(
            collectNativeTypeMetadataFromContext({
              context: analysisContext,
              scan: analysisScan,
            }),
          ),
        )
      : {
          diagnostics: [],
          extractedCounts: emptyTypeMetadataCounts(),
          files: [],
          typeMetadataDiagnostics: [],
        };
  const checkerFileMap = new Map(
    checkerAnalysis.files.map(
      (file): readonly [string, ClosureTypeMetadataFile] => [
        file.filePath,
        file,
      ],
    ),
  );

  return {
    dependencies: collectAnalysisDependencies(
      analysisContext?.program,
      fileNames,
      tsConfigPath,
    ),
    diagnostics: checkerAnalysis.diagnostics,
    extractedCounts: checkerAnalysis.extractedCounts,
    files: fileNames.map(
      (fileName) =>
        checkerFileMap.get(fileName) ?? createTrivialTypeMetadataFile(fileName),
    ),
    preflightDiagnostics,
    typeMetadataDiagnostics: checkerAnalysis.typeMetadataDiagnostics,
  };
}
function analysisFromSidecar(
  sidecar: BuildTypeMetadataSidecar,
  srcDir: string,
  workspaceDir: string,
) {
  const diagnostics: ts.Diagnostic[] = [];
  const preflightDiagnostics: ts.Diagnostic[] = [];
  return {
    dependencies: sidecar.dependencies,
    diagnostics,
    extractedCounts: sidecar.extractedCounts,
    files: sidecar.files.map((file) => ({
      ...file,
      filePath: remapMetadataFilePath(file.filePath, srcDir, workspaceDir),
    })),
    preflightDiagnostics,
    typeMetadataDiagnostics: sidecar.diagnostics,
  };
}

function remapMetadataFilePath(
  filePath: string,
  srcDir: string,
  workspaceDir: string,
) {
  const relativePath = path.relative(srcDir, filePath);
  return relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
    ? path.join(workspaceDir, "src", relativePath)
    : filePath;
}

function collectAnalysisDependencies(
  program: ts.Program | undefined,
  fileNames: string[],
  tsConfigPath: string,
) {
  return uniqueSortedStrings([
    ...fileNames,
    tsConfigPath,
    ...(program?.getSourceFiles() ?? [])
      .filter((sourceFile) => !program?.isSourceFileDefaultLibrary(sourceFile))
      .map((sourceFile) => sourceFile.fileName),
  ]);
}

async function collectExistingContentSnapshot(filePaths: string[]) {
  const existing = collectFileStates(filePaths)
    .filter((state) => state.exists)
    .map((state) => state.filePath);
  return collectFileContentSnapshot(existing);
}

function emptyTypeMetadataCounts(): TypeMetadataCounts {
  return {
    annotationCount: 0,
    enumDeclarationCount: 0,
    memberAnnotationCount: 0,
    typeDeclarationCount: 0,
    unresolvedTypeReferenceCount: 0,
  };
}

function logTypeMetadataCounts(
  label: string,
  counts: TypeMetadataCounts,
  diagnostics: number,
) {
  logInternalDetail(
    label,
    `annotations=${counts.annotationCount} members=${counts.memberAnnotationCount} declarations=${counts.typeDeclarationCount} enums=${counts.enumDeclarationCount} unresolved=${counts.unresolvedTypeReferenceCount} diagnostics=${diagnostics}`,
  );
}

function logDeliveredTypeMetadata(metadata: NativeEmittedTypeMetadata[]) {
  const counts = emptyTypeMetadataCounts();
  let diagnostics = 0;
  for (const file of metadata) {
    counts.annotationCount += file.counts.annotationCount;
    counts.enumDeclarationCount += file.counts.enumDeclarationCount;
    counts.memberAnnotationCount += file.counts.memberAnnotationCount;
    counts.typeDeclarationCount += file.counts.typeDeclarationCount;
    counts.unresolvedTypeReferenceCount +=
      file.counts.unresolvedTypeReferenceCount;
    diagnostics += file.diagnostics.length;
  }
  logTypeMetadataCounts(
    "native-emit:type-metadata-delivered",
    counts,
    diagnostics,
  );
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
  optionsSignature,
  chunkSignature,
  dependencyModules,
  dependencyRuntimeFiles,
  metadataPath,
  outDir,
  runtimeModuleSourceMapFile,
  usesPersistentCache,
}: {
  optionsSignature: string;
  chunkSignature: string;
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  metadataPath: string;
  outDir: string;
  runtimeModuleSourceMapFile: string | undefined;
  usesPersistentCache: boolean;
}) {
  if (!usesPersistentCache) {
    return null;
  }

  const cachedMetadata = await readMetadata(metadataPath);
  if (
    !cachedMetadata ||
    cachedMetadata.optionsSignature !== optionsSignature ||
    cachedMetadata.chunkSignature !== chunkSignature ||
    !(await fileContentSnapshotMatches(cachedMetadata.artifacts, [
      cachedMetadata.externsPath,
      cachedMetadata.metadataPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
      ...(runtimeModuleSourceMapFile ? [runtimeModuleSourceMapFile] : []),
    ])) ||
    !(await fileContentSnapshotMatches(cachedMetadata.typeMetadataDependencies))
  ) {
    return null;
  }

  logDeliveredTypeMetadata(cachedMetadata.typeMetadata);
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
    preservedImports: cachedMetadata.preservedImports,
    supportFiles: cachedMetadata.supportFiles,
    typeMetadata: cachedMetadata.typeMetadata,
    typeMetadataDependencies: cachedMetadata.typeMetadataDependencies,
  } satisfies NativeEmitStageResult;
}

async function resetNativeEmitOutDir(outDir: string) {
  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });
}

function runNativeTranspile({
  chunkMode,
  chunkPlan,
  classMapCalls,
  pureCallees,
  combinedFileNames,
  externalBoundaries,
  explicitExternPaths,
  externsPath,
  lazyImports,
  metadataPath,
  opaqueExternalSpecifiers,
  outDir,
  packageAliases,
  packageJsonFiles,
  preservedModules,
  resolvedImports,
  target,
  typeInferenceDisabled,
  workspaceDir,
}: {
  chunkMode: string;
  chunkPlan: ChunkPlanChunk[];
  classMapCalls: CompatClassMapCall[];
  pureCallees: string[];
  combinedFileNames: string[];
  externalBoundaries: ExternalBoundary[];
  explicitExternPaths: string[];
  externsPath: string;
  lazyImports: LazyImport[];
  metadataPath: string;
  opaqueExternalSpecifiers: string[];
  outDir: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  resolvedImports: ResolvedImport[];
  target: string;
  typeInferenceDisabled: boolean;
  workspaceDir: string;
}) {
  return transpileSources({
    chunkGraph: chunkPlan.map((chunk) => ({
      dependencies: chunk.dependencies,
      files: chunk.files,
      name: chunk.name,
    })),
    chunkMode,
    classMapCalls,
    pureCallees,
    explicitExternPaths,
    externalBoundaries,
    metadataPath,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    opaqueExternalSpecifiers,
    outDir,
    packageAliases,
    packageJsonFiles,
    preservedModules,
    resolvedImports,
    runtimeModuleSourceMapFile:
      process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE || undefined,
    target,
    typeInferenceDisabled,
    workspaceDir,
  });
}

async function persistNativeEmitMetadata({
  artifacts,
  chunkSignature,
  dependencyModules,
  dependencyRuntimeFiles,
  emittedFiles,
  externsPath,
  metadataPath,
  optionsSignature,
  metadataPathForNative,
  preservedImports,
  supportFiles,
  typeMetadata,
  typeMetadataDependencies,
}: {
  artifacts: FileContentSnapshot;
  chunkSignature: string;
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  optionsSignature: string;
  metadataPathForNative: string;
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
}) {
  await writeJson(metadataPath, {
    artifacts,
    chunkSignature,
    dependencyModules,
    dependencyRuntimeFiles,
    emittedFiles,
    externsPath,
    metadataPath: metadataPathForNative,
    optionsSignature,
    preservedImports,
    supportFiles,
    typeMetadata,
    typeMetadataDependencies,
    version: NATIVE_EMIT_METADATA_VERSION,
  } satisfies NativeEmitMetadata);
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
  const parsed = await readJsonIfExists(metadataPath, isNativeEmitMetadata);
  return parsed?.version === NATIVE_EMIT_METADATA_VERSION ? parsed : null;
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

function createTrivialTypeMetadataFile(
  filePath: string,
): ClosureTypeMetadataFile {
  return {
    annotations: [],
    declarations: [],
    decoratedOutputText: undefined,
    diagnostics: [],
    enums: [],
    filePath,
    sourceFilePath: filePath,
    symbols: [],
  };
}

function resolveScriptKind(fileName: string) {
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

const isContentIdentity = isObjectOf<FileContentSnapshot[string]>({
  digest: isString,
  size: isNumber,
});

const isNativeTypeMetadataCounts = isObjectOf<
  NativeEmittedTypeMetadata["counts"]
>({
  annotationCount: isNumber,
  enumDeclarationCount: isNumber,
  memberAnnotationCount: isNumber,
  typeDeclarationCount: isNumber,
  unresolvedTypeReferenceCount: isNumber,
});

const isNativeTypeMetadataDiagnostic = isObjectOf<
  NativeEmittedTypeMetadata["diagnostics"][number]
>({
  declarationFilePath: optional(isString),
  phase: isString,
  reason: isString,
  sourceFilePath: isString,
  symbolId: optional(isString),
  symbolName: optional(isString),
  target: optional(isString),
});

const isNativeEmittedTypeMetadata = isObjectOf<NativeEmittedTypeMetadata>({
  counts: isNativeTypeMetadataCounts,
  diagnostics: arrayOf(isNativeTypeMetadataDiagnostic),
  emittedFile: isString,
  hasTypeMetadata: isBoolean,
});

const isPreservedImport = isObjectOf<PreservedImport>({
  boundaryExports: isStringArray,
  boundaryNames: isStringArray,
  externalSpecifier: optional(isString),
  importClause: isString,
  importerFilePath: isString,
  targetModuleId: isString,
});

const isNativeEmitMetadata = isObjectOf<NativeEmitMetadata>({
  artifacts: recordOf(isContentIdentity),
  chunkSignature: isString,
  dependencyModules: isStringArray,
  dependencyRuntimeFiles: isStringArray,
  emittedFiles: isStringArray,
  externsPath: isString,
  metadataPath: isString,
  optionsSignature: isString,
  preservedImports: arrayOf(isPreservedImport),
  supportFiles: isStringArray,
  typeMetadata: arrayOf(isNativeEmittedTypeMetadata),
  typeMetadataDependencies: recordOf(isContentIdentity),
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
