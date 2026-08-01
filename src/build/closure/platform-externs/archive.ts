import { createHash } from "crypto";
import fs from "fs/promises";
import { createRequire } from "module";
import path from "path";
import zlib from "zlib";

import type { PlatformExternArchive, PlatformExternSource } from "./types";

const requireFromHere = createRequire(import.meta.url);

const archivePromises = new Map<
  string,
  Promise<PlatformExternArchive | null>
>();

/**
 * `cacheRoot` is required, and the memo is keyed by it.
 *
 * Both halves of that sentence are load-bearing. Loading the archive *writes*
 * the identity record (see below), so an optional root meant any caller that
 * forgot one silently wrote the machine-shared cache — which is exactly how a
 * test file that existed to prove the shared cache stays untouched came to
 * write it. And a single process-wide promise captured the first caller's root
 * and discarded every later one, so passing a root was no guarantee of using
 * it: isolation depended on which caller happened to run first. Keying the memo
 * by root makes two roots two archives, matching `getPlatformExternIndex`.
 *
 * The default lives in the subsystem's composition root
 * (`generatePlatformExternsText`) and nowhere else.
 */
export function loadPlatformExternArchive(options: { cacheRoot: string }) {
  let promise = archivePromises.get(options.cacheRoot);
  if (!promise) {
    promise = loadInstalledArchive(options).catch(() => null);
    archivePromises.set(options.cacheRoot, promise);
  }
  return promise;
}

/**
 * Identity of the jar, without reading the jar.
 *
 * `jarHash` is the archive half of every cache key below, and deriving it used
 * to mean reading and unzipping 49 MB on every build — measured at 147 ms, paid
 * even when every downstream cache then hit. The hash is now recorded next to
 * the caches against the jar's `(path, size, mtimeMs)`; a stat match reuses it.
 *
 * Any mismatch — different size, different mtime, missing or unreadable record,
 * corrupt JSON — falls through to reading and hashing the jar for real, so the
 * fast path can only ever be *skipped*, never wrong. The content hash remains
 * the sole definition of identity; this is a memo of it, not a substitute.
 */
interface ArchiveIdentityRecord {
  jarHash: string;
  mtimeMs: number;
  path: string;
  size: number;
}

function identityFilePath(cacheRoot: string) {
  return path.join(cacheRoot, "platform-externs", "archive-id.json");
}

async function readIdentityRecord(
  cacheRoot: string,
  jarPath: string,
  stats: { mtimeMs: number; size: number },
): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(identityFilePath(cacheRoot), "utf-8"),
    );
    if (typeof raw !== "object" || raw === null) return null;
    const record: Record<string, unknown> = { ...raw };
    return record["path"] === jarPath &&
      record["size"] === stats.size &&
      record["mtimeMs"] === stats.mtimeMs &&
      typeof record["jarHash"] === "string"
      ? record["jarHash"]
      : null;
  } catch {
    return null;
  }
}

async function writeIdentityRecord(
  cacheRoot: string,
  record: ArchiveIdentityRecord,
): Promise<void> {
  const target = identityFilePath(cacheRoot);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  } catch {
    /* a cache that cannot be written is a slower build, not a broken one */
  }
}

async function loadInstalledArchive(options: {
  cacheRoot: string;
}): Promise<PlatformExternArchive | null> {
  const jarPath = resolvePlatformExternCompilerJarPath();
  if (!jarPath) return null;
  const { cacheRoot } = options;

  let stats: { mtimeMs: number; size: number };
  try {
    const stat = await fs.stat(jarPath);
    stats = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }

  const recorded = await readIdentityRecord(cacheRoot, jarPath, stats);
  if (recorded) {
    // Fast path: identity known, entries not needed unless something
    // downstream misses and asks for them.
    return { entries: () => readEntries(jarPath), jarHash: recorded };
  }

  const jar = await fs.readFile(jarPath);
  const archive = readPlatformExternArchive(jar);
  if (!archive) return null;
  await writeIdentityRecord(cacheRoot, {
    jarHash: archive.jarHash,
    mtimeMs: stats.mtimeMs,
    path: jarPath,
    size: stats.size,
  });
  return archive;
}

async function readEntries(
  jarPath: string,
): Promise<readonly PlatformExternSource[]> {
  const archive = readPlatformExternArchive(await fs.readFile(jarPath));
  if (!archive) throw new Error("Closure extern archive became unreadable");
  return archive.entries();
}

export function readPlatformExternArchive(
  jar: Buffer,
): PlatformExternArchive | null {
  const externsZip = readZipEntries(jar).get("externs.zip");
  if (!externsZip) return null;
  const entries = [...readZipEntries(externsZip)]
    .filter(([name]) => name.endsWith(".js"))
    .map(([name, content]) => ({ name, source: content.toString("utf-8") }));
  if (entries.length === 0) return null;
  return {
    jarHash: createHash("sha256").update(jar).digest("hex"),
    entries: () => Promise.resolve(entries),
  };
}

export function resolvePlatformExternCompilerJarPath(): string | null {
  try {
    // `google-closure-compiler-java` is transitive, not a direct dependency.
    // Resolve from the compiler package so Bun/pnpm isolated installs find its
    // nested dependency instead of requiring it to be hoisted beside us.
    const compilerPackage = requireFromHere.resolve(
      "google-closure-compiler/package.json",
    );
    return createRequire(compilerPackage)
      .resolve("google-closure-compiler-java/package.json")
      .replace(/package\.json$/, "compiler.jar");
  } catch {
    return null;
  }
}

/** ZIP reader for the stored/deflated entries used by compiler.jar. */
export function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0 || eocdOffset + 22 > archive.length) return entries;

  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = archive.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > archive.length ||
      archive.readUInt32LE(offset) !== 0x02014b50
    ) {
      return new Map();
    }
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    if (
      localHeaderOffset + 30 > archive.length ||
      archive.readUInt32LE(localHeaderOffset) !== 0x04034b50
    ) {
      return new Map();
    }
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf-8");
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) return new Map();
    const data = archive.subarray(dataStart, dataEnd);
    if (compressionMethod === 0) {
      entries.set(name, Buffer.from(data));
    } else if (compressionMethod === 8) {
      try {
        entries.set(name, zlib.inflateRawSync(data));
      } catch {
        return new Map();
      }
    } else {
      return new Map();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const searchStart = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}
