interface RecordOwner<Value> {
  [key: string]: Value;
}

export function toRecord<Value>(
  entries: Iterable<readonly [string, Value]>,
): RecordOwner<Value> {
  const record: RecordOwner<Value> = {};
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
}
