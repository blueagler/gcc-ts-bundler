import fs from "node:fs/promises";
import path from "node:path";

import { firstOrUndefined } from "../../../shared/arrays";
import { syncDirectoryEntries } from "../../../shared/files";
import { hashContent } from "../../../shared/hash";
import type { CapturedRuntimeModule } from "../../internal-types";
import type { WrittenRegionBundleRequest } from "../regions";
import { isPureLazyRegionKey } from "../regions";
import { normalizePath } from "../shared";

export interface CanonicalizedLazyEntryOutputs {
  canonicalModules: CapturedRuntimeModule[];
  omittedOutputFilePaths: Set<string>;
  outputByRequestKey: Map<string, string>;
}

export async function canonicalizeDuplicateLazyEntryOutputs(input: {
  entryOutputByRequestKey: Map<string, string>;
  outputDir: string;
  outputSrcDir: string;
  writtenRequests: WrittenRegionBundleRequest[];
}): Promise<CanonicalizedLazyEntryOutputs> {
  const requestByKey = new Map(
    input.writtenRequests.map((request) => [request.requestKey, request]),
  );
  const requestKeysByContentHash = new Map<string, string[]>();

  for (const [requestKey, outputFilePath] of input.entryOutputByRequestKey) {
    const request = requestByKey.get(requestKey);
    if (!request || !isPureLazyRegionKey(request.requests[0]?.regionKey)) {
      continue;
    }
    const sourceText = await fs.readFile(outputFilePath, "utf8");
    const contentHash = hashContent(sourceText);
    const bucket = requestKeysByContentHash.get(contentHash);
    if (bucket) {
      bucket.push(requestKey);
    } else {
      requestKeysByContentHash.set(contentHash, [requestKey]);
    }
  }

  const outputByRequestKey = new Map(input.entryOutputByRequestKey);
  const omittedOutputFilePaths = new Set<string>();
  const canonicalModules: CapturedRuntimeModule[] = [];
  const sharedEntries: Array<{ content: string; relativePath: string }> = [];

  for (const [contentHash, requestKeys] of requestKeysByContentHash) {
    if (requestKeys.length < 2) {
      continue;
    }

    const firstRequestKey = firstOrUndefined(requestKeys);
    if (firstRequestKey === undefined) {
      continue;
    }
    const firstOutputFilePath = outputByRequestKey.get(firstRequestKey);
    if (!firstOutputFilePath) {
      continue;
    }
    const sourceText = await fs.readFile(firstOutputFilePath, "utf8");

    const canonicalFilePath = normalizePath(
      path.join(
        input.outputDir,
        "shared",
        `${path.basename(firstOutputFilePath, ".js")}-${contentHash.slice(
          0,
          8,
        )}.js`,
      ),
    );
    sharedEntries.push({
      content: sourceText,
      relativePath: path
        .relative(path.join(input.outputDir, "shared"), canonicalFilePath)
        .replace(/\\/g, "/"),
    });

    const sourceModuleIds = new Set<string>();
    for (const requestKey of requestKeys) {
      const request = requestByKey.get(requestKey);
      if (!request) {
        continue;
      }
      for (const sourceModuleId of request.sourceModuleIds) {
        sourceModuleIds.add(sourceModuleId);
      }
      const outputFilePath = outputByRequestKey.get(requestKey);
      if (outputFilePath && outputFilePath !== canonicalFilePath) {
        omittedOutputFilePaths.add(outputFilePath);
      }
      outputByRequestKey.set(requestKey, canonicalFilePath);
    }

    canonicalModules.push({
      filePath: canonicalFilePath,
      id: canonicalFilePath,
      relativePath: path
        .relative(input.outputSrcDir, canonicalFilePath)
        .replace(/\\/g, "/"),
      sourceModuleIds: [...sourceModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
    });
  }

  await syncDirectoryEntries(
    path.join(input.outputDir, "shared"),
    sharedEntries,
  );

  return {
    canonicalModules,
    omittedOutputFilePaths,
    outputByRequestKey,
  };
}
