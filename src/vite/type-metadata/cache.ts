import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { VITE_TYPE_METADATA_VERSION } from "./types";

export async function hashTypeMetadataFiles(filePaths: readonly string[]) {
  const files = await Promise.all(
    [...new Set(filePaths)].sort().map(async (filePath) => ({
      content: await fs.readFile(filePath),
      filePath,
    })),
  );
  const hash = createHash("sha256");
  hash.update(String(VITE_TYPE_METADATA_VERSION));
  for (const file of files) {
    hash.update("\0");
    hash.update(file.filePath);
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

export function hashTypeMetadataValue(value: unknown) {
  return createHash("sha256")
    .update(String(VITE_TYPE_METADATA_VERSION))
    .update("\0")
    .update(stableJson(value))
    .digest("hex");
}

export async function createTypeMetadataCacheKey(input: {
  compilerOptions: unknown;
  declarationFiles: readonly string[];
  prebundleProvenance?: unknown;
  resolution: unknown;
  runtimeExportGraph: unknown;
}) {
  return hashTypeMetadataValue({
    compilerOptions: input.compilerOptions,
    declarationContentHash: await hashTypeMetadataFiles(input.declarationFiles),
    prebundleProvenance: input.prebundleProvenance,
    resolution: input.resolution,
    runtimeExportGraph: input.runtimeExportGraph,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
