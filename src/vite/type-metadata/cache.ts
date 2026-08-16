import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { isRecord } from "../../shared/validation";
import { VITE_TYPE_METADATA_VERSION } from "./types";

export type TypeMetadataCacheRawArray = readonly TypeMetadataCacheRawValue[];

export interface TypeMetadataCacheRawCallable {
  (...arguments_: never[]): void;
}

export interface TypeMetadataCacheRawRecord {
  [key: string]: TypeMetadataCacheRawValue;
}

export type TypeMetadataCacheRawValue =
  | TypeMetadataCacheRawArray
  | TypeMetadataCacheRawCallable
  | TypeMetadataCacheRawRecord
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined;

type TypeMetadataCacheDomainValue<Value> =
  Value extends TypeMetadataCacheRawValue
    ? Value
    : Value extends readonly (infer Entry)[]
      ? readonly TypeMetadataCacheDomainValue<Entry>[]
      : Value extends object
        ? { [Key in keyof Value]: TypeMetadataCacheDomainValue<Value[Key]> }
        : Value;

type TypeMetadataCacheValue =
  | {
      kind: "array";
      values: TypeMetadataCacheValue[];
    }
  | {
      entries: Array<{
        key: string;
        value: TypeMetadataCacheValue;
      }>;
      kind: "object";
    }
  | {
      json: string;
      kind: "scalar";
    };

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

export function hashTypeMetadataValue<Value>(
  value: TypeMetadataCacheDomainValue<Value>,
) {
  return createHash("sha256")
    .update(String(VITE_TYPE_METADATA_VERSION))
    .update("\0")
    .update(stableJson(parseTypeMetadataCacheValue(value)))
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

function parseTypeMetadataCacheValue<Value>(
  value: TypeMetadataCacheDomainValue<Value>,
): TypeMetadataCacheValue {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      values: value.map(parseTypeMetadataCacheValue),
    };
  }
  if (isRecord(value)) {
    return {
      entries: Object.entries(value).map(([key, entry]) => ({
        key,
        value: parseTypeMetadataCacheValue(entry),
      })),
      kind: "object",
    };
  }
  return {
    json: JSON.stringify(value) ?? "null",
    kind: "scalar",
  };
}

function stableJson(value: TypeMetadataCacheValue): string {
  switch (value.kind) {
    case "array":
      return `[${value.values.map(stableJson).join(",")}]`;
    case "object":
      return `{${value.entries
        .sort((left, right) => left.key.localeCompare(right.key))
        .map(
          (entry) => `${JSON.stringify(entry.key)}:${stableJson(entry.value)}`,
        )
        .join(",")}}`;
    case "scalar":
      return value.json;
  }
}
