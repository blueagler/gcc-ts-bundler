import crypto from "crypto";
import { isFunction, isRecord, type RuntimePrimitive } from "./validation";

type HashInput = RuntimePrimitive | object;

function normalizeValue<Value extends HashInput>(value: Value): HashInput {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nestedValue]) => !isFunction(nestedValue))
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]),
    );
  }

  return value;
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashJson<Value extends HashInput>(value: Value): string {
  return hashContent(JSON.stringify(normalizeValue(value)));
}
