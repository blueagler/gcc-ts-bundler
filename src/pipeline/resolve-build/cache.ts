import path from "path";

import { collectTrackedFiles } from "../../internal/file-state";
import { ChunkPlanChunk, LazyImport, PackageAlias } from "../../internal/types";
import { readJsonIfExists } from "../../cache/store";

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
  const metadata = await readJsonIfExists<ResolveMetadata>(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }

  return metadata.chunkPlan;
}
