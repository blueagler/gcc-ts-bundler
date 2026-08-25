import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";

export function shakeModuleOnce(
  moduleId: string,
  code: string,
  demandedNames: ReadonlySet<string>,
  stranded: Set<string>,
) {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const forwarded = collectForwardedBindings(sourceFile);
  const droppedBindings = new Set<ts.ImportSpecifier | ts.Identifier>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.exportClause
    ) {
      continue;
    }

    if (ts.isNamespaceExport(statement.exportClause)) {
      if (
        statement.moduleSpecifier &&
        !demandedNames.has(statement.exportClause.name.text)
      ) {
        edits.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
          text: "",
        });
      }
      continue;
    }

    const elements = statement.exportClause.elements;
    const kept = elements.filter((element) =>
      demandedNames.has(element.name.text),
    );
    if (kept.length === elements.length) {
      continue;
    }
    // Vite rewrites `export { a } from "m"` into an import plus a local
    // `export { a }`, so the forwarding shape has to be shaken in both forms.
    for (const element of elements) {
      if (kept.includes(element)) {
        continue;
      }
      const localName = (element.propertyName ?? element.name).text;
      stranded.add(localName);
      const binding = forwarded.get(localName);
      if (binding) {
        droppedBindings.add(binding);
      }
    }
    edits.push(
      kept.length === 0
        ? {
            end: statement.getEnd(),
            start: statement.getStart(sourceFile),
            text: "",
          }
        : {
            end: statement.exportClause.getEnd(),
            start: statement.exportClause.getStart(sourceFile),
            text: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }`,
          },
    );
  }

  for (const [name, binding] of forwarded) {
    if (stranded.has(name)) {
      droppedBindings.add(binding);
    }
  }
  edits.push(...dropImportBindings(sourceFile, droppedBindings));
  edits.push(...dropUnreadFunctions(sourceFile, stranded, demandedNames));
  return edits.length === 0 ? code : applyTextEdits(code, edits);
}

/**
 * Top-level function declarations nothing can reach: either the module never
 * names them again after a shaken export, or they are exported under a name no
 * importer asks for. A function body runs nothing until it is called, so
 * removing one removes only the imports it was the last reader of - which is
 * the edge Rollup removed when it shook the same unused export. Declarations
 * that could run code on evaluation are left to Closure.
 */
function dropUnreadFunctions(
  sourceFile: ts.SourceFile,
  stranded: Set<string>,
  demandedNames: ReadonlySet<string>,
) {
  const exported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exported.add((element.propertyName ?? element.name).text);
      }
    }
  }

  const read = countIdentifierReads(sourceFile);
  return sourceFile.statements
    .filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        !exported.has(statement.name.text) &&
        (isExportedDeclaration(statement)
          ? !isDefaultExportedDeclaration(statement) &&
            !demandedNames.has(statement.name.text)
          : stranded.has(statement.name.text)) &&
        (read.get(statement.name.text) ?? 0) === 0,
    )
    .map((statement) => {
      for (const name of countIdentifierReads(statement).keys()) {
        stranded.add(name);
      }
      return {
        end: statement.getEnd(),
        start: statement.getStart(sourceFile),
        text: "",
      };
    });
}

function isDefaultExportedDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
      true
  );
}

function isExportedDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

/**
 * Import bindings this module only forwards: bound from another module and
 * never read in its own body, so dropping the export drops the whole edge.
 */
function collectForwardedBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<string, ts.ImportSpecifier | ts.Identifier>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }
    if (statement.importClause.name) {
      bindings.set(
        statement.importClause.name.text,
        statement.importClause.name,
      );
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, element);
      }
    }
  }

  for (const name of countIdentifierReads(sourceFile).keys()) {
    bindings.delete(name);
  }
  return bindings;
}

/**
 * How often each name is read as a value. Import clauses, export clauses,
 * member names and a declaration's own name are bindings, not reads.
 */
function countIdentifierReads(root: ts.Node) {
  const read = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportSpecifier(node)) {
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      ts.forEachChild(node, (child) => {
        if (child !== node.name) {
          visit(child);
        }
      });
      return;
    }
    if (ts.isIdentifier(node)) {
      read.set(node.text, (read.get(node.text) ?? 0) + 1);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return read;
}

/** One edit per import declaration, so removals never overlap. */
function dropImportBindings(
  sourceFile: ts.SourceFile,
  bindings: ReadonlySet<ts.ImportSpecifier | ts.Identifier>,
) {
  const byDeclaration = new Map<
    ts.ImportDeclaration,
    Set<ts.ImportSpecifier | ts.Identifier>
  >();
  for (const binding of bindings) {
    const declaration = ts.isImportSpecifier(binding)
      ? binding.parent.parent.parent
      : binding.parent.parent;
    if (!ts.isImportDeclaration(declaration)) {
      continue;
    }
    const existing = byDeclaration.get(declaration);
    if (existing) {
      existing.add(binding);
      continue;
    }
    byDeclaration.set(declaration, new Set([binding]));
  }

  const edits: Array<{ end: number; start: number; text: string }> = [];
  for (const [declaration, dropped] of byDeclaration) {
    const clause = declaration.importClause;
    if (!clause) {
      continue;
    }
    const namedBindings = clause.namedBindings;
    const keptNames =
      namedBindings && ts.isNamedImports(namedBindings)
        ? namedBindings.elements.filter((element) => !dropped.has(element))
        : [];
    const keptDefault =
      clause.name && !dropped.has(clause.name) ? clause.name : null;
    if (!keptDefault && keptNames.length === 0) {
      edits.push({
        end: declaration.getEnd(),
        start: declaration.getStart(sourceFile),
        text: "",
      });
      continue;
    }
    edits.push({
      end: clause.getEnd(),
      start: clause.getStart(sourceFile),
      text: [
        ...(keptDefault ? [keptDefault.getText(sourceFile)] : []),
        ...(keptNames.length > 0
          ? [
              `{ ${keptNames.map((element) => element.getText(sourceFile)).join(", ")} }`,
            ]
          : []),
      ].join(", "),
    });
  }
  return edits;
}
