export function injectBundlerRuntimeEs5HelperBag(
  code: string,
  helperBag: string,
) {
  if (!helperBag) {
    return code;
  }
  const runtimeAlias = findBundlerRuntimeFinalizeAlias(code);
  const markers = runtimeAlias
    ? [`${runtimeAlias}.u(`, `${runtimeAlias}.n(`]
    : ["G.u(", "globalThis.__g.u(", 'globalThis["__g"].u('];
  for (const marker of markers) {
    const markerIndex = code.lastIndexOf(marker);
    if (markerIndex !== -1) {
      return `${code.slice(0, markerIndex)}${helperBag}${code.slice(markerIndex)}`;
    }
  }
  return `${code}${helperBag}`;
}

export function canonicalizeBundlerRuntimeRootAccess(code: string) {
  if (!code.includes("var G=globalThis.__g,_=G._")) {
    return code;
  }
  let next = code
    .replaceAll("globalThis.__g.", "G.")
    .replaceAll('globalThis["__g"].', "G.");
  for (const runtimeAlias of findBundlerRuntimeRootAliases(next)) {
    if (runtimeAlias === "G") {
      continue;
    }
    next = next.replaceAll(`${runtimeAlias}.`, "G.");
    next = stripStandaloneRuntimeAlias(next, runtimeAlias);
  }
  return next;
}

export function findBundlerRuntimeFinalizeAlias(code: string) {
  const aliases = findBundlerRuntimeRootAliases(code);
  for (const alias of aliases) {
    if (code.includes(`${alias}.u(`) || code.includes(`${alias}.n(`)) {
      return alias;
    }
  }
  return undefined;
}

export function wrapBundlerRuntimeOutputFile(code: string) {
  const trimmed = code.trimEnd();
  return `!function(){\n${trimmed}\n}();\n`;
}

function findBundlerRuntimeRootAliases(code: string) {
  const aliases = new Set<string>();
  for (const pattern of [
    /\bvar\s+([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=[,;])/g,
    /,([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=[,;])/g,
    /(?:^|[;(])([A-Za-z_$][\w$]*)=globalThis(?:\.__g|\["__g"\])(?=;)/gm,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const alias = match[1];
      if (alias !== undefined) {
        aliases.add(alias);
      }
    }
  }
  return [...aliases];
}

function stripStandaloneRuntimeAlias(code: string, runtimeAlias: string) {
  const escapedAlias = escapeRegex(runtimeAlias);
  return code
    .replace(
      new RegExp(
        `\\bvar ${escapedAlias}=globalThis(?:\\.__g|\\["__g"\\]);(?=G\\.)`,
        "g",
      ),
      "",
    )
    .replace(
      new RegExp(
        `(^|[;\\n])${escapedAlias}=globalThis(?:\\.__g|\\["__g"\\]);(?=G\\.)`,
        "gm",
      ),
      "$1",
    )
    .replace(/\n{3,}/g, "\n\n");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
