import type { ExternAnalysisContext } from "./context";
import { analyzeRuntimeUsage } from "./runtime-analysis";
import {
  collectBoundaryAwareExternLines,
  collectBoundaryAwareUsageMemberNames,
} from "./contracts";
import { renderStructuralExternLine } from "./barriers";

/** How the app reads members, split by the syntax Closure sees. */
export interface AppUsageMembers {
  dotAccessed: ReadonlySet<string>;
  stringLiteralRead: ReadonlySet<string>;
}

function createEmptyAppUsageMembers(): AppUsageMembers {
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
  for (const member of runtimeUsage.protocolMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  // Self-referential keys are unconditional: the string that names the key is
  // the whole evidence, and it is already narrow enough that intersecting it
  // with a read class would only lose the hazard it exists to catch (the read
  // goes through a variable and is statically invisible).
  for (const member of runtimeUsage.selfReferentialKeys) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  // Enumerated key names are unconditional for the same reason, and on
  // stronger evidence: the collector already proved the computed access
  // exists, so the read side needs no second witness. The definition side is
  // often invisible anyway — lodash publishes half its surface through
  // `mixin`, which copies under keys taken from `keys(source)`.
  for (const member of runtimeUsage.enumeratedKeyNames) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  // CSS custom-property names are unconditional and need no read witness at
  // all: the consumer is a stylesheet, not JavaScript. There is nothing in the
  // program to intersect with — the only place the name is read back is the
  // `var(--ant-…)` reference the same pass emitted.
  for (const member of runtimeUsage.cssVariableKeyNames) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  for (const member of runtimeUsage.stringDefined) {
    if (
      runtimeUsage.dotAccessed.has(member) ||
      appUsage.dotAccessed.has(member)
    ) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  for (const member of runtimeUsage.dotDefined) {
    if (
      runtimeUsage.stringLiteralRead.has(member) ||
      appUsage.stringLiteralRead.has(member)
    ) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  // Constructed-key reads are invisible statically, so the dot side alone
  // is the evidence: any dot-mentioned member (assignments included —
  // compiled templates assign handlers to plain locals) matching a
  // collected `$`/`_` template prefix must keep its literal name.
  const prefixes = [...runtimeUsage.constructedKeyPrefixes];
  const fragments = [...runtimeUsage.constructedKeyFragments].map(
    (fragment) => {
      const separator = fragment.indexOf(":");
      return {
        side: fragment.slice(0, separator),
        text: fragment.slice(separator + 1),
      };
    },
  );
  if (prefixes.length > 0 || fragments.length > 0) {
    for (const member of [
      ...runtimeUsage.dotAccessed,
      ...appUsage.dotAccessed,
    ]) {
      const matchesPrefix = prefixes.some(
        (prefix) => member.length > prefix.length && member.startsWith(prefix),
      );
      const matchesFragment = fragments.some(
        ({ side, text }) =>
          member.length > text.length &&
          (side === "prefix" ? member.startsWith(text) : member.endsWith(text)),
      );
      if (matchesPrefix || matchesFragment) {
        emittedLines.add(renderStructuralExternLine(member));
      }
    }
  }
  return emittedLines;
}

type GenerateExternsMode = "boundary-aware" | "runtime-aware";

export function renderBoundaryAwareExterns({
  analysis,
  modules,
}: {
  analysis: ExternAnalysisContext;
  modules: string[];
}) {
  return renderExternText({
    emittedLines: collectBoundaryAwareExternLines(analysis),
    mode: "boundary-aware",
    modules,
    scannedFiles: analysis.scannedFiles,
  });
}

export async function renderRuntimeAwareExterns({
  analysis,
  modules,
  protocolHelpers,
  runtimeEntryFiles,
}: {
  analysis: ExternAnalysisContext;
  modules: string[];
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

  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles: analysis.scannedFiles,
  });
}

function renderExternText({
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
  const scannedSummary =
    mode === "runtime-aware"
      ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.`
      : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;

  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    "",
  ].join("\n");
}
