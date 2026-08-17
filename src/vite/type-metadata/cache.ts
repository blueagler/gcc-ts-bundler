import { createHash } from "node:crypto";

import { isRecord } from "../../shared/validation";
import { VITE_TYPE_METADATA_VERSION } from "./types";

type TypeMetadataCacheRawArray = readonly TypeMetadataCacheRawValue[];

interface TypeMetadataCacheRawCallable {
  (...arguments_: never[]): void;
}

interface TypeMetadataCacheRawRecord {
  [key: string]: TypeMetadataCacheRawValue;
}

type TypeMetadataCacheRawValue =
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

export function hashTypeMetadataValue<Value>(
  value: TypeMetadataCacheDomainValue<Value>,
) {
  return createHash("sha256")
    .update(String(VITE_TYPE_METADATA_VERSION))
    .update("\0")
    .update(stableJson(parseTypeMetadataCacheValue(value)))
    .digest("hex");
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
