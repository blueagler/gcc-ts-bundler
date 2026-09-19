import crypto from "crypto";
import { isFunction, isRecord, isUnknownArray } from "./validation";

function normalizeValue(value: unknown): unknown {
  if (isUnknownArray(value)) {
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

export function hashJson(value: unknown): string {
  return hashContent(JSON.stringify(normalizeValue(value)));
}
