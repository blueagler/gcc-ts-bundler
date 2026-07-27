import fs from "fs/promises";
import { createRequire } from "module";
import zlib from "zlib";

/**
 * Minimal platform externs for `--env CUSTOM`.
 *
 * Closure's built-in browser externs are ~2.2MB of typed IDL that inflate
 * the type graph and property universe of every compiler pass — measured at
 * roughly half of total compile time. Instead, this module extracts the
 * platform name universe from the version-matched `externs.zip` inside the
 * shipped `compiler.jar`, intersects it with the property names the program
 * actually references, and emits a small flat externs file:
 *
 * - every platform global as `var Name;` (globals are cheap and a missing
 *   one is a hard compile error, so all of them are declared);
 * - `Object.prototype.name;` for each referenced platform property.
 *
 * Soundness: ADVANCED renames a property only where it appears as a
 * syntactic member access. Every syntactic member access in the inputs is
 * collected, so any platform property that could be renamed is declared.
 */

interface PlatformExternsUniverse {
  /** Globals declared as functions in the platform externs (constructors
   * and callables). Declaring these as bare `var X;` makes every type that
   * extends or consumes them unknown, which silently disables all
   * type-based optimization (see docs/research/typed-input.md §4c). */
  functionGlobals: ReadonlySet<string>;
  globals: readonly string[];
  properties: ReadonlySet<string>;
  /**
   * Keys of extern record types (`ShadowRootInit.mode`, event-init dicts).
   * Programs pass these as object-literal keys — not member accesses — so
   * literal keys in the input must be checked against this set separately.
   */
  recordKeys: ReadonlySet<string>;
}

const requireFromHere = createRequire(import.meta.url);

let universePromise: Promise<PlatformExternsUniverse | null> | undefined;

function loadPlatformExternsUniverse() {
  universePromise ??= buildUniverse().catch(() => null);
  return universePromise;
}

export async function generatePlatformExternsText(
  jsFiles: readonly string[],
  { typedConstructors = false }: { typedConstructors?: boolean } = {},
): Promise<string | null> {
  const universe = await loadPlatformExternsUniverse();
  if (!universe) {
    return null;
  }
  const referenced = new Set<string>();
  for (const filePath of jsFiles) {
    let source: string;
    try {
      source = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
    addMatches(source, MEMBER_ACCESS_PATTERN, referenced);
    // Object-literal keys that name extern record-type members
    // (`attachShadow({mode: "open"})`) must survive renaming even though
    // they never appear as member accesses.
    const literalKeys = new Set<string>();
    addMatches(source, LITERAL_KEY_PATTERN, literalKeys);
    for (const key of literalKeys) {
      if (universe.recordKeys.has(key)) {
        referenced.add(key);
      }
    }
  }
  const lines = ["/** @externs */"];
  for (const globalName of universe.globals) {
    // `var X;` leaves the platform type unknown, and an unknown superclass
    // makes every subclass unknown too, which silently disables all
    // type-based passes for it — in a controlled probe that turned a 70%
    // typed-input win into byte-identical output
    // (docs/research/typed-input.md §4c).
    //
    // Declaring them as constructors recovers the entire win, but only when
    // there are types to propagate: on untyped input the extra declarations
    // measured +134 B gzip for nothing (Addendum). So it is gated on the
    // build actually carrying typed annotations, not enabled outright.
    lines.push(
      typedConstructors && universe.functionGlobals.has(globalName)
        ? `/** @constructor */ function ${globalName}() {}`
        : `var ${globalName};`,
    );
  }
  for (const property of [...referenced].sort()) {
    if (universe.properties.has(property)) {
      lines.push(`Object.prototype.${property};`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Syntactic member accesses: `x.name`, `x?.name`, `x.name(...)`. */
const MEMBER_ACCESS_PATTERN = /\.\s*([A-Za-z_$][\w$]*)/g;

/** Object-literal keys: `{name: value}`. Over-captures labels/cases (safe). */
const LITERAL_KEY_PATTERN = /(?:[{,(]|^)\s*([A-Za-z_$][\w$]*)\s*:/gm;

async function buildUniverse(): Promise<PlatformExternsUniverse | null> {
  const jarPath = resolveCompilerJarPath();
  if (!jarPath) {
    return null;
  }
  const jar = await fs.readFile(jarPath);
  const externsZip = readZipEntries(jar).get("externs.zip");
  if (!externsZip) {
    return null;
  }
  const globals = new Set<string>();
  const functionGlobals = new Set<string>();
  const properties = new Set<string>();
  const recordKeys = new Set<string>();
  for (const [name, content] of readZipEntries(externsZip)) {
    if (!name.endsWith(".js")) {
      continue;
    }
    const source = content.toString("utf-8");
    addMatches(source, /^\s*var\s+([A-Za-z_$][\w$]*)/gm, globals);
    addMatches(source, /^\s*function\s+([A-Za-z_$][\w$]*)/gm, functionGlobals);
    addMatches(source, MEMBER_ACCESS_PATTERN, properties);
    // Record-type keys (`{capture: boolean}`) and interface members.
    addMatches(source, /([A-Za-z_$][\w$]*)\s*:/g, recordKeys);
  }
  for (const name of functionGlobals) {
    globals.add(name);
  }
  if (globals.size === 0 || properties.size === 0) {
    return null;
  }
  for (const key of recordKeys) {
    properties.add(key);
  }
  // Globals are reachable as namespace properties too (`window.document`).
  for (const globalName of globals) {
    properties.add(globalName);
  }
  return {
    functionGlobals,
    globals: [...globals].sort(),
    properties,
    recordKeys,
  };
}

function addMatches(source: string, pattern: RegExp, target: Set<string>) {
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      target.add(name);
    }
  }
}

function resolveCompilerJarPath(): string | null {
  try {
    const packageJsonPath = requireFromHere.resolve(
      "google-closure-compiler-java/package.json",
    );
    return packageJsonPath.replace(/package\.json$/, "compiler.jar");
  } catch {
    return null;
  }
}

/**
 * Minimal ZIP reader (stored + deflate entries) using the central directory.
 * Enough for `compiler.jar` and its embedded `externs.zip`.
 */
function readZipEntries(archive: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocdOffset = findEndOfCentralDirectory(archive);
  if (eocdOffset < 0) {
    return entries;
  }
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = archive.readUInt32LE(eocdOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      break;
    }
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf-8");
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart =
      localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (compressionMethod === 0) {
      entries.set(name, Buffer.from(data));
    } else if (compressionMethod === 8) {
      entries.set(name, zlib.inflateRawSync(data));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, archive.length - 22 - maxCommentLength);
  for (let offset = archive.length - 22; offset >= searchStart; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  return -1;
}
