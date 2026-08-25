import crypto from "crypto";
import { builtinModules } from "module";
import ts from "@typescript/typescript6";

import { writeJson } from "../../shared/cache-store";
import { uniqueSortedStrings } from "../../shared/files";
import {
  collectFileContentSnapshot,
  type FileContentSnapshot,
} from "../../shared/file-state";
import { logInternalDetail, withInternalTiming } from "../../shared/timing";
import type {
  BuildEntry,
  ChunkPlanChunk,
  ExternalBoundary,
  LazyImport,
  PackageAlias,
  PreservedImport,
  PreservedModule,
  ResolvedBuildOptions,
  ResolvedImport,
} from "../types";
import type { NativeEmittedTypeMetadata } from "../../native/load";
import type { TypeWorld } from "../../externs/context";
import {
  analysisFromSidecar,
  collectExistingContentSnapshot,
  collectNativeAnalysis,
  createNativeEmitPaths,
  getMissingInputDiagnostics,
  logDeliveredTypeMetadata,
  logTypeMetadataCounts,
  persistNativeEmitMetadata,
  resetNativeEmitOutDir,
  restoreCachedNativeEmitResult,
  runNativeTranspile,
  toNativeTypeMetadataFile,
} from "./emit-native";

export interface NativeEmitStageResult {
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
  warnings: string[];
}

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

export async function emitNativeStage({
  cacheDir,
  chunkPlan,
  entryFiles,
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
  typeWorld,
}: {
  cacheDir: string;
  chunkPlan: ChunkPlanChunk[];
  entryFiles: BuildEntry[];
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
  typeWorld?: TypeWorld | undefined;
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

  const cachedResult = await restoreCachedNativeEmitResult({
    chunkSignature,
    metadataPath,
    optionsSignature,
    outDir: paths.outDir,
    runtimeModuleSourceMapFile: options.viteRuntimeSourceMapFile,
    usesPersistentCache,
  });
  if (cachedResult) {
    logDeliveredTypeMetadata(cachedResult.typeMetadata);
    logNamespaceWarnings(cachedResult.warnings);
  }
  if (usesPersistentCache) {
    logInternalDetail("cache:native-emit", cachedResult ? "hit" : "miss");
  }
  if (cachedResult) {
    return {
      ...cachedResult,
      preservedImports: withEntryPreservedImports(
        cachedResult.preservedImports,
        entryFiles,
        preservedModules,
      ),
    };
  }

  const missingInputDiagnostics = await getMissingInputDiagnostics({
    externFileNames: [...options.externs, ...options.typedExterns],
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      preservedImports: [],
      supportFiles: [],
      typeMetadata: [],
      typeMetadataDependencies: {},
      warnings: [],
    };
  }

  await resetNativeEmitOutDir(paths.outDir);

  const analysis = options.typeMetadata
    ? analysisFromSidecar(options.typeMetadata, options.srcDir, workspaceDir)
    : await collectNativeAnalysis({
        boundaryModuleFileNames: preservedModules.map(
          (module) => module.filePath,
        ),
        externalSpecifiers: uniqueSortedStrings([
          ...options.externals,
          ...externalBoundaries.map((boundary) => boundary.specifier),
          ...(options.target === "node" || options.target === "bun"
            ? builtinModules.flatMap((specifier) => [
                specifier,
                `node:${specifier}`,
              ])
            : []),
        ]),
        fileNames: combinedFileNames,
        options,
        tsConfigPath,
        typeWorld,
        workspaceDir,
      });
  const analysisDiagnostics = [
    ...analysis.preflightDiagnostics,
    ...analysis.diagnostics,
  ];
  if (analysisDiagnostics.length > 0) {
    return {
      diagnostics: analysisDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath: paths.externsPath,
      outDir: paths.outDir,
      preservedImports: [],
      supportFiles: [],
      typeMetadata: [],
      typeMetadataDependencies: {},
      warnings: [],
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

  await writeJson(
    paths.metadataPathForNative,
    analysis.files.map(toNativeTypeMetadataFile),
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
        runtimeModuleSourceMapFile: options.viteRuntimeSourceMapFile,
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
  logNamespaceWarnings(result.warnings);

  if (usesPersistentCache) {
    await persistNativeEmitMetadata({
      artifacts: await collectFileContentSnapshot([
        result.externsPath,
        paths.metadataPathForNative,
        ...result.emittedFiles,
        ...finalSupportFiles,
        ...(options.viteRuntimeSourceMapFile
          ? [options.viteRuntimeSourceMapFile]
          : []),
      ]),
      chunkSignature,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath,
      optionsSignature,
      metadataPathForNative: paths.metadataPathForNative,
      preservedImports: result.preservedImports,
      supportFiles: finalSupportFiles,
      typeMetadata: result.typeMetadata,
      typeMetadataDependencies,
      warnings: result.warnings,
    });
  }

  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir: paths.outDir,
    preservedImports: withEntryPreservedImports(
      result.preservedImports,
      entryFiles,
      preservedModules,
    ),
    supportFiles: finalSupportFiles,
    typeMetadata: result.typeMetadata,
    typeMetadataDependencies,
    warnings: result.warnings,
  };
}

function logNamespaceWarnings(warnings: readonly string[]) {
  for (const warning of warnings) {
    console.warn(`gcc-ts-bundler: ${warning}`);
  }
}

function withEntryPreservedImports(
  preservedImports: PreservedImport[],
  entryFiles: readonly BuildEntry[],
  preservedModules: readonly PreservedModule[],
): PreservedImport[] {
  return [
    ...preservedImports,
    ...entryFiles.flatMap((entry) => {
      const preserved = preservedModules.find(
        (module) => module.filePath === entry.sourcePath,
      );
      return preserved
        ? [
            {
              boundaryExports: [],
              boundaryNames: [],
              importClause: "",
              importerFilePath: entry.sourcePath,
              targetModuleId: preserved.moduleId,
            },
          ]
        : [];
    }),
  ];
}
