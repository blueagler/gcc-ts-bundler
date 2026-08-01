import { createHash } from "node:crypto";

import * as ts from "@typescript/typescript6";

import {
  parseClosureTypeReferences,
  parseHeritageReferences,
  parseTemplateNames,
} from "./closure-type-parser";
import { parseJavaScriptSource } from "./typescript-parser";
import { readCachedUnits, writeCachedUnits } from "./unit-cache";
import type {
  ParsedPlatformExternUnits,
  PlatformDeclarationUnit,
  PlatformExternArchive,
  PlatformExternIndex,
  PlatformExternSource,
} from "./types";

const indexPromises = new Map<string, Promise<PlatformExternIndex>>();

/**
 * Identity of the code that turns the archive into units.
 *
 * The cache payload is a pure function of (archive, this parser). The archive
 * half is `jarHash`; this is the other half. It used to be a hand-bumped
 * `CACHE_VERSION`, which is a guard only for as long as everyone remembers it —
 * and forgetting is silent, because a stale payload yields a wrong slice whose
 * failure mode is an invisible full-externs recompile.
 *
 * Deriving it from the functions' own source removes the manual step: change
 * how a unit is built and the digest moves, so every machine reparses. A
 * bundler that reformats these bodies without a source change only costs one
 * reparse, which is the safe direction to be wrong in.
 */
let parserDigest: string | undefined;

export function platformExternParserDigest(): string {
  parserDigest ??= createHash("sha256")
    .update(
      [
        parsePlatformExternUnits,
        indexPlatformExternUnits,
        parseDeclarationUnits,
        declarationNames,
        rhsQualifiedNames,
        qualifiedName,
        memberIdentity,
        addNamespaceParents,
        parseClosureTypeReferences,
        parseHeritageReferences,
        parseTemplateNames,
        parseJavaScriptSource,
      ]
        .map((fn) => fn.toString())
        .join("\u0000"),
    )
    .digest("hex")
    .slice(0, 16);
  return parserDigest;
}

/**
 * Per-process memo *and* a cross-process disk cache.
 *
 * Splitting the archive into ~13k declaration units costs ~830 ms of
 * TypeScript parsing, and the memo below dies with the process, so every build
 * invocation used to pay it in full — including builds whose Closure job was a
 * cache hit and never ran. The parse is a pure function of the jar, so it is
 * keyed by `jarHash` and persisted; only the cheap map-building step (~20 ms)
 * is repeated.
 */
export function getPlatformExternIndex(
  archive: PlatformExternArchive,
  options: PlatformExternIndexOptions,
) {
  // The memo is keyed by the cache root too: two roots are two caches, and
  // collapsing them would hand a caller the other one's entry.
  const key = `${options.cacheRoot}\u0000${archive.jarHash}`;
  let promise = indexPromises.get(key);
  if (!promise) {
    promise = loadPlatformExternIndex(archive, options);
    indexPromises.set(key, promise);
    promise.catch(() => indexPromises.delete(key));
  }
  return promise;
}

export interface PlatformExternIndexOptions {
  /**
   * Root of the shared on-disk unit cache. Required rather than defaulted:
   * the entry is keyed only by its inputs and is therefore shared by every
   * project on the machine, so a caller that has not thought about which cache
   * it is writing (a test, most of all) should not be able to reach it.
   */
  cacheRoot: string;
}

async function loadPlatformExternIndex(
  archive: PlatformExternArchive,
  options: PlatformExternIndexOptions,
) {
  const key = {
    cacheRoot: options.cacheRoot,
    jarHash: archive.jarHash,
    schemaDigest: platformExternParserDigest(),
  };
  const cached = await readCachedUnits(key);
  if (cached) return indexPlatformExternUnits(cached);
  const parsed = await parsePlatformExternUnits(archive);
  // Best-effort: a cold or unwritable cache must never fail a build.
  await writeCachedUnits(key, parsed);
  return indexPlatformExternUnits(parsed);
}

export async function buildPlatformExternIndex(
  archive: PlatformExternArchive,
): Promise<PlatformExternIndex> {
  return indexPlatformExternUnits(await parsePlatformExternUnits(archive));
}

/** The expensive half: TypeScript-parse every archive entry into units. */
export async function parsePlatformExternUnits(
  archive: PlatformExternArchive,
): Promise<ParsedPlatformExternUnits> {
  const languageSources: PlatformExternSource[] = [];
  const allUnits: PlatformDeclarationUnit[] = [];

  const archiveEntries = await archive.entries();
  for (const [fileOrder, entry] of archiveEntries.entries()) {
    const units = parseDeclarationUnits(entry, fileOrder);
    if (!entry.name.startsWith("browser/")) languageSources.push(entry);
    allUnits.push(...units);
  }
  return { allUnits, jarHash: archive.jarHash, languageSources };
}

/** The cheap half: group parsed units into lookup maps. */
export function indexPlatformExternUnits({
  allUnits,
  jarHash,
  languageSources,
}: ParsedPlatformExternUnits): PlatformExternIndex {
  const browserUnits = allUnits.filter((unit) =>
    unit.fileName.startsWith("browser/"),
  );
  if (languageSources.length === 0 || browserUnits.length === 0) {
    throw new Error(
      "Closure extern archive is missing language or browser sources",
    );
  }

  const mutableByName = new Map<string, PlatformDeclarationUnit[]>();
  const mutableByProperty = new Map<string, PlatformDeclarationUnit[]>();
  const languageNames = new Set<string>();
  const globalNames = new Set<string>();
  const propertyNames = new Set<string>();

  for (const unit of allUnits) {
    for (const name of unit.names) {
      addMapValue(mutableByName, name, unit);
      if (!unit.fileName.startsWith("browser/")) languageNames.add(name);
      else if (!unit.property) globalNames.add(name);
    }
    if (unit.property && unit.fileName.startsWith("browser/")) {
      addMapValue(mutableByProperty, unit.property, unit);
      propertyNames.add(unit.property);
    }
  }
  if (globalNames.size === 0 || propertyNames.size === 0) {
    throw new Error("Closure browser extern index contains no declarations");
  }

  return {
    jarHash,
    languageSources,
    browserUnits,
    unitsByName: mutableByName,
    unitsByProperty: mutableByProperty,
    globalNames,
    propertyNames,
    languageNames,
  };
}

