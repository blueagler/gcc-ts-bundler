export type Validator<T> = (value: unknown) => value is T;

export function defineValues<const Values extends readonly string[]>(
  ...values: Values
) {
  return values;
}

export function assertNever(value: never): never {
  throw new TypeError(`Unexpected value: ${JSON.stringify(value)}.`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isArrayOf<T>(value: unknown, validate: Validator<T>): value is T[] {
  return isUnknownArray(value) && value.every(validate);
}

export function isStringArray(value: unknown): value is string[] {
  return isArrayOf(value, isString);
}

export function isRecordOf<T>(
  value: unknown,
  validate: Validator<T>,
): value is Record<string, T> {
  return isRecord(value) && Object.values(value).every(validate);
}

export function optional<T>(validate: Validator<T>): Validator<T | undefined> {
  return (value: unknown): value is T | undefined =>
    value === undefined || validate(value);
}

export function arrayOf<T>(validate: Validator<T>): Validator<T[]> {
  return (value: unknown): value is T[] => isArrayOf(value, validate);
}

export function recordOf<T>(
  validate: Validator<T>,
): Validator<Record<string, T>> {
  return (value: unknown): value is Record<string, T> =>
    isRecordOf(value, validate);
}

/**
 * A validator per property, required for every key of `T`.
 *
 * Omitting a key is a compile error, so adding a field to `T` without
 * extending its schema cannot silently produce a validator that accepts
 * data missing that field.
 */
export type ObjectSchema<T> = { [Key in keyof T]-?: Validator<T[Key]> };

export function isObjectOf<T>(schema: ObjectSchema<T>): Validator<T> {
  const properties = Object.entries<Validator<unknown>>(schema);
  return (value: unknown): value is T =>
    isRecord(value) &&
    properties.every(([key, validate]) => validate(value[key]));
}

function isOneOf<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
): value is Value {
  return (
    typeof value === "string" && choices.some((choice) => choice === value)
  );
}

export function oneOf<const Value extends string>(
  choices: readonly Value[],
): Validator<Value> {
  return (value: unknown): value is Value => isOneOf(value, choices);
}

export function parseChoice<const Value extends string>(
  value: string | undefined,
  choices: readonly Value[],
  optionName: string,
): Value | undefined {
  if (value === undefined) {
    return undefined;
  }

  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    throw new TypeError(
      `${optionName} must be one of: ${choices.join(", ")}. Received ${JSON.stringify(value)}.`,
    );
  }
  return choice;
}

export function requireChoice<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  optionName: string,
): Value {
  if (isOneOf(value, choices)) {
    return value;
  }
  throw new TypeError(
    `${optionName} must be one of: ${choices.join(", ")}. Received ${JSON.stringify(value)}.`,
  );
}

export function parseJson<T>(
  text: string,
  validate: Validator<T>,
  source: string,
): T {
  const value: unknown = JSON.parse(text);
  if (validate(value)) {
    return value;
  }
  throw new TypeError(`Invalid JSON structure in ${source}.`);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
