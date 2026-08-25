import ts from "@typescript/typescript6";

export function objectLiteralBindingName(literal: ts.ObjectLiteralExpression) {
  const declaration = objectLiteralVariableDeclaration(literal);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !isConstOrLetDeclaration(declaration)
  ) {
    return null;
  }
  return declaration.name.text;
}

export function objectLiteralBindingSymbol(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
) {
  const declaration = objectLiteralVariableDeclaration(literal);
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  return resolveSymbol(checker, declaration.name);
}

export function objectLiteralVariableDeclaration(
  literal: ts.ObjectLiteralExpression,
) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === wrapped
  ) {
    return parent;
  }
  return null;
}

function isConstOrLetDeclaration(declaration: ts.VariableDeclaration) {
  const flags = ts.getCombinedNodeFlags(declaration);
  return (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Let) !== 0;
}

export function variableStatementHasExport(
  declaration: ts.VariableDeclaration,
) {
  const statement = declaration.parent?.parent;
  if (statement === undefined) {
    return false;
  }
  if (ts.isVariableStatement(statement) === false) {
    return false;
  }
  const modifiers = ts.getModifiers(statement);
  if (modifiers === undefined) {
    return false;
  }
  return modifiers.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

export function enclosingCallArgument(literal: ts.ObjectLiteralExpression) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) {
    return null;
  }
  const argumentIndex =
    parent.arguments?.findIndex((argument) => argument === wrapped) ?? -1;
  if (argumentIndex < 0) {
    return null;
  }
  return { argumentIndex, expression: parent.expression };
}

export function enclosingReturnFunction(literal: ts.ObjectLiteralExpression) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (!parent) {
    return null;
  }
  if (ts.isReturnStatement(parent)) {
    return enclosingFunctionLike(parent);
  }
  if (ts.isArrowFunction(parent) && parent.body === wrapped) {
    return parent;
  }
  return null;
}

function enclosingFunctionLike(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
  }
  return null;
}

export function isExportedFunctionLike(
  fn:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
) {
  if (
    ts.canHaveModifiers(fn) &&
    (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Export) !== 0
  ) {
    return true;
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    const symbol = resolveSymbol(checker, fn.name);
    if (symbol && exportedSymbols.has(symbol)) {
      return true;
    }
  }
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (variableStatementHasExport(parent)) {
      return true;
    }
    const symbol = resolveSymbol(checker, parent.name);
    if (symbol && exportedSymbols.has(symbol)) {
      return true;
    }
  }
  return ts.isExportAssignment(parent);
}

export function collectImportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const add = (name: ts.Identifier | undefined) => {
    if (!name) {
      return;
    }
    const symbol = resolveSymbol(checker, name);
    if (symbol) {
      symbols.add(symbol);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      add(statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    add(statement.importClause.name);
    const bindings = statement.importClause.namedBindings;
    if (!bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      add(bindings.name);
      continue;
    }
    for (const element of bindings.elements) {
      add(element.name);
    }
  }
  return symbols;
}

export function collectExportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return symbols;
  }
  let exported: readonly ts.Symbol[] = [];
  try {
    exported = checker.getExportsOfModule(moduleSymbol);
  } catch {
    return symbols;
  }
  for (const symbol of exported) {
    symbols.add(symbol);
    const resolved = resolveAliasedSymbol(checker, symbol);
    if (resolved) {
      symbols.add(resolved);
    }
  }
  return symbols;
}

export function collectDynamicallyKeyedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node) => {
    if (ts.isElementAccessExpression(node)) {
      const root = unwrapExpression(node.expression);
      if (ts.isIdentifier(root)) {
        const symbol = resolveSymbol(checker, root);
        if (symbol) {
          symbols.add(symbol);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isWrapperExpression(node: ts.Node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

export function outermostWrapper(literal: ts.ObjectLiteralExpression) {
  let current: ts.Node = literal;
  while (current.parent && isWrapperExpression(current.parent)) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

export function expressionRootIdentifier(expression: ts.Expression) {
  let current = unwrapExpression(expression);
  while (true) {
    if (ts.isIdentifier(current)) {
      return current;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return null;
  }
}

export function resolveSymbol(checker: ts.TypeChecker, node: ts.Node) {
  try {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      return null;
    }
    return resolveAliasedSymbol(checker, symbol) ?? symbol;
  } catch {
    return null;
  }
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return null;
  }
}

export function symbolDeclaresImport(symbol: ts.Symbol) {
  const declarations = [
    ...(symbol.getDeclarations() ?? []),
    ...(symbol.declarations ?? []),
  ];
  return declarations.some(
    (declaration) =>
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration),
  );
}

export function isGlobalSymbol(symbol: ts.Symbol, sourceFile: ts.SourceFile) {
  const declarations = symbol.getDeclarations() ?? symbol.declarations;
  if (!declarations || declarations.length === 0) {
    return true;
  }
  return declarations.every(
    (declaration) =>
      declaration.getSourceFile() !== sourceFile ||
      sourceFile.isDeclarationFile,
  );
}