function parseDeclarationUnits(
  entry: PlatformExternSource,
  fileOrder: number,
): PlatformDeclarationUnit[] {
  const sourceFile = parseJavaScriptSource(entry.name, entry.source);
  if (!sourceFile)
    throw new Error(`Unable to parse Closure extern ${entry.name}`);

  const templatesByOwner = new Map<string, Set<string>>();
  for (const statement of sourceFile.statements) {
    const text = entry.source.slice(statement.getFullStart(), statement.end);
    const templates = parseTemplateNames(text);
    if (templates.size === 0) continue;
    for (const name of declarationNames(statement)) {
      const existing = templatesByOwner.get(name);
      if (existing) for (const template of templates) existing.add(template);
      else templatesByOwner.set(name, new Set(templates));
    }
  }

  return sourceFile.statements.map((statement, statementOrder) => {
    const text = entry.source.slice(statement.getFullStart(), statement.end);
    const names = declarationNames(statement);
    const member = names.length === 1 ? memberIdentity(names[0] ?? "") : {};
    const templates = parseTemplateNames(text);
    const dependencies = parseClosureTypeReferences(text);
    for (const template of templates) dependencies.delete(template);
    if (member.owner) {
      for (const template of templatesByOwner.get(member.owner) ?? []) {
        dependencies.delete(template);
      }
    }
    for (const name of names) dependencies.delete(name);
    const heritage = parseHeritageReferences(text);
    for (const dependency of rhsQualifiedNames(statement))
      dependencies.add(dependency);
    if (member.owner) dependencies.add(member.owner);
    for (const name of names) addNamespaceParents(name, dependencies);

    return {
      id: `${fileOrder}:${statementOrder}`,
      fileName: entry.name,
      fileOrder,
      statementOrder,
      text,
      names,
      ...(member.owner ? { owner: member.owner } : {}),
      ...(member.property ? { property: member.property } : {}),
      dependencies: [...dependencies].sort(),
      heritage: [...heritage].sort(),
      override: /@override\b/.test(text),
    };
  });
}

function declarationNames(statement: ts.Statement): string[] {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    );
  }
  if (!ts.isExpressionStatement(statement)) return [];
  const expression = statement.expression;
  if (
    ts.isBinaryExpression(expression) &&
    isAssignment(expression.operatorToken.kind)
  ) {
    const name = qualifiedName(expression.left);
    return name ? [name] : [];
  }
  const name = qualifiedName(expression);
  return name ? [name] : [];
}

function rhsQualifiedNames(statement: ts.Statement): string[] {
  if (!ts.isExpressionStatement(statement)) return [];
  const expression = statement.expression;
  if (
    !ts.isBinaryExpression(expression) ||
    !isAssignment(expression.operatorToken.kind)
  ) {
    return [];
  }
  const name = qualifiedName(expression.right);
  return name ? [name] : [];
}

function qualifiedName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return qualifiedName(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const owner = qualifiedName(node.expression);
    return owner ? `${owner}.${node.name.text}` : null;
  }
  if (ts.isElementAccessExpression(node)) {
    const owner = qualifiedName(node.expression);
    if (!owner) return null;
    if (
      ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)
    ) {
      return `${owner}.${node.argumentExpression.text}`;
    }
    const property = qualifiedName(node.argumentExpression);
    return property ? `${owner}[${property}]` : null;
  }
  return null;
}

function memberIdentity(name: string): { owner?: string; property?: string } {
  const computed = /^(.*)\[([^\]]+)\]$/.exec(name);
  if (computed?.[1] && computed[2]) {
    const prototypeSuffix = ".prototype";
    return {
      owner: computed[1].endsWith(prototypeSuffix)
        ? computed[1].slice(0, -prototypeSuffix.length)
        : computed[1],
      property: computed[2],
    };
  }
  const parts = name.split(".");
  const prototypeIndex = parts.lastIndexOf("prototype");
  if (prototypeIndex > 0 && prototypeIndex + 1 < parts.length) {
    const property = parts[prototypeIndex + 1];
    if (!property) return {};
    return {
      owner: parts.slice(0, prototypeIndex).join("."),
      property,
    };
  }
  if (parts.length > 1) {
    const property = parts.at(-1);
    if (!property) return {};
    return {
      owner: parts.slice(0, -1).join("."),
      property,
    };
  }
  return {};
}

function addNamespaceParents(name: string, dependencies: Set<string>) {
  const parts = name.replace(/\[[^\]]+\]$/, "").split(".");
  const prototypeIndex = parts.indexOf("prototype");
  const end = prototypeIndex >= 0 ? prototypeIndex : parts.length - 1;
  for (let length = 1; length < end; length += 1) {
    dependencies.add(parts.slice(0, length).join("."));
  }
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

function addMapValue(
  map: Map<string, PlatformDeclarationUnit[]>,
  key: string,
  unit: PlatformDeclarationUnit,
) {
  const values = map.get(key);
  if (values) values.push(unit);
  else map.set(key, [unit]);
}
