export function zipExact<Left, Right>(
  left: readonly Left[],
  right: readonly Right[],
  label: string,
): Array<readonly [Left, Right]> {
  if (left.length !== right.length) {
    throw new Error(
      `${label} length mismatch: ${left.length} !== ${right.length}.`,
    );
  }

  const pairs: Array<readonly [Left, Right]> = [];
  const rightIterator = right[Symbol.iterator]();
  for (const leftValue of left) {
    const next = rightIterator.next();
    if (next.done) {
      throw new Error(`${label} ended unexpectedly.`);
    }
    pairs.push([leftValue, next.value]);
  }
  return pairs;
}

export function firstOrUndefined<Value>(values: readonly Value[]) {
  const iterator = values[Symbol.iterator]();
  const first = iterator.next();
  return first.done ? undefined : first.value;
}
