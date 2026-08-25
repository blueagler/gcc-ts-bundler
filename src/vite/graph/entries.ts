import { isString } from "../../shared/validation";

import { readAssetText } from "../output";
import type { OutputBundle, OutputChunk } from "../internal-types";

export function resolveEntryModuleIds(
  bundle: OutputBundle,
  chunks: OutputChunk[],
) {
  const htmlEntryModuleIds = resolveHtmlEntryModuleIds(bundle, chunks);
  if (htmlEntryModuleIds.length > 0) {
    return htmlEntryModuleIds;
  }

  return chunks
    .filter(hasFacadeModuleId)
    .filter((chunk) => chunk.isEntry)
    .map((chunk) => chunk.facadeModuleId);
}

export function resolveHtmlEntryModuleIds(
  bundle: OutputBundle,
  chunks: OutputChunk[],
) {
  const chunkByFileName = new Map(
    chunks.map((chunk) => [chunk.fileName, chunk]),
  );
  const moduleIds = new Set<string>();

  for (const asset of Object.values(bundle)) {
    if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) {
      continue;
    }
    const html = readAssetText(asset);
    const entryScripts = [
      ...html.matchAll(
        /<script\b[^>]*type=(["'])module\1[^>]*src=(["'])([^"']+)\2[^>]*><\/script>/giu,
      ),
    ];
    for (const match of entryScripts) {
      const sourcePath = match[3];
      if (sourcePath === undefined) {
        continue;
      }
      const chunk = [...chunkByFileName.entries()].find(([fileName]) =>
        sourcePath.endsWith(fileName),
      )?.[1];
      if (chunk?.facadeModuleId) {
        moduleIds.add(chunk.facadeModuleId);
      }
    }
  }

  return [...moduleIds].sort((left, right) => left.localeCompare(right));
}

export function resolveDynamicRootModuleIds(chunks: OutputChunk[]) {
  return [
    ...new Set(
      chunks
        .filter(hasFacadeModuleId)
        .filter((chunk) => chunk.isDynamicEntry)
        .map((chunk) => chunk.facadeModuleId),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function hasFacadeModuleId(
  chunk: OutputChunk,
): chunk is OutputChunk & { facadeModuleId: string } {
  return isString(chunk.facadeModuleId);
}
