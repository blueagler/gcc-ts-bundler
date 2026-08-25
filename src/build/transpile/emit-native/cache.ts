import fs from "fs";
import path from "path";

import { readJsonIfExists, writeJson } from "../../../shared/cache-store";
import {
  fileContentSnapshotMatches,
  type FileContentSnapshot,
} from "../../../shared/file-state";
import {
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  optional,
  recordOf,
} from "../../../shared/validation";
import type { PreservedImport } from "../../types";
import type { NativeEmittedTypeMetadata } from "../../../native/load";

interface NativeEmitMetadata {
  artifacts: FileContentSnapshot;
  chunkSignature: string;
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  optionsSignature: string;
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
  version: number;
  warnings: string[];
}

const NATIVE_EMIT_METADATA_VERSION = 17;

export function createNativeEmitPaths({
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
      path
        .join(outDir, path.relative(workspaceDir, fileName))
        .replace(/\.[^/.]+$/, ".js"),
    ),
  };
}

export async function restoreCachedNativeEmitResult({
  optionsSignature,
  chunkSignature,
  metadataPath,
  outDir,
  runtimeModuleSourceMapFile,
  usesPersistentCache,
}: {
  optionsSignature: string;
  chunkSignature: string;
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

  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: cachedMetadata.emittedFiles,
    externsPath: cachedMetadata.externsPath,
    outDir,
    preservedImports: cachedMetadata.preservedImports,
    supportFiles: cachedMetadata.supportFiles,
    typeMetadata: cachedMetadata.typeMetadata,
    typeMetadataDependencies: cachedMetadata.typeMetadataDependencies,
    warnings: cachedMetadata.warnings,
  };
}

export async function resetNativeEmitOutDir(outDir: string) {
  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });
}

export async function persistNativeEmitMetadata({
  artifacts,
  chunkSignature,
  emittedFiles,
  externsPath,
  metadataPath,
  optionsSignature,
  metadataPathForNative,
  preservedImports,
  supportFiles,
  typeMetadata,
  typeMetadataDependencies,
  warnings,
}: {
  artifacts: FileContentSnapshot;
  chunkSignature: string;
  emittedFiles: string[];
  externsPath: string;
  metadataPath: string;
  optionsSignature: string;
  metadataPathForNative: string;
  preservedImports: PreservedImport[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  typeMetadataDependencies: FileContentSnapshot;
  warnings: string[];
}) {
  await writeJson(metadataPath, {
    artifacts,
    chunkSignature,
    emittedFiles,
    externsPath,
    metadataPath: metadataPathForNative,
    optionsSignature,
    preservedImports,
    supportFiles,
    typeMetadata,
    typeMetadataDependencies,
    version: NATIVE_EMIT_METADATA_VERSION,
    warnings,
  } satisfies NativeEmitMetadata);
}

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  const parsed = await readJsonIfExists(metadataPath, isNativeEmitMetadata);
  return parsed?.version === NATIVE_EMIT_METADATA_VERSION ? parsed : null;
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
  emittedFiles: isStringArray,
  externsPath: isString,
  metadataPath: isString,
  optionsSignature: isString,
  preservedImports: arrayOf(isPreservedImport),
  supportFiles: isStringArray,
  typeMetadata: arrayOf(isNativeEmittedTypeMetadata),
  typeMetadataDependencies: recordOf(isContentIdentity),
  version: isNumber,
  warnings: isStringArray,
});
