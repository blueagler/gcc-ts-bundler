import fs from "fs/promises";
import * as ts from "@typescript/typescript6";

import { logInternalDetail } from "../../../shared/timing";
import { isValueIdentifier } from "../../../shared/typescript";
import { parseClosureTypeReferences } from "./parser/jsdoc";
import { parseJavaScriptSource } from "./parser/typescript";
import type { PlatformExternIndex, PlatformExternSeeds } from "./types";

/** The mutable half of {@link PlatformExternSeeds}, filled in file order. */
interface SeedSets {
  readonly globalPropertyAliases: Set<string>;
  readonly globals: Set<string>;
  readonly properties: Set<string>;
  readonly typeNames: Set<string>;
}

/** A seed file that was read off disk and parsed successfully. */
interface ParsedSeedFile {
  readonly source: string;
  readonly sourceFile: ts.SourceFile;
}

export async function collectPlatformExternSeeds(
  jsFiles: readonly string[],
  index: PlatformExternIndex,
  typeDependencyFiles: readonly string[] = [],
): Promise<PlatformExternSeeds | null> {
  const seeds: SeedSets = {
    globalPropertyAliases: new Set(),
    globals: new Set(),
    properties: new Set(),
    typeNames: new Set(),
  };
  const windowAliases = windowGlobalPropertyAliases(index);

  for (const filePath of jsFiles) {
    if (filePath.toLowerCase().endsWith(".json")) continue;
    const parsed = await readParsedSeedFile(filePath);
    if (!parsed) return null;
    visit(parsed.sourceFile, (node) =>
      recordNodeSeeds(node, index, windowAliases, seeds),
    );
    recordTypeNameSeeds(parsed.source, index, seeds);
  }

  for (const filePath of typeDependencyFiles) {
    const parsed = await readParsedSeedFile(filePath);
    if (!parsed) return null;
    dropSelfDeclaredAliases(parsed.sourceFile, seeds);
    recordTypeNameSeeds(parsed.source, index, seeds);
  }

  return seeds;
}

/** Window data properties also resolve as bare names in browser modules. */
export function windowGlobalPropertyAliases(index: PlatformExternIndex) {
  const names = new Set<string>();
  for (const [name, units] of index.unitsByProperty) {
    if (
      !index.globalNames.has(name) &&
      units.some(
        (unit) =>
          unit.owner === "Window" &&
          unit.text.trim().endsWith(`Window.prototype.${name};`),
      )
    ) {
      names.add(name);
    }
  }
  return names;
}

/**
 * A file that cannot be read or parsed leaves the seed set incomplete, and an
 * incomplete seed set would extern too little — so both failures abort seed
 * collection rather than skipping the file.
 */
async function readParsedSeedFile(
  filePath: string,
): Promise<ParsedSeedFile | null> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const sourceFile = parseJavaScriptSource(filePath, source);
  if (!sourceFile) {
    logInternalDetail("closure:platform-externs", `unparseable: ${filePath}`);
    return null;
  }
  return { source, sourceFile };
}

/**
 * Records what one node seeds. The branches are mutually exclusive by node
 * kind, so each claims the node and returns.
 */
function recordNodeSeeds(
  node: ts.Node,
  index: PlatformExternIndex,
  windowAliases: ReadonlySet<string>,
  seeds: SeedSets,
) {
  if (ts.isPropertyAccessExpression(node)) {
    recordMemberSeeds(node.name.text, index, seeds);
    return;
  }
  if (ts.isElementAccessExpression(node)) {
    recordElementAccessSeeds(node, index, seeds);
    return;
  }
  if (ts.isIdentifier(node)) {
    recordIdentifierSeeds(node, index, windowAliases, seeds);
    return;
  }
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
    recordPropertyAssignmentSeeds(node, index, seeds);
  }
}

function recordElementAccessSeeds(
  node: ts.ElementAccessExpression,
  index: PlatformExternIndex,
  seeds: SeedSets,
) {
  const name = stringLiteralArgumentText(node);
  if (name !== null) recordMemberSeeds(name, index, seeds);
}

function recordIdentifierSeeds(
  node: ts.Identifier,
  index: PlatformExternIndex,
  windowAliases: ReadonlySet<string>,
  seeds: SeedSets,
) {
  if (!isValueIdentifier(node)) return;
  if (index.globalNames.has(node.text)) seeds.globals.add(node.text);
  if (windowAliases.has(node.text)) {
    seeds.globalPropertyAliases.add(node.text);
    seeds.properties.add(node.text);
  }
}

function recordPropertyAssignmentSeeds(
  node: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  index: PlatformExternIndex,
  seeds: SeedSets,
) {
  const name = propertyNameText(node.name);
  if (name && index.propertyNames.has(name)) seeds.properties.add(name);
}

/** A member name read as `obj.name` or `obj["name"]` seeds both halves. */
function recordMemberSeeds(
  name: string,
  index: PlatformExternIndex,
  seeds: SeedSets,
) {
  if (index.propertyNames.has(name)) seeds.properties.add(name);
  // `window.setTimeout(…)` reaches a name Closure's externs declare as a
  // bare global (`function setTimeout(…){}`), not as a `Window.prototype`
  // member — so it is in `globalNames` and absent from `propertyNames`.
  // Matching only the latter dropped its declaration from the slice and
  // let Closure rename it, which is a silent miscompile for the very
  // common `window.<globalFn>()` idiom (setTimeout, setInterval,
  // clearTimeout, requestAnimationFrame …).
  if (index.globalNames.has(name)) seeds.globals.add(name);
}

/** A top-level declaration owns its bare name, so it is not a window alias. */
function dropSelfDeclaredAliases(sourceFile: ts.SourceFile, seeds: SeedSets) {
  for (const statement of sourceFile.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      seeds.globalPropertyAliases.delete(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        seeds.globalPropertyAliases.delete(declaration.name.text);
      }
    }
  }
}

function recordTypeNameSeeds(
  source: string,
  index: PlatformExternIndex,
  seeds: SeedSets,
) {
  for (const name of parseClosureTypeReferences(source)) {
    if (index.unitsByName.has(name)) seeds.typeNames.add(name);
  }
}

function visit(node: ts.Node, callback: (node: ts.Node) => void) {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function stringLiteralArgumentText(
  node: ts.ElementAccessExpression,
): string | null {
  const argument = node.argumentExpression;
  if (
    ts.isStringLiteral(argument) ||
    ts.isNoSubstitutionTemplateLiteral(argument)
  ) {
    return argument.text;
  }
  return null;
}
