import ts from "@typescript/typescript6";

import { firstOrUndefined } from "./arrays";
import { uniqueSortedStrings } from "./files";

/**
 * The primitive arms the metadata renderer and the externs renderer agree on.
 *
 * Only these six: the metadata renderer also spells `bigint` and `symbol`, and
 * the externs renderer also collapses `any` / `unknown` / `never` to `?`. Those
 * belong to one Closure target each, so every caller layers its own arms in
 * front of this call rather than pushing them down here. The order inside is
 * load-bearing — `StringLike` before `NumberLike` before `BooleanLike` — since a
 * single type can carry more than one `*Like` bit.
 */
export function commonPrimitiveClosureType(type: ts.Type): string | undefined {
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  return undefined;
}

export function unionClosureTypes(types: string[]) {
  const unique = uniqueSortedStrings(types.flatMap(expandClosureUnionType));
  const onlyType = firstOrUndefined(unique);
  return unique.length === 1 && onlyType !== undefined
    ? onlyType
    : `(${unique.join("|")})`;
}

function expandClosureUnionType(type: string): string[] {
  return type.startsWith("(") && type.endsWith(")")
    ? splitTopLevelUnion(type.slice(1, -1))
    : [type];
}

export function stripUndefinedFromClosureType(type: string) {
  if (type === "undefined") {
    return "?";
  }
  if (!type.includes("undefined")) {
    return type;
  }
  if (!type.startsWith("(") || !type.endsWith(")")) {
    return type;
  }
  const parts = splitTopLevelUnion(type.slice(1, -1)).filter(
    (part) => part !== "undefined",
  );
  const onlyPart = firstOrUndefined(parts);
  return parts.length === 0
    ? "?"
    : parts.length === 1 && onlyPart !== undefined
      ? onlyPart
      : `(${parts.join("|")})`;
}

function splitTopLevelUnion(type: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < type.length; index += 1) {
    const char = type[index];
    if (char === "<" || char === "(" || char === "{") {
      depth += 1;
    } else if (char === ">" || char === ")" || char === "}") {
      depth -= 1;
    } else if (char === "|" && depth === 0) {
      parts.push(type.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(type.slice(start));
  return parts;
}

export function unionWithSuffix(base: string, suffix: string[]) {
  const rendered = uniqueSortedStrings([base, ...suffix]);
  const onlyType = firstOrUndefined(rendered);
  return rendered.length === 1 && onlyType !== undefined
    ? onlyType
    : `(${rendered.join("|")})`;
}

export function renderPrototypeProperty(
  typeName: string,
  propertyName: string,
) {
  return isClosureIdentifier(propertyName)
    ? `${typeName}.prototype.${propertyName};`
    : `${typeName}.prototype[${JSON.stringify(propertyName)}];`;
}

export function sanitizeClosureName(name: string) {
  const sanitized = name.replace(/[^A-Za-z0-9_$]/gu, "_");
  if (!sanitized || /^[0-9]/u.test(sanitized)) {
    return `_${sanitized}`;
  }
  return sanitized;
}

function isClosureIdentifier(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

export function isClosureQualifiedName(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(
    name,
  );
}
