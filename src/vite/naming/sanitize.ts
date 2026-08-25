import { createHash } from "node:crypto";
import path from "node:path";

export function relativeSpecifier(importer: string, target: string) {
  const relative = path.posix.relative(path.posix.dirname(importer), target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

export function hashText(sourceText: string) {
  return createHash("sha256").update(sourceText).digest("base64url");
}

export function ensureUniqueJsFileName(
  fileName: string,
  contentHash: string,
  reservedNames: Set<string>,
) {
  const normalized = normalizeOutputFileName(fileName);
  if (!reservedNames.has(normalized)) {
    return normalized;
  }

  const { dir, ext, name } = path.posix.parse(normalized);
  const suffix = contentHash.slice(0, 8);
  const deduped = normalizeOutputFileName(
    path.posix.join(dir, `${name}-${suffix}${ext || ".js"}`),
  );
  if (reservedNames.has(deduped)) {
    throw new Error(
      `gccTsBundler() could not assign a unique output file name for ${normalized}.`,
    );
  }
  return deduped;
}

export function normalizeOutputFileName(fileName: string) {
  return fileName.replace(/\\/g, "/").replace(/^\/+/u, "");
}

export function sanitizeName(value: string) {
  return value.replace(/[^\w-]/gu, "-").replace(/^-+|-+$/gu, "") || "chunk";
}
