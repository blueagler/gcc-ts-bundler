import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

import type { ParsedPlatformExternUnits } from "./types";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * On-disk cache for the parsed Closure extern archive.
 *
 * Two things decide an entry's identity, and both are inputs to the parse:
 * `jarHash` (the archive) and `schemaDigest` (the code that turns it into
 * units, see `platformExternParserDigest`). A stale payload would silently
 * produce a wrong extern slice, and the slice's failure mode is a full-externs
 * recompile rather than an error — so identity lives in the file name and is
 * derived, never a constant somebody has to remember to bump.
 *
 * `cacheRoot` is a required argument, not a default. The entry is keyed only by
 * its inputs, so it is deliberately shared by every project on the machine —
 * which makes an accidental write from a test a cross-project hazard. Requiring
 * the caller to name the root turns "tests must not touch the shared cache"
 * from a convention into something the type checker enforces.
 *
 * ~5.2 MB of JSON, ~470 KB gzipped; gzip is worth it because the read happens
 * once per process and the decompress is far cheaper than the 830 ms parse it
 * replaces.
 */
function cacheFileName(jarHash: string, schemaDigest: string) {
  return `units.${schemaDigest}.${jarHash}.json.gz`;
}

function cacheDirectory(cacheRoot: string) {
  return path.join(cacheRoot, "platform-externs");
}

export interface PlatformExternCacheKey {
  cacheRoot: string;
  jarHash: string;
  schemaDigest: string;
}

export async function readCachedUnits({
  cacheRoot,
  jarHash,
  schemaDigest,
}: PlatformExternCacheKey): Promise<ParsedPlatformExternUnits | null> {
  try {
    const packed = await fs.readFile(
      path.join(
        cacheDirectory(cacheRoot),
        cacheFileName(jarHash, schemaDigest),
      ),
    );
    const parsed: unknown = JSON.parse(
      (await gunzip(packed)).toString("utf-8"),
    );
    // A truncated, foreign or shape-drifted payload must degrade to a reparse,
    // never to a wrong slice.
    return isParsedUnits(parsed) && parsed.jarHash === jarHash ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Atomic: write to a unique sibling, then rename. Concurrent builds race
 * harmlessly — rename is atomic on POSIX and both payloads are identical for a
 * given key. Every failure is swallowed; a cache that cannot be written is a
 * slower build, not a broken one.
 *
 * Superseded entries are deliberately NOT pruned. The obvious "delete other
 * digests for this jar" rule is wrong: the same parser has more than one live
 * representation — running from `src` and running from the bundled `dist`
 * digest differently — so pruning makes the two evict each other and every
 * alternation pays the full 830 ms reparse. An orphan is ~470 KB and is only
 * created when the compiler version or the parser actually changes, which is
 * the cheaper thing to be wrong about.
 */
export async function writeCachedUnits(
  { cacheRoot, jarHash, schemaDigest }: PlatformExternCacheKey,
  units: ParsedPlatformExternUnits,
): Promise<void> {
  const directory = cacheDirectory(cacheRoot);
  const target = path.join(directory, cacheFileName(jarHash, schemaDigest));
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, await gzip(JSON.stringify(units)));
    await fs.rename(temporary, target);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Validates the payload envelope *and* the unit shape.
 *
 * The envelope check alone is not enough: `globalNames` and `propertyNames` are
 * derived downstream from each unit's `fileName`/`names`/`property`, so a
 * payload whose units are missing those fields yields an index that silently
 * drops declarations — the bare-globals class of miscompile
 * (`window.setTimeout` renamed). The digest in the file name is the real guard;
 * this is the second line, for payloads that were truncated or hand-edited
 * rather than produced by a different parser.
 */
function isParsedUnits(value: unknown): value is ParsedPlatformExternUnits {
  if (typeof value !== "object" || value === null) return false;
  const has = (key: string): unknown =>
    Object.prototype.hasOwnProperty.call(value, key)
      ? Reflect.get(value, key)
      : undefined;
  const units = has("allUnits");
  if (
    typeof has("jarHash") !== "string" ||
    !Array.isArray(units) ||
    units.length === 0
  ) {
    return false;
  }
  return units.every(isDeclarationUnit);
}

function isDeclarationUnit(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const unit: Record<string, unknown> = { ...value };
  return (
    typeof unit["id"] === "string" &&
    typeof unit["fileName"] === "string" &&
    typeof unit["text"] === "string" &&
    typeof unit["fileOrder"] === "number" &&
    typeof unit["statementOrder"] === "number" &&
    typeof unit["override"] === "boolean" &&
    isStringArray(unit["names"]) &&
    isStringArray(unit["dependencies"]) &&
    isStringArray(unit["heritage"]) &&
    (unit["owner"] === undefined || typeof unit["owner"] === "string") &&
    (unit["property"] === undefined || typeof unit["property"] === "string")
  );
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}
