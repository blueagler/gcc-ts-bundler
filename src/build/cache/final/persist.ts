import type { BuildResult } from "../../../api/types";
import { writeJson } from "../../../shared/cache-store";
import {
  collectFileContentSnapshot,
  collectPublishedOutputStats,
  type FileContentSnapshot,
  type PublishedOutputSnapshot,
} from "../../../shared/file-state";
import {
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  recordOf,
} from "../../../shared/validation";
import type { ClosureStageResult } from "../../closure/run-closure";
import type { BuildContext, ResolvedBuild } from "../../types";
import type { FinalCachePaths } from "./staging";

interface FinalCacheMetadata {
  artifacts: FileContentSnapshot;
  finalKey: string;
  optionsSignature: string;
  outputFiles: string[];
  packageSignature: string;
  typeMetadataDependencies: FileContentSnapshot;
}

interface FinalFastSnapshot {
  finalKey: string;
  optionsSignature: string;
  packageSignature: string;
  publishedOutputs: PublishedOutputSnapshot[];
  typeMetadataDependencies: FileContentSnapshot;
}

export async function persistFinalCache(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
  closureResult: ClosureStageResult,
  typeMetadataDependencies: FileContentSnapshot,
) {
  if (context.options.cache.mode !== "persistent") {
    return;
  }
  const artifacts = await collectFileContentSnapshot(
    closureResult.cacheOutputFiles,
  );
  await Promise.all([
    writeJson(cachePaths.metadataPath, {
      artifacts,
      finalKey: resolved.finalKey,
      optionsSignature: context.optionsSignature,
      outputFiles: closureResult.cacheOutputFiles,
      packageSignature: context.packageSignature,
      typeMetadataDependencies,
    } satisfies FinalCacheMetadata),
    collectPublishedOutputStats(
      closureResult.outputFiles,
      context.options.outDir,
    ).then((publishedOutputs) =>
      writeJson(cachePaths.fastSnapshotPath, {
        finalKey: resolved.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs,
        typeMetadataDependencies,
      } satisfies FinalFastSnapshot),
    ),
  ]);
}

export function successfulBuild(
  outputFiles: readonly string[],
  cacheHit: boolean,
): BuildResult {
  return { cacheHit, ok: true, outputFiles };
}

const isContentIdentity = isObjectOf<FileContentSnapshot[string]>({
  digest: isString,
  size: isNumber,
});

export const isFinalCacheMetadata = isObjectOf<FinalCacheMetadata>({
  artifacts: recordOf(isContentIdentity),
  finalKey: isString,
  optionsSignature: isString,
  outputFiles: isStringArray,
  packageSignature: isString,
  typeMetadataDependencies: recordOf(isContentIdentity),
});

const isPublishedOutput = isObjectOf<
  FinalFastSnapshot["publishedOutputs"][number]
>({
  digest: isString,
  name: isString,
  size: isNumber,
});

export const isFinalFastSnapshot = isObjectOf<FinalFastSnapshot>({
  finalKey: isString,
  optionsSignature: isString,
  packageSignature: isString,
  publishedOutputs: arrayOf(isPublishedOutput),
  typeMetadataDependencies: recordOf(isContentIdentity),
});
