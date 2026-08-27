import ts from "@typescript/typescript6";

/** Local binding name to the module and export name it was imported from. */
export interface ImportedBinding {
  imported: string;
  specifier: string;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

export function getPropertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}

/**
 * Parent kinds that bind an identifier without ever referencing a value:
 * import bindings and statement labels.
 */
const NON_REFERENCING_PARENT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.LabeledStatement,
]);

/**
 * Parent kinds whose `name` slot is a declaration or property key, not a
 * value reference — only when the identifier occupies that slot.
 */
const NAME_SLOT_PARENT_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
]);

/**
 * True when `node` is a value reference, not a declaration name, property
 * key, import binding, or label.
 */
export function isValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (NON_REFERENCING_PARENT_KINDS.has(parent.kind)) {
    return false;
  }
  if (!NAME_SLOT_PARENT_KINDS.has(parent.kind)) {
    return true;
  }
  return !("name" in parent && parent.name === node);
}

/**
 * The string-literal specifier of a dynamic `import(...)`, or `null` when
 * `node` is not that form.
 */
export function dynamicImportSpecifier(node: ts.Node): string | null {
  if (
    !ts.isCallExpression(node) ||
    node.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    node.arguments[0] === undefined ||
    !ts.isStringLiteralLike(node.arguments[0])
  ) {
    return null;
  }
  return node.arguments[0].text;
}

function addDefaultImportBinding(
  clause: ts.ImportClause,
  specifier: string,
  bindings: Map<string, ImportedBinding>,
) {
  if (!clause.name) {
    return;
  }
  bindings.set(clause.name.text, {
    imported: "default",
    specifier,
  });
}

function addNamedImportBindings(
  namedBindings: ts.NamedImportBindings | undefined,
  specifier: string,
  bindings: Map<string, ImportedBinding>,
) {
  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return;
  }
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

/**
 * Local names bound by value imports, mapped to the export they came from.
 * Namespace imports are excluded: they are an object this module built.
 */
export function collectImportBindings(
  sourceFile: ts.SourceFile,
): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
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
    addDefaultImportBinding(statement.importClause, specifier, bindings);
    addNamedImportBindings(
      statement.importClause.namedBindings,
      specifier,
      bindings,
    );
  }
  return bindings;
}
