import type { DependencyBundleSet } from "../types";

/** Map each atom's target module to the bundle output that now replaces it. */
export function resolveAtomOutputs(
  bundles: DependencyBundleSet,
  atomRequestKeyByTargetFilePath: Map<string, string>,
) {
  const atomOutputByTargetFilePath = new Map<string, string>();
  for (const [targetFilePath, requestKey] of atomRequestKeyByTargetFilePath) {
    const outputFilePath =
      bundles.canonicalizedEntryOutputs.outputByRequestKey.get(
        bundles.requestGroupKeyByTarget.get(requestKey) ?? requestKey,
      );
    if (outputFilePath) {
      atomOutputByTargetFilePath.set(targetFilePath, outputFilePath);
    }
  }
  return atomOutputByTargetFilePath;
}
