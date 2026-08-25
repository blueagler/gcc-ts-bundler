import { createHash } from "node:crypto";

import {
  addNamespaceParents,
  declarationNames,
  memberIdentity,
  parseDeclarationUnits,
  qualifiedName,
  rhsQualifiedNames,
} from "./declarations";
import {
  parseClosureTypeReferences,
  parseHeritageReferences,
  parseTemplateNames,
} from "./jsdoc";
import { parseJavaScriptSource } from "./typescript";
import { readCachedUnits, writeCachedUnits } from "./units";
import type {
  ParsedPlatformExternUnits,
  PlatformDeclarationUnit,
  PlatformExternArchive,
  PlatformExternIndex,
} from "../types";

const indexPromises = new Map<string, Promise<PlatformExternIndex>>();

/**
 * Identity of the code that turns the archive into units.
 *
 * The cache payload is a pure function of (archive, this parser). The archive
 * half is `jarHash`; this is the other half. It used to be a hand-bumped
 * `CACHE_VERSION`, which is a guard only for as long as everyone remembers it —
 * and forgetting is silent, because a stale payload yields a wrong slice whose
 * failure mode is an invisible full-externs recompile.
 *
 * Deriving it from the functions' own source removes the manual step: change
 * how a unit is built and the digest moves, so every machine reparses. A
 * bundler that reformats these bodies without a source change only costs one
 * reparse, which is the safe direction to be wrong in.
 */
let parserDigest: string | undefined;

export function platformExternParserDigest(): string {
  parserDigest ??= createHash("sha256")
    .update(
      [
        parsePlatformExternUnits,
        indexPlatformExternUnits,
        parseDeclarationUnits,
        declarationNames,
        rhsQualifiedNames,
        qualifiedName,
        memberIdentity,
        addNamespaceParents,
        parseClosureTypeReferences,
        parseHeritageReferences,
        parseTemplateNames,
        parseJavaScriptSource,
      ]
        .map((fn) => fn.toString())
        .join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
  return parserDigest;
}

/**
 * Per-process memo *and* a cross-process disk cache.
 *
 * Splitting the archive into ~13k declaration units costs ~830 ms of
 * TypeScript parsing, and the memo below dies with the process, so every build
 * invocation used to pay it in full — including builds whose Closure job was a
 * cache hit and never ran. The parse is a pure function of the jar, so it is
 * keyed by `jarHash` and persisted; only the cheap map-building step (~20 ms)
 * is repeated.
 */
export function getPlatformExternIndex(
  archive: PlatformExternArchive,
  options: PlatformExternIndexOptions,
) {
  // The memo is keyed by the cache root too: two roots are two caches, and
  // collapsing them would hand a caller the other one's entry.
  const key = `${options.cacheRoot}\u0000${archive.jarHash}`;
  let promise = indexPromises.get(key);
  if (!promise) {
    promise = loadPlatformExternIndex(archive, options);
    indexPromises.set(key, promise);
    promise.catch(() => indexPromises.delete(key));
  }
  return promise;
}

export interface PlatformExternIndexOptions {
  /**
   * Root of the shared on-disk unit cache. Required rather than defaulted:
   * the entry is keyed only by its inputs and is therefore shared by every
   * project on the machine, so a caller that has not thought about which cache
   * it is writing (a test, most of all) should not be able to reach it.
   */
  cacheRoot: string;
}

async function loadPlatformExternIndex(
  archive: PlatformExternArchive,
  options: PlatformExternIndexOptions,
) {
  const key = {
    cacheRoot: options.cacheRoot,
    jarHash: archive.jarHash,
    schemaDigest: platformExternParserDigest(),
  };
  const cached = await readCachedUnits(key);
  if (cached) return indexPlatformExternUnits(cached);
  const parsed = await parsePlatformExternUnits(archive);
  // Best-effort: a cold or unwritable cache must never fail a build.
  await writeCachedUnits(key, parsed);
  return indexPlatformExternUnits(parsed);
}

/** The expensive half: TypeScript-parse every archive entry into units. */
async function parsePlatformExternUnits(
  archive: PlatformExternArchive,
): Promise<ParsedPlatformExternUnits> {
  const allUnits: PlatformDeclarationUnit[] = [];

  const archiveEntries = await archive.entries();
  for (const [fileOrder, entry] of archiveEntries.entries()) {
    allUnits.push(...parseDeclarationUnits(entry, fileOrder));
  }
  return { allUnits, jarHash: archive.jarHash };
}

/** The cheap half: group parsed units into lookup maps. */
function indexPlatformExternUnits({
  allUnits,
  jarHash,
}: ParsedPlatformExternUnits): PlatformExternIndex {
  const browserUnits = allUnits.filter((unit) =>
    unit.fileName.startsWith("browser/"),
  );
  const hasLanguageUnits = allUnits.some(
    (unit) => !unit.fileName.startsWith("browser/"),
  );
  if (!hasLanguageUnits || browserUnits.length === 0) {
    throw new Error(
      "Closure extern archive is missing language or browser sources",
    );
  }

  const mutableByName = new Map<string, PlatformDeclarationUnit[]>();
  const mutableByProperty = new Map<string, PlatformDeclarationUnit[]>();
  const languageNames = new Set<string>();
  const globalNames = new Set<string>();
  const propertyNames = new Set<string>();

  for (const unit of allUnits) {
    for (const name of unit.names) {
      addMapValue(mutableByName, name, unit);
      if (!unit.fileName.startsWith("browser/")) languageNames.add(name);
      else if (!unit.property) globalNames.add(name);
    }
    if (unit.property && unit.fileName.startsWith("browser/")) {
      addMapValue(mutableByProperty, unit.property, unit);
      propertyNames.add(unit.property);
    }
  }
  if (globalNames.size === 0 || propertyNames.size === 0) {
    throw new Error("Closure browser extern index contains no declarations");
  }

  return {
    jarHash,
    browserUnits,
    unitsByName: mutableByName,
    unitsByProperty: mutableByProperty,
    globalNames,
    propertyNames,
    languageNames,
  };
}

function addMapValue(
  map: Map<string, PlatformDeclarationUnit[]>,
  key: string,
  unit: PlatformDeclarationUnit,
) {
  const values = map.get(key);
  if (values) values.push(unit);
  else map.set(key, [unit]);
}
