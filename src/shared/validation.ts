export type RuntimePrimitive =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

export type RuntimeValue =
  | RuntimePrimitive
  | RuntimeRecord
  | RuntimeArray
  | RuntimeCallable;

export interface RuntimeArray {
  readonly [index: number]: RuntimeValue;
  readonly length: number;
}

export interface RuntimeRecord {
  [key: string]: RuntimeValue;
}

export interface RuntimeCallable {
  (...arguments_: never[]): RuntimeValue;
}

export type Validator<T> = <Value>(value: Value | T) => value is T;

type PrimitiveKind = "string" | "number" | "boolean" | "other";

function getPrimitiveKind<Value>(value: Value): PrimitiveKind {
  if (Object(value) === value) {
    return "other";
  }

  const tag = Object.prototype.toString.call(value);
  if (tag === "[object String]") {
    return "string";
  }
  if (tag === "[object Number]") {
    return "number";
  }
  if (tag === "[object Boolean]") {
    return "boolean";
  }
  return "other";
}

export function isFunction<Value>(
  value: Value,
): value is Value & RuntimeCallable {
  const tag = Object.prototype.toString.call(value);
  if (
    tag !== "[object Function]" &&
    tag !== "[object AsyncFunction]" &&
    tag !== "[object GeneratorFunction]" &&
    tag !== "[object AsyncGeneratorFunction]"
  ) {
    return false;
  }

  try {
    Function.prototype.toString.call(value);
    return true;
  } catch {
    return false;
  }
}

export function defineValues<const Values extends readonly string[]>(
  ...values: Values
) {
  return values;
}
export function assertNever(value: never): never {
  throw new TypeError(`Unexpected value: ${JSON.stringify(value)}.`);
}

export function isRecord<Value>(value: Value): value is Value & RuntimeRecord {
  return Object(value) === value && !isFunction(value) && !Array.isArray(value);
}

export function isString<Value>(value: Value): value is Value & string {
  return getPrimitiveKind(value) === "string";
}

export function isNumber<Value>(value: Value): value is Value & number {
  return getPrimitiveKind(value) === "number" && Number.isFinite(value);
}

export function isBoolean<Value>(value: Value): value is Value & boolean {
  return getPrimitiveKind(value) === "boolean";
}

export function isUnknownArray<Value>(
  value: Value,
): value is Value & RuntimeValue[] {
  return Array.isArray(value);
}

function isArrayOf<Value, Item>(
  value: Value,
  validate: Validator<Item>,
): value is Value & Item[] {
  return isUnknownArray(value) && value.every(validate);
}

export function isStringArray<Value>(value: Value): value is Value & string[] {
  return isArrayOf(value, isString);
}

export function isRecordOf<Value, Item>(
  value: Value | Record<string, NoInfer<Item>>,
  validate: Validator<Item>,
): value is Record<string, Item> {
  return isRecord(value) && Object.values(value).every(validate);
}

export function optional<T>(validate: Validator<T>): Validator<T | undefined> {
  return <Value>(value: Value): value is Value & (T | undefined) =>
    value === undefined || validate(value);
}

export function arrayOf<T>(validate: Validator<T>): Validator<T[]> {
  return <Value>(value: Value): value is Value & T[] =>
    isArrayOf(value, validate);
}

export function recordOf<T>(
  validate: Validator<T>,
): Validator<Record<string, T>> {
  return <Value>(
    value: Value | Record<string, T>,
  ): value is Record<string, T> => isRecordOf(value, validate);
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
  return <Value>(value: Value): value is Value & T => {
    if (!isRecord(value)) {
      return false;
    }

    for (const key in schema) {
      if (Object.hasOwn(schema, key) && !schema[key](value[key])) {
        return false;
      }
    }
    return true;
  };
}

function isOneOf<Input, const Choice extends string>(
  value: Input,
  choices: readonly Choice[],
): value is Input & Choice {
  if (!isString(value)) {
    return false;
  }
  const stringValue: string = value;
  return choices.some((choice) => choice === stringValue);
}

export function oneOf<const Value extends string>(
  choices: readonly Value[],
): Validator<Value> {
  return <Input>(value: Input): value is Input & Value =>
    isOneOf(value, choices);
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

export function requireChoice<Input, const Value extends string>(
  value: Input,
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

export function hasErrorCode<ErrorValue>(
  error: ErrorValue,
  code: string,
): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const record: RuntimeRecord = error;
  return record.code === code;
}

export function getErrorMessage<ErrorValue>(error: ErrorValue): string {
  return error instanceof Error ? error.message : String(error);
}
