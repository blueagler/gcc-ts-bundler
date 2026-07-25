import path from "path";

import { readJsonIfExists } from "../../cache/store";
import type { collectTrackedFiles } from "../../internal/file-state";
import { CHUNK_KINDS } from "../../internal/types";
import type {
  ChunkPlanChunk,
  LazyImport,
  PackageAlias,
} from "../../internal/types";
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
} from "../../internal/validation";

export interface ResolveMetadata {
  chunkPlan: ChunkPlanChunk[];
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
  tsxRuntimeSourceFiles?: string[];
}

export interface ResolveSnapshot {
  compilerOptionsHash: string;
  entryFiles: ResolveMetadata["entryFiles"];
  finalKey: string;
  lazyImports: LazyImport[];
  nativeEmitKey: string;
  optionsSignature: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  packageSignature: string;
  resolveKey: string;
  sourceFiles: string[];
  tsxRuntimeSourceFiles: string[];
  trackedFiles: Awaited<ReturnType<typeof collectTrackedFiles>>;
}

export async function readChunkPlan(
  projectCacheDir: string,
  resolveKey: string,
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
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }

  return metadata.chunkPlan;
}

const isResolveEntry = isObjectOf<ResolveMetadata["entryFiles"][number]>({
  chunkName: isString,
  exportNames: isStringArray,
  hasDefaultExport: isBoolean,
  outputName: isString,
  sourceRelativePath: isString,
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

const isChunkPlanChunk = isObjectOf<ChunkPlanChunk>({
  dependencies: isStringArray,
  entryFiles: optional(isStringArray),
  files: isStringArray,
  kind: optional(oneOf(CHUNK_KINDS)),
  lazyModuleIds: optional(isStringArray),
  name: isString,
});

const isFileStateSnapshot = isObjectOf<ResolveSnapshot["trackedFiles"][string]>(
  {
    mtimeMs: isNumber,
    size: isNumber,
  },
);

export const isResolveMetadata = isObjectOf<ResolveMetadata>({
  chunkPlan: arrayOf(isChunkPlanChunk),
  entryFiles: arrayOf(isResolveEntry),
  lazyImports: arrayOf(isLazyImport),
  packageAliases: optional(arrayOf(isPackageAlias)),
  packageJsonFiles: optional(isStringArray),
  tsxRuntimeSourceFiles: optional(isStringArray),
});

export const isResolveSnapshot = isObjectOf<ResolveSnapshot>({
  compilerOptionsHash: isString,
  entryFiles: arrayOf(isResolveEntry),
  finalKey: isString,
  lazyImports: arrayOf(isLazyImport),
  nativeEmitKey: isString,
  optionsSignature: isString,
  packageAliases: arrayOf(isPackageAlias),
  packageJsonFiles: isStringArray,
  packageSignature: isString,
  resolveKey: isString,
  sourceFiles: isStringArray,
  trackedFiles: recordOf(isFileStateSnapshot),
  tsxRuntimeSourceFiles: isStringArray,
});
