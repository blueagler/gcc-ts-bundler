import path from "path";

import { readJsonIfExists } from "../../shared/cache-store";
import type { collectTrackedFiles } from "../../shared/file-state";
import { CHUNK_KINDS } from "../types";
import type {
  ChunkPlanChunk,
  ExternalBoundary,
  LazyImport,
  PackageAlias,
  PreservedModule,
  ResolvedImport,
} from "../types";
import {
  arrayOf,
  isBoolean,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  oneOf,
  optional,
  recordOf,
} from "../../shared/validation";

export interface ResolveMetadata {
  optionsSignature: string;
  chunkPlan: ChunkPlanChunk[];
  externalBoundaries?: ExternalBoundary[];
  entryFiles: Array<{
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourceRelativePath: string;
  }>;
  lazyImports: LazyImport[];
  packageAliases?: PackageAlias[];
  packageJsonFiles?: string[];
  preservedModules?: PreservedModule[];
  resolvedImports?: ResolvedImport[];
  tsxRuntimeSourceFiles?: string[];
}

export interface ResolveSnapshot {
  compilerOptionsHash: string;
  entryFiles: ResolveMetadata["entryFiles"];
  externalBoundaries: ExternalBoundary[];
  finalKey: string;
  lazyImports: LazyImport[];
  nativeEmitKey: string;
  optionsSignature: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  resolvedImports: ResolvedImport[];
  packageSignature: string;
  resolveKey: string;
  sourceFiles: string[];
  tsxRuntimeSourceFiles: string[];
  trackedFiles: Awaited<ReturnType<typeof collectTrackedFiles>>;
}

export async function readChunkPlan(
  projectCacheDir: string,
  resolveKey: string,
  optionsSignature: string,
) {
  const resolveMetadataPath = path.join(
    projectCacheDir,
    "resolve",
    `${resolveKey}.json`,
  );
  const metadata = await readJsonIfExists(
    resolveMetadataPath,
    isResolveMetadata,
  );
  return metadata?.optionsSignature === optionsSignature
    ? metadata.chunkPlan
    : null;
}

const isResolveEntry = isObjectOf<ResolveMetadata["entryFiles"][number]>({
  chunkName: isString,
  exportNames: isStringArray,
  hasDefaultExport: isBoolean,
  outputName: isString,
  sourceRelativePath: isString,
});

const isExternalBoundary = isObjectOf<ExternalBoundary>({
  importerFilePath: isString,
  specifier: isString,
});

const isLazyImport = isObjectOf<LazyImport>({
  importerFilePath: isString,
  moduleId: isString,
  specifier: isString,
  targetPath: isString,
});

const isPackageAlias = isObjectOf<PackageAlias>({
  packageName: isString,
  subpath: isString,
  targetPath: isString,
});

const isPreservedModule = isObjectOf<PreservedModule>({
  exportNames: isStringArray,
  filePath: isString,
  hasDefaultExport: isBoolean,
  moduleId: isString,
  outputRelativePath: isString,
});

const isResolvedImport = isObjectOf<ResolvedImport>({
  importerFilePath: isString,
  moduleId: isString,
  specifier: isString,
  targetPath: isString,
});

const isChunkPlanChunk = isObjectOf<ChunkPlanChunk>({
  dependencies: isStringArray,
  entryFiles: optional(isStringArray),
  files: isStringArray,
  kind: optional(oneOf(CHUNK_KINDS)),
  lazyModuleIds: optional(isStringArray),
  name: isString,
  outputName: optional(isString),
});

const isFileStateSnapshot = isObjectOf<ResolveSnapshot["trackedFiles"][string]>(
  {
    digest: isString,
    mtimeMs: isNumber,
    size: isNumber,
  },
);

export const isResolveMetadata = isObjectOf<ResolveMetadata>({
  optionsSignature: isString,
  externalBoundaries: optional(arrayOf(isExternalBoundary)),
  chunkPlan: arrayOf(isChunkPlanChunk),
  entryFiles: arrayOf(isResolveEntry),
  lazyImports: arrayOf(isLazyImport),
  packageAliases: optional(arrayOf(isPackageAlias)),
  packageJsonFiles: optional(isStringArray),
  preservedModules: optional(arrayOf(isPreservedModule)),
  resolvedImports: optional(arrayOf(isResolvedImport)),
  tsxRuntimeSourceFiles: optional(isStringArray),
});

export const isResolveSnapshot = isObjectOf<ResolveSnapshot>({
  compilerOptionsHash: isString,
  entryFiles: arrayOf(isResolveEntry),
  externalBoundaries: arrayOf(isExternalBoundary),
  finalKey: isString,
  lazyImports: arrayOf(isLazyImport),
  nativeEmitKey: isString,
  optionsSignature: isString,
  packageAliases: arrayOf(isPackageAlias),
  packageJsonFiles: isStringArray,
  preservedModules: arrayOf(isPreservedModule),
  resolvedImports: arrayOf(isResolvedImport),
  packageSignature: isString,
  resolveKey: isString,
  sourceFiles: isStringArray,
  trackedFiles: recordOf(isFileStateSnapshot),
  tsxRuntimeSourceFiles: isStringArray,
});
