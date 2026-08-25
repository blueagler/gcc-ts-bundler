import * as ts from "@typescript/typescript6";

import {
  parseClosureTypeReferences,
  parseHeritageReferences,
  parseTemplateNames,
} from "./jsdoc";
import { parseJavaScriptSource } from "./typescript";
import type { PlatformDeclarationUnit, PlatformExternSource } from "../types";

export function parseDeclarationUnits(
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

export function declarationNames(statement: ts.Statement): string[] {
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

export function rhsQualifiedNames(statement: ts.Statement): string[] {
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

export function qualifiedName(node: ts.Node): string | null {
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

export function memberIdentity(name: string): {
  owner?: string;
  property?: string;
} {
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

export function addNamespaceParents(name: string, dependencies: Set<string>) {
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
