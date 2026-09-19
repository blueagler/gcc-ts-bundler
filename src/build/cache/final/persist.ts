import path from "path";

import type { BuildResult } from "../../../api/types";
import { writeJson } from "../../../shared/cache-store";
import {
  collectPublishedOutputStats,
  type FileContentSnapshot,
  type PublishedOutputSnapshot,
} from "../../../shared/file-state";
import {
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  recordOf,
} from "../../../shared/validation";
import type { ClosureStageResult } from "../../closure/run-closure";
import type { BuildContext, ResolvedBuild } from "../../types";

interface FinalCacheMetadata {
  artifacts: PublishedOutputSnapshot[];
  finalKey: string;
  optionsSignature: string;
  packageSignature: string;
  typeMetadataDependencies: FileContentSnapshot;
}

/** The manifest lives with immutable canonical bytes, never published destinations. */
export async function persistFinalCache(
  context: BuildContext,
  resolved: ResolvedBuild,
  stagingCacheDir: string,
  closureResult: ClosureStageResult,
  typeMetadataDependencies: FileContentSnapshot,
) {
  if (context.options.cache.mode !== "persistent") return;
  const artifacts = await collectPublishedOutputStats(
    closureResult.cacheOutputFiles,
    path.join(stagingCacheDir, "outputs"),
  );
  await writeJson(path.join(stagingCacheDir, "meta.json"), {
    artifacts,
    finalKey: resolved.finalKey,
    optionsSignature: context.optionsSignature,
    packageSignature: context.packageSignature,
    typeMetadataDependencies,
  } satisfies FinalCacheMetadata);
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
const isArtifact = isObjectOf<PublishedOutputSnapshot>({
  digest: isString,
  name: isString,
  size: isNumber,
});
const isMetadata = isObjectOf<FinalCacheMetadata>({
  artifacts: arrayOf(isArtifact),
  finalKey: isString,
  optionsSignature: isString,
  packageSignature: isString,
  typeMetadataDependencies: recordOf(isContentIdentity),
});

export function isFinalCacheMetadata(
  value: unknown,
): value is FinalCacheMetadata {
  if (!isMetadata(value)) return false;
  const names = new Set<string>();
  for (const { name } of value.artifacts) {
    if (
      !name ||
      path.isAbsolute(name) ||
      path.win32.isAbsolute(name) ||
      name
        .split(/[\\/]/u)
        .some((part) => part === ".." || part === "." || !part) ||
      names.has(name)
    )
      return false;
    names.add(name);
  }
  return true;
}
