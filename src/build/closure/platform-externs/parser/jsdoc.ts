const TYPE_TAGS = new Set([
  "const",
  "enum",
  "extends",
  "implements",
  "param",
  "return",
  "returns",
  "this",
  "throws",
  "type",
  "typedef",
]);

const TYPE_KEYWORDS = new Set([
  "boolean",
  "function",
  "new",
  "null",
  "number",
  "string",
  "symbol",
  "this",
  "undefined",
  "unknown",
  "void",
]);

/** Extracts qualified nominal references from Closure JSDoc type expressions. */
export function parseClosureTypeReferences(jsdoc: string): Set<string> {
  const references = new Set<string>();
  for (const { expression } of parseTypeTags(jsdoc)) {
    for (const token of tokenizeTypeExpression(expression)) {
      if (!TYPE_KEYWORDS.has(token) && !/^[A-Z]$/.test(token)) {
        references.add(token);
      }
    }
  }
  return references;
}

export function parseHeritageReferences(jsdoc: string): Set<string> {
  const references = new Set<string>();
  for (const { expression, tag } of parseTypeTags(jsdoc)) {
    if (tag !== "extends" && tag !== "implements") continue;
    for (const token of tokenizeTypeExpression(expression)) {
      if (!TYPE_KEYWORDS.has(token)) references.add(token);
    }
  }
  return references;
}

export function parseTemplateNames(jsdoc: string): Set<string> {
  const names = new Set<string>();
  for (const tag of jsdoc.matchAll(/@template\s+([^\n*]+)/g)) {
    for (const name of (tag[1] ?? "").split(/[=,\s]+/)) {
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function parseTypeTags(jsdoc: string): { tag: string; expression: string }[] {
  const tags: { tag: string; expression: string }[] = [];
  for (const match of jsdoc.matchAll(/@([A-Za-z]+)\s*\{/g)) {
    const tag = match[1];
    if (!tag || !TYPE_TAGS.has(tag) || match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const close = findClosingBrace(jsdoc, open);
    if (close > open)
      tags.push({ tag, expression: jsdoc.slice(open + 1, close) });
  }
  for (const match of jsdoc.matchAll(
    /@(extends|implements)\s+([A-Za-z_$][\w$.]*)/g,
  )) {
    const tag = match[1];
    const expression = match[2];
    if (tag && expression) tags.push({ tag, expression });
  }
  return tags;
}

function findClosingBrace(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function tokenizeTypeExpression(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (!char || !/[A-Za-z_$]/.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < source.length && /[\w$]/.test(source[index] ?? ""))
      index += 1;
    while (source[index] === ".") {
      const dot = index;
      index += 1;
      if (!/[A-Za-z_$]/.test(source[index] ?? "")) {
        index = dot;
        break;
      }
      index += 1;
      while (index < source.length && /[\w$]/.test(source[index] ?? ""))
        index += 1;
    }
    let next = index;
    while (/\s/.test(source[next] ?? "")) next += 1;
    if (source[next] !== ":") tokens.push(source.slice(start, index));
  }
  return tokens;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return index;
}
