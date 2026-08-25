/**
 * A token that cannot occur in compiled JavaScript, so tokenised text never
 * collides with real source.
 */
export function chunkNameToken(index: number) {
  return `\u0000gcc-chunk-${index}\u0000`;
}

/**
 * Matches only complete quoted strings, not application text containing a
 * chunk name. Closure can emit string literals with all three quote styles.
 */
export function replaceChunkSpecifier(
  sourceText: string,
  fileName: string,
  replacement: string,
) {
  const pattern = new RegExp("([\"'`])" + escapeRegExp(fileName) + "\\1", "gu");
  return sourceText.replace(
    pattern,
    (_match: string, quote: string) => `${quote}${replacement}${quote}`,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function collectReferenceClosure(
  chunkId: string,
  referencesByChunkId: Map<string, Set<string>>,
) {
  const closure = new Set<string>();
  const queue = [...(referencesByChunkId.get(chunkId) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || next === chunkId || closure.has(next)) {
      continue;
    }
    closure.add(next);
    queue.push(...(referencesByChunkId.get(next) ?? []));
  }
  return [...closure].sort((left, right) => left.localeCompare(right));
}
