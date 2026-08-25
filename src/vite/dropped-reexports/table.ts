import ts from "@typescript/typescript6";

export interface ModuleExportTable {
  local: Set<string>;
  named: Map<string, { imported: string; specifier: string }>;
  stars: string[];
}

export function collectModuleExportTable(
  moduleId: string,
  code: string,
): ModuleExportTable {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const table: ModuleExportTable = {
    local: new Set<string>(),
    named: new Map<string, { imported: string; specifier: string }>(),
    stars: [],
  };
  // Vite's own transform rewrites `export { x } from "m"` into an import plus a
  // local `export { x }`, so a binding that came straight from another module
  // is the common shape of a barrel, not the exception.
  const importBindings = collectImportBindings(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const forwarded = ts.isIdentifier(statement.expression)
        ? importBindings.get(statement.expression.text)
        : undefined;
      if (forwarded) {
        table.named.set("default", forwarded);
      } else {
        table.local.add("default");
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      if (isLocalExportDeclaration(statement)) {
        for (const name of readDeclaredExportNames(statement)) {
          table.local.add(name);
        }
      }
      continue;
    }

    const specifier =
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (!statement.exportClause) {
      if (specifier !== null) {
        table.stars.push(specifier);
      }
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      table.local.add(statement.exportClause.name.text);
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const localName = (element.propertyName ?? element.name).text;
      if (specifier === null) {
        const forwarded = importBindings.get(localName);
        if (forwarded) {
          table.named.set(element.name.text, forwarded);
        } else {
          table.local.add(element.name.text);
        }
        continue;
      }
      table.named.set(element.name.text, {
        imported: localName,
        specifier,
      });
    }
  }

  return table;
}

/**
 * Bindings a module took straight from another module, by local name. A
 * namespace binding is excluded: it is an object this module built, not a
 * value another module declares.
 */
function collectImportBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<string, { imported: string; specifier: string }>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (statement.importClause.name) {
      bindings.set(statement.importClause.name.text, {
        imported: "default",
        specifier,
      });
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        bindings.set(element.name.text, {
          imported: (element.propertyName ?? element.name).text,
          specifier,
        });
      }
    }
  }
  return bindings;
}

function isLocalExportDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function readDeclaredExportNames(statement: ts.Statement) {
  const names: string[] = [];
  const isDefault =
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
      true;
  if (isDefault) {
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
