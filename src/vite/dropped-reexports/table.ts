import ts from "@typescript/typescript6";

import {
  collectImportBindings,
  hasModifier,
  type ImportedBinding,
} from "../../shared/typescript";
import { getCapturedSourceFile } from "../capture-analysis";

export interface ModuleExportTable {
  local: Set<string>;
  named: Map<string, ImportedBinding>;
  stars: string[];
}

export function collectModuleExportTable(
  moduleId: string,
  code: string,
): ModuleExportTable {
  const sourceFile = getCapturedSourceFile(moduleId, code);
  const table: ModuleExportTable = {
    local: new Set<string>(),
    named: new Map<string, ImportedBinding>(),
    stars: [],
  };
  // Vite's own transform rewrites `export { x } from "m"` into an import plus a
  // local `export { x }`, so a binding that came straight from another module
  // is the common shape of a barrel, not the exception.
  const importBindings = collectImportBindings(sourceFile);

  for (const statement of sourceFile.statements) {
    if (recordExportAssignment(statement, table, importBindings)) {
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      recordLocalDeclaredExports(statement, table);
      continue;
    }
    if (recordStarReexport(statement, table)) {
      continue;
    }
    if (recordNamespaceReexport(statement, table)) {
      continue;
    }
    recordNamedExportBindings(statement, table, importBindings);
  }

  return table;
}

function recordExportAssignment(
  statement: ts.Statement,
  table: ModuleExportTable,
  importBindings: Map<string, ImportedBinding>,
): boolean {
  if (!ts.isExportAssignment(statement)) {
    return false;
  }
  recordForwardedOrLocal(
    table,
    "default",
    ts.isIdentifier(statement.expression)
      ? importBindings.get(statement.expression.text)
      : undefined,
  );
  return true;
}

function recordLocalDeclaredExports(
  statement: ts.Statement,
  table: ModuleExportTable,
) {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return;
  }
  for (const name of readDeclaredExportNames(statement)) {
    table.local.add(name);
  }
}

function recordStarReexport(
  statement: ts.ExportDeclaration,
  table: ModuleExportTable,
): boolean {
  if (statement.exportClause) {
    return false;
  }
  const specifier = readReexportSpecifier(statement);
  if (specifier !== null) {
    table.stars.push(specifier);
  }
  return true;
}

function recordNamespaceReexport(
  statement: ts.ExportDeclaration,
  table: ModuleExportTable,
): boolean {
  if (
    !statement.exportClause ||
    !ts.isNamespaceExport(statement.exportClause)
  ) {
    return false;
  }
  table.local.add(statement.exportClause.name.text);
  return true;
}

function recordNamedExportBindings(
  statement: ts.ExportDeclaration,
  table: ModuleExportTable,
  importBindings: Map<string, ImportedBinding>,
) {
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return;
  }
  const specifier = readReexportSpecifier(statement);
  for (const element of statement.exportClause.elements) {
    recordNamedExportElement(element, specifier, table, importBindings);
  }
}

function recordNamedExportElement(
  element: ts.ExportSpecifier,
  specifier: string | null,
  table: ModuleExportTable,
  importBindings: Map<string, ImportedBinding>,
) {
  if (element.isTypeOnly) {
    return;
  }
  const localName = (element.propertyName ?? element.name).text;
  if (specifier === null) {
    recordForwardedOrLocal(
      table,
      element.name.text,
      importBindings.get(localName),
    );
    return;
  }
  table.named.set(element.name.text, {
    imported: localName,
    specifier,
  });
}

function recordForwardedOrLocal(
  table: ModuleExportTable,
  exportName: string,
  forwarded: ImportedBinding | undefined,
) {
  if (forwarded) {
    table.named.set(exportName, forwarded);
  } else {
    table.local.add(exportName);
  }
}

function readReexportSpecifier(statement: ts.ExportDeclaration): string | null {
  if (
    !statement.moduleSpecifier ||
    !ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return null;
  }
  return statement.moduleSpecifier.text;
}

function readDeclaredExportNames(statement: ts.Statement) {
  const names: string[] = [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    names.push("default");
    return names;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.push(declaration.name.text);
      }
    }
    return names;
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    names.push(statement.name.text);
  }
  return names;
}
