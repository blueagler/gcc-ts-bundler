import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * On-disk cache for the *generated* slice text.
 *
 * The unit cache below it removes the archive parse; this removes everything
 * after it. A hit returns the finished extern text without loading the index,
 * scanning the program or rendering a slice — measured at ~330 ms of a ~535 ms
 * generation on the Svelte example.
 *
 * **Why the key is the program, not the seed set.** The natural key is "the
 * seeds", since identical seeds provably render an identical slice. But the
 * seeds are the *output* of the 330 ms scan, so keying on them would mean
 * paying the thing the cache exists to avoid. The key is therefore the input
 * the scan is a pure function of — the content of the program files and the
 * type-dependency files.
 *
 * Content hashes, not `(path, size, mtime)`: emitted program files are
 * rewritten on every build, so an mtime key would miss every time. Hashing
 * them costs single-digit milliseconds against the 330 ms it saves.
 *
 * Paths are deliberately excluded from the key. The slice depends only on the
 * names the sources mention, so two projects (or a project and its /tmp probe)
 * with identical inputs share one entry.
 */
export interface SliceCacheKey {
  cacheRoot: string;
  /** Identity of the parser that builds units; see `platformExternParserDigest`. */
  schemaDigest: string;
  jarHash: string;
  /** Sorted content digests of the program inputs. */
  inputDigest: string;
}

interface SlicePayload {
  text: string;
  version: number;
}

const PAYLOAD_VERSION = 1;
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cacheDirectory(cacheRoot: string) {
  return path.join(cacheRoot, "platform-externs");
}

function cacheFilePath(key: SliceCacheKey) {
  return path.join(
    cacheDirectory(key.cacheRoot),
    `slice.${key.schemaDigest}.${key.jarHash}.${key.inputDigest}.json.gz`,
  );
}

/**
 * Order-independent digest over the inputs the seed scan is a pure function of.
 *
 * The two lists are digested **separately and in order**, because they are not
 * interchangeable: program files contribute globals, properties *and* type
 * names, while type-dependency files contribute type names only. Folding both
 * into one digest makes the same set of files split two different ways collide
 * on one key and hand back the wrong slice — which is exactly what it did, and
 * what `type-architecture-e2e` caught.
 *
 * The extension travels with each content hash because it is the one part of a
 * path the collector reads: `.json` inputs are skipped outright. Everything
 * else about the path is irrelevant to the result and is left out so two
 * projects with identical inputs share one entry.
 */
export async function digestSliceInputs(
  jsFiles: readonly string[],
  typeDependencyFiles: readonly string[],
): Promise<string | null> {
  try {
    const [program, typeDeps] = await Promise.all([
      digestGroup(jsFiles),
      digestGroup(typeDependencyFiles),
    ]);
    return createHash("sha256")
      .update(`${program}\u0000${typeDeps}`)
      .digest("hex");
  } catch {
    // An unreadable input is the seeds collector's problem to report; here it
    // just means "no key", which degrades to generating the slice.
    return null;
  }
}

async function digestGroup(files: readonly string[]): Promise<string> {
  const digests = await Promise.all(
    files.map(async (filePath) => {
      const content = createHash("sha256")
        .update(await fs.readFile(filePath))
        .digest("hex");
      return `${path.extname(filePath).toLowerCase()}:${content}`;
    }),
  );
  digests.sort();
  return createHash("sha256").update(digests.join("\u0000")).digest("hex");
}

/**
 * Fail-closed on every anomaly, per the `isParsedUnits` precedent: a truncated,
 * foreign or version-drifted payload degrades to regenerating the slice, never
 * to handing back a wrong one.
 */
export async function readCachedSlice(
  key: SliceCacheKey,
): Promise<string | null> {
  const target = cacheFilePath(key);
  try {
    const packed = await fs.readFile(target);
    const parsed: unknown = JSON.parse(
      (await gunzip(packed)).toString("utf-8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const payload: Record<string, unknown> = { ...parsed };
    if (
      payload["version"] !== PAYLOAD_VERSION ||
      typeof payload["text"] !== "string" ||
      payload["text"].length === 0
    ) {
      return null;
    }
    // Mark as live so age-based collection does not reap an entry that is in
    // active use but has not had to be rewritten.
    await touch(target);
    return payload["text"];
  } catch {
    return null;
  }
}

export async function writeCachedSlice(
  key: SliceCacheKey,
  text: string,
): Promise<void> {
  const directory = cacheDirectory(key.cacheRoot);
  const target = cacheFilePath(key);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload: SlicePayload = { text, version: PAYLOAD_VERSION };
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporary, await gzip(JSON.stringify(payload)));
    await fs.rename(temporary, target);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function touch(target: string) {
  try {
    const now = new Date();
    await fs.utimes(target, now, now);
  } catch {
    /* best effort */
  }
}

/**
 * Age-based collection.
 *
 * Deliberately *not* "delete other digests for this jar". That rule looks
 * obvious and is wrong: the same parser has more than one live representation
 * (running from `src` and from the bundled `dist` hash differently), so
 * digest-scoped pruning makes the two evict each other and every alternation
 * pays a full regeneration. Age is the only signal that distinguishes a dead
 * entry from a live alternate, and reads refresh mtime so an entry stays alive
 * exactly as long as something uses it.
 *
 * Runs at most once per process and never blocks a build: failures are
 * swallowed, and the sweep is fire-and-forget from the caller's perspective.
 */
let collected = false;

export async function collectExpiredEntries(
  cacheRoot: string,
  maxAgeMs = MAX_ENTRY_AGE_MS,
): Promise<number> {
  if (collected) return 0;
  collected = true;
  const directory = cacheDirectory(cacheRoot);
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    const entries = await fs.readdir(directory);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith("slice.") && !entry.startsWith("units.")) return;
        const filePath = path.join(directory, entry);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await fs.rm(filePath, { force: true });
            removed += 1;
          }
        } catch {
          /* raced with another build; leave it */
        }
      }),
    );
  } catch {
    /* no cache directory yet, or unreadable — nothing to collect */
  }
  return removed;
}
