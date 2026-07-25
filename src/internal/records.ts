export function toRecord<Value>(
  entries: Iterable<readonly [string, Value]>,
): Record<string, Value> {
  const record: Record<string, Value> = {};
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
}
