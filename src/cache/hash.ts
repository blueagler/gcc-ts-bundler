import crypto from "crypto";

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => typeof nestedValue !== "function")
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
