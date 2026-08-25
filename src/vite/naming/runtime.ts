import type { Validator } from "../../shared/validation";
import { isString, recordOf } from "../../shared/validation";
import {
  extractRuntimeInitManifest,
  replaceRuntimeInitManifest,
} from "../../build/closure/runtime-manifest";

export const isRuntimeModuleSourceMap: Validator<Record<string, string>> =
  recordOf<string>(isString);

export function patchRuntimeChunkUrls(
  sourceText: string,
  renameMap: Map<string, string>,
) {
  const runtimeInit = extractRuntimeInitManifest(sourceText);
  const manifest = runtimeInit.manifest;
  if (!Array.isArray(manifest) || !Array.isArray(manifest[1])) {
    throw new Error(
      "gccTsBundler() could not read runtime chunk metadata from the base chunk.",
    );
  }
  for (const entry of manifest[1]) {
    if (!Array.isArray(entry)) {
      continue;
    }
    const relativeUrl = isString(entry[1]) ? entry[1] : "";
    if (!relativeUrl) {
      continue;
    }
    const renamed = renameMap.get(relativeUrl);
    if (renamed) {
      entry[1] = renamed;
    }
  }
  return replaceRuntimeInitManifest(sourceText, manifest);
}
