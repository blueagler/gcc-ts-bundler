import type { ExternAnalysisContext } from "./context";
import type { GenerateExternsMode } from "./generate/options";
import { analyzeRuntimeUsage } from "./runtime";
import {
  collectBoundaryAwareExternLines,
  collectBoundaryAwareUsageMemberNames,
} from "./contracts/usage";
import { applyPropertyPolicy, type PropertyPolicy } from "./property-policy";
import { renderStructuralExternLine } from "./barriers";

/** How the app reads members, split by the syntax Closure sees. */
export interface AppUsageMembers {
  dotAccessed: ReadonlySet<string>;
  stringLiteralRead: ReadonlySet<string>;
}

export function createEmptyAppUsageMembers(): AppUsageMembers {
  return { dotAccessed: new Set(), stringLiteralRead: new Set() };
}

/**
 * Extern lines for runtime protocol members plus genuinely mixed definition /
 * read pairs:
 *
 * ```
 * extern = protocolMembers
 *        ∪ selfReferentialKeys
 *        ∪ enumeratedKeyNames
 *        ∪ cssVariableKeyNames
 *        ∪ (stringDefined ∩ dotAccessed)
 *        ∪ (dotDefined    ∩ stringLiteralRead)
 *        ∪ (dotAccessed   ∩ constructedKeyPrefix match)
 *        ∪ (dotAccessed   ∩ constructedKeyFragment match)
 * ```
 *
 * The last class covers keys assembled at runtime from an identifier-shaped
 * `$`/`_` template head (`` node[`$evt${type}`] `` in vue vapor's event
 * delegation): the read is statically invisible, but a dot-defined member
 * starting with a collected prefix is reached through it.
 *
 * The fragment class is the `+`-concatenation form of the same hazard, and the
 * one that broke jQuery: `deferred[tuple[0] + "With"] = list.fireWith` defines
 * `resolveWith` through an invisible key, `readyList.resolveWith(…)` reads it
 * with a dot, and only the dot side renames.
 *
 * A member that is dot-defined *and* dot-accessed renames consistently inside
 * one Closure invocation and must NOT be externed — externing it (and the
 * native property quoting an extern drives) is what previously neutralised
 * typed-annotation optimisation on ordinary app domain fields.
 */
export function collectRuntimeUsageExternLines(
  runtimeUsage: {
    constructedKeyFragments: ReadonlySet<string>;
    constructedKeyPrefixes: ReadonlySet<string>;
    cssVariableKeyNames: Iterable<string>;
    dotAccessed: ReadonlySet<string>;
    dotDefined: Iterable<string>;
    enumeratedKeyNames: Iterable<string>;
    protocolMembers: Iterable<string>;
    selfReferentialKeys: Iterable<string>;
    stringDefined: Iterable<string>;
    stringLiteralRead: ReadonlySet<string>;
  },
  appUsage: AppUsageMembers,
): Set<string> {
  const emittedLines = new Set<string>();
  addStructuralExternLines(emittedLines, runtimeUsage.protocolMembers);
  // Self-referential keys are unconditional: the string that names the key is
  // the whole evidence, and it is already narrow enough that intersecting it
  // with a read class would only lose the hazard it exists to catch (the read
  // goes through a variable and is statically invisible).
  addStructuralExternLines(emittedLines, runtimeUsage.selfReferentialKeys);
  // Enumerated key names are unconditional for the same reason, and on
  // stronger evidence: the collector already proved the computed access
  // exists, so the read side needs no second witness. The definition side is
  // often invisible anyway — lodash publishes half its surface through
  // `mixin`, which copies under keys taken from `keys(source)`.
  addStructuralExternLines(emittedLines, runtimeUsage.enumeratedKeyNames);
  // CSS custom-property names are unconditional and need no read witness at
  // all: the consumer is a stylesheet, not JavaScript. There is nothing in the
  // program to intersect with — the only place the name is read back is the
  // `var(--ant-…)` reference the same pass emitted.
  addStructuralExternLines(emittedLines, runtimeUsage.cssVariableKeyNames);
  addWitnessedExternLines(
    emittedLines,
    runtimeUsage.stringDefined,
    runtimeUsage.dotAccessed,
    appUsage.dotAccessed,
  );
  addWitnessedExternLines(
    emittedLines,
    runtimeUsage.dotDefined,
    runtimeUsage.stringLiteralRead,
    appUsage.stringLiteralRead,
  );
  // Constructed-key reads are invisible statically, so the dot side alone
  // is the evidence: any dot-mentioned member (assignments included —
  // compiled templates assign handlers to plain locals) matching a
  // collected `$`/`_` template prefix must keep its literal name.
  addConstructedKeyExternLines(
    emittedLines,
    [...runtimeUsage.constructedKeyPrefixes],
    parseConstructedKeyFragments(runtimeUsage.constructedKeyFragments),
    runtimeUsage.dotAccessed,
    appUsage.dotAccessed,
  );
  return emittedLines;
}

/** A constructed-key fragment: the literal text and which end it anchors to. */
interface ConstructedKeyFragment {
  side: string;
  text: string;
}

