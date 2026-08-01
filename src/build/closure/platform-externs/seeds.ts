import fs from "fs/promises";
import * as ts from "@typescript/typescript6";

import { parseClosureTypeReferences } from "./closure-type-parser";
import { parseJavaScriptSource } from "./typescript-parser";
import type { PlatformExternIndex, PlatformExternSeeds } from "./types";

export async function collectPlatformExternSeeds(
  jsFiles: readonly string[],
  index: PlatformExternIndex,
  typeDependencyFiles: readonly string[] = [],
): Promise<PlatformExternSeeds | null> {
  const globals = new Set<string>();
  const properties = new Set<string>();
  const typeNames = new Set<string>();

  for (const filePath of jsFiles) {
    if (filePath.toLowerCase().endsWith(".json")) continue;
    let source: string;
    try {
      source = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
    const sourceFile = parseJavaScriptSource(filePath, source);
    if (!sourceFile) return null;

    visit(sourceFile, (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        if (index.propertyNames.has(node.name.text))
          properties.add(node.name.text);
        // `window.setTimeout(…)` reaches a name Closure's externs declare as a
        // bare global (`function setTimeout(…){}`), not as a `Window.prototype`
        // member — so it is in `globalNames` and absent from `propertyNames`.
        // Matching only the latter dropped its declaration from the slice and
        // let Closure rename it, which is a silent miscompile for the very
        // common `window.<globalFn>()` idiom (setTimeout, setInterval,
        // clearTimeout, requestAnimationFrame …).
        if (index.globalNames.has(node.name.text)) globals.add(node.name.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        (ts.isStringLiteral(node.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
      ) {
        const name = node.argumentExpression.text;
        if (index.propertyNames.has(name)) properties.add(name);
        if (index.globalNames.has(name)) globals.add(name);
      } else if (ts.isIdentifier(node) && isValueIdentifier(node)) {
        if (index.globalNames.has(node.text)) globals.add(node.text);
      } else if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        propertyNameText(node.name)
      ) {
        const name = propertyNameText(node.name);
        if (name && index.propertyNames.has(name)) properties.add(name);
      }
    });

    for (const name of parseClosureTypeReferences(source)) {
      if (index.unitsByName.has(name)) typeNames.add(name);
    }
  }

  for (const filePath of typeDependencyFiles) {
    let source: string;
    try {
      source = await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
    for (const name of parseClosureTypeReferences(source)) {
      if (index.unitsByName.has(name)) typeNames.add(name);
    }
  }

  return { globals, properties, typeNames };
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

function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isLabeledStatement(parent)
  ) {
    return false;
  }
  return true;
}
