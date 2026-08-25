type NamedImportBinding = {
  imported: string;
  local: string;
};

type MergedSpecifierImport = {
  defaults: string[];
  named: NamedImportBinding[];
  namespaces: string[];
};

export type OutputImportState = {
  bySpecifier: Map<string, MergedSpecifierImport>;
  order: string[];
};

export function addPreservedImportClause(
  merged: MergedSpecifierImport,
  clause: string,
) {
  if (!clause) {
    return;
  }
  const parsed = parsePreservedImportClause(clause);
  if (parsed.defaultLocal && !merged.defaults.includes(parsed.defaultLocal)) {
    merged.defaults.push(parsed.defaultLocal);
  }
  if (
    parsed.namespaceLocal &&
    !merged.namespaces.includes(parsed.namespaceLocal)
  ) {
    merged.namespaces.push(parsed.namespaceLocal);
  }
  for (const named of parsed.named) {
    if (
      !merged.named.some(
        (existing) =>
          existing.imported === named.imported &&
          existing.local === named.local,
      )
    ) {
      merged.named.push(named);
    }
  }
}

function parsePreservedImportClause(clause: string): {
  defaultLocal?: string;
  named: NamedImportBinding[];
  namespaceLocal?: string;
} {
  const trimmed = clause.trim();
  if (trimmed.startsWith("{")) {
    return { named: parseNamedImportBindings(trimmed) };
  }
  const namespaceOnly = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/u);
  if (namespaceOnly?.[1]) {
    return { named: [], namespaceLocal: namespaceOnly[1] };
  }
  const defaultAndRest = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*(.*))?$/u);
  if (!defaultAndRest?.[1]) {
    throw new Error(`Unsupported preserved import clause: ${clause}`);
  }
  const defaultLocal = defaultAndRest[1];
  const rest = defaultAndRest[2]?.trim();
  if (!rest) {
    return { defaultLocal, named: [] };
  }
  const namespaceRest = rest.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/u);
  if (namespaceRest?.[1]) {
    return {
      defaultLocal,
      named: [],
      namespaceLocal: namespaceRest[1],
    };
  }
  if (rest.startsWith("{")) {
    return { defaultLocal, named: parseNamedImportBindings(rest) };
  }
  throw new Error(`Unsupported preserved import clause: ${clause}`);
}

function parseNamedImportBindings(block: string): NamedImportBinding[] {
  const inner = block.trim();
  if (!inner.startsWith("{") || !inner.endsWith("}")) {
    throw new Error(`Unsupported named import clause: ${block}`);
  }
  const body = inner.slice(1, -1).trim();
  if (!body) {
    return [];
  }
  return splitCommaSeparated(body).map((part) => {
    const match = part.match(
      /^(?:([A-Za-z_$][\w$]*)|("(?:[^"\\]|\\.)*"))\s+as\s+([A-Za-z_$][\w$]*)$/u,
    );
    if (!match?.[3]) {
      throw new Error(`Unsupported named import binding: ${part}`);
    }
    const imported = match[1] ?? (JSON.parse(match[2]!) as string);
    return { imported, local: match[3] };
  });
}

function splitCommaSeparated(value: string) {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      current += character;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      current += character;
      continue;
    }
    if (character === ",") {
      const part = current.trim();
      if (part) {
        parts.push(part);
      }
      current = "";
      continue;
    }
    current += character;
  }
  const last = current.trim();
  if (last) {
    parts.push(last);
  }
  return parts;
}

export function renderMergedSpecifierImport(
  specifier: string,
  merged: MergedSpecifierImport,
) {
  const specifierLiteral = JSON.stringify(specifier);
  const aliasLines: string[] = [];
  const defaultLocal = merged.defaults[0];
  for (const extra of merged.defaults.slice(1)) {
    if (defaultLocal) {
      aliasLines.push(`const ${extra} = ${defaultLocal};`);
    }
  }
  const namespaceLocal = merged.namespaces[0];
  for (const extra of merged.namespaces.slice(1)) {
    if (namespaceLocal) {
      aliasLines.push(`const ${extra} = ${namespaceLocal};`);
    }
  }
  let named = merged.named;
  if (named.length > 0 && namespaceLocal) {
    for (const binding of named) {
      const source = /^[A-Za-z_$][\w$]*$/u.test(binding.imported)
        ? `${namespaceLocal}.${binding.imported}`
        : `${namespaceLocal}[${JSON.stringify(binding.imported)}]`;
      aliasLines.push(`const ${binding.local} = ${source};`);
    }
    named = [];
  }
  const clause = formatPreservedImportClause(
    defaultLocal,
    namespaceLocal,
    named,
  );
  return {
    aliasLines,
    importLine: clause
      ? `import ${clause} from ${specifierLiteral};`
      : `import ${specifierLiteral};`,
  };
}

function formatPreservedImportClause(
  defaultLocal: string | undefined,
  namespaceLocal: string | undefined,
  named: NamedImportBinding[],
) {
  const namedClause =
    named.length === 0
      ? ""
      : `{ ${named
          .map((binding) => {
            const imported = /^[A-Za-z_$][\w$]*$/u.test(binding.imported)
              ? binding.imported
              : JSON.stringify(binding.imported);
            return `${imported} as ${binding.local}`;
          })
          .join(", ")} }`;
  if (defaultLocal && namespaceLocal) {
    return `${defaultLocal}, * as ${namespaceLocal}`;
  }
  if (defaultLocal && namedClause) {
    return `${defaultLocal}, ${namedClause}`;
  }
  if (defaultLocal) {
    return defaultLocal;
  }
  if (namespaceLocal) {
    return `* as ${namespaceLocal}`;
  }
  return namedClause;
}