function parseConstructedKeyFragments(
  fragments: Iterable<string>,
): ConstructedKeyFragment[] {
  const parsed: ConstructedKeyFragment[] = [];
  for (const fragment of fragments) {
    const separator = fragment.indexOf(":");
    parsed.push({
      side: fragment.slice(0, separator),
      text: fragment.slice(separator + 1),
    });
  }
  return parsed;
}

/** Members whose own name is the whole evidence, needing no read witness. */
function addStructuralExternLines(
  emittedLines: Set<string>,
  members: Iterable<string>,
) {
  for (const member of members) {
    emittedLines.add(renderStructuralExternLine(member));
  }
}

/**
 * Members externed only where the opposite syntax witnesses a read: a member
 * defined and read through the same syntax renames consistently inside one
 * Closure invocation and must not be externed.
 */
function addWitnessedExternLines(
  emittedLines: Set<string>,
  members: Iterable<string>,
  runtimeWitness: ReadonlySet<string>,
  appWitness: ReadonlySet<string>,
) {
  for (const member of members) {
    if (runtimeWitness.has(member) || appWitness.has(member)) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
}

function addConstructedKeyExternLines(
  emittedLines: Set<string>,
  prefixes: readonly string[],
  fragments: readonly ConstructedKeyFragment[],
  runtimeDotAccessed: ReadonlySet<string>,
  appDotAccessed: ReadonlySet<string>,
) {
  if (prefixes.length === 0 && fragments.length === 0) return;
  for (const member of [...runtimeDotAccessed, ...appDotAccessed]) {
    addConstructedKeyMember(emittedLines, member, prefixes, fragments);
  }
}

function addConstructedKeyMember(
  emittedLines: Set<string>,
  member: string,
  prefixes: readonly string[],
  fragments: readonly ConstructedKeyFragment[],
) {
  if (
    !matchesConstructedKeyPrefix(member, prefixes) &&
    !matchesConstructedKeyFragment(member, fragments)
  ) {
    return;
  }
  emittedLines.add(renderStructuralExternLine(member));
}

function matchesConstructedKeyPrefix(
  member: string,
  prefixes: readonly string[],
) {
  for (const prefix of prefixes) {
    if (member.length > prefix.length && member.startsWith(prefix)) return true;
  }
  return false;
}

function matchesConstructedKeyFragment(
  member: string,
  fragments: readonly ConstructedKeyFragment[],
) {
  for (const { side, text } of fragments) {
    if (member.length <= text.length) continue;
    if (side === "prefix" ? member.startsWith(text) : member.endsWith(text)) {
      return true;
    }
  }
  return false;
}

export function renderBoundaryAwareExterns({
  analysis,
  modules,
  propertyPolicy,
}: {
  analysis: ExternAnalysisContext;
  modules: string[];
  propertyPolicy?: PropertyPolicy | undefined;
}) {
  const emittedLines = collectBoundaryAwareExternLines(analysis);
  applyPropertyPolicy(emittedLines, propertyPolicy);
  return renderExternText({
    emittedLines,
    mode: "boundary-aware",
    modules,
    scannedFiles: analysis.scannedFiles,
  });
}

export async function renderRuntimeAwareExterns({
  analysis,
  modules,
  propertyPolicy,
  protocolHelpers,
  runtimeEntryFiles,
}: {
  analysis: ExternAnalysisContext;
  modules: string[];
  propertyPolicy?: PropertyPolicy | undefined;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
  runtimeEntryFiles: string[];
}) {
  // Boundary-aware usage is type-derived: members the app reaches through a
  // contract, which it always spells as a dot access.
  const appUsage: AppUsageMembers =
    analysis.appEntryFiles.length > 0
      ? {
          dotAccessed: collectBoundaryAwareUsageMemberNames(analysis),
          stringLiteralRead: new Set<string>(),
        }
      : createEmptyAppUsageMembers();
  const runtimeUsage = await analyzeRuntimeUsage(
    runtimeEntryFiles,
    protocolHelpers,
  );
  const emittedLines = collectRuntimeUsageExternLines(runtimeUsage, appUsage);
  applyPropertyPolicy(emittedLines, propertyPolicy);

  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles: analysis.scannedFiles,
  });
}

export function renderExternText({
  emittedLines,
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles,
}: {
  emittedLines: Set<string>;
  mode: GenerateExternsMode;
  modules: string[];
  runtimeEntryFiles?: string[];
  scannedFiles: string[];
}) {
  return [
    ...renderExternHeaderLines({
      mode,
      modules,
      runtimeEntryFiles,
      scannedFiles,
    }),
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    "",
  ].join("\n");
}

function renderExternHeaderLines({
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles,
}: {
  mode: GenerateExternsMode;
  modules: string[];
  runtimeEntryFiles?: string[];
  scannedFiles: string[];
}): string[] {
  const scannedSummary =
    mode === "runtime-aware"
      ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.`
      : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;

  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.map((specifier) => specifier.replace(/[\r\n]+/gu, " ")).join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
  ];
}
