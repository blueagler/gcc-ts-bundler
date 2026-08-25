import ts from "@typescript/typescript6";

import {
  destructuredCallSymbol,
  emptySymbol,
  functionSymbol,
  getPropertyKeyText,
  importSymbol,
  isFunctionLikeNode,
  parameterSymbol,
  variableSymbol,
  type ExportTarget,
  type ModuleInfo,
  type ScopeNode,
  type ScopeSymbol,
} from "./types";

function hasExportModifier(node: ts.Statement) {
  return ts.canHaveModifiers(node)
    ? (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    : false;
}

function hasDefaultModifier(node: ts.Statement) {
  return ts.canHaveModifiers(node)
    ? (ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
        false)
    : false;
}

function literalSpecifier(node: ts.Expression | undefined) {
  return node && ts.isStringLiteral(node) ? node.text : null;
}

export function buildModuleInfo(sourceFile: ts.SourceFile): ModuleInfo {
  const exports = new Map<string, ExportTarget>();
  const starReExports: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = literalSpecifier(statement.moduleSpecifier);
      if (!statement.exportClause) {
        if (specifier) starReExports.push(specifier);
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        const localName = (element.propertyName ?? element.name).text;
        exports.set(
          element.name.text,
          specifier
            ? { kind: "reExport", exportName: localName, specifier }
            : { kind: "local", name: localName },
        );
      }
      continue;
    }
    if (
      ts.isExportAssignment(statement) &&
      !statement.isExportEquals &&
      ts.isIdentifier(statement.expression)
    ) {
      exports.set("default", {
        kind: "local",
        name: statement.expression.text,
      });
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const name = statement.name.text;
      exports.set(name, { kind: "local", name });
      if (hasDefaultModifier(statement)) {
        exports.set("default", { kind: "local", name });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        exports.set(name, { kind: "local", name });
      }
    }
  }
  return {
    exports,
    filePath: sourceFile.fileName,
    scopes: new Map(),
    sourceFile,
    starReExports,
  };
}

/**
 * Names a scope introduces: parameters and their object-destructured
 * properties, plus every declaration in the scope body that is not inside a
 * nested function. A name declared twice in one scope becomes `ambiguous` and
 * stops resolution rather than guessing which declaration is live.
 */
export function buildScopeTable(scope: ScopeNode): Map<string, ScopeSymbol> {
  const symbols = new Map<string, ScopeSymbol>();
  const declare = (name: string, symbol: ScopeSymbol) => {
    // A name declared twice in one scope stops resolution rather than
    // guessing which declaration is live.
    symbols.set(name, symbols.has(name) ? emptySymbol() : symbol);
  };
  const declareBindingPattern = (
    pattern: ts.ObjectBindingPattern,
    onProperty: (property: string, local: string) => void,
  ) => {
    for (const element of pattern.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const propertyName = element.propertyName
        ? getPropertyKeyText(element.propertyName)
        : element.name.text;
      if (propertyName) onProperty(propertyName, element.name.text);
    }
  };

  if (isFunctionLikeNode(scope)) {
    scope.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        declare(parameter.name.text, parameterSymbol(scope, index, null));
      } else if (ts.isObjectBindingPattern(parameter.name)) {
        declareBindingPattern(parameter.name, (property, local) => {
          declare(local, parameterSymbol(scope, index, property));
        });
      }
    });
  }

  /** The index of the parameter a name binds, or -1. */
  const parameterIndexOf = (name: string) => {
    if (!isFunctionLikeNode(scope)) return -1;
    return scope.parameters.findIndex(
      (parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === name,
    );
  };

  const visit = (node: ts.Node) => {
    if (node !== scope && isFunctionLikeNode(node)) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        declare(node.name.text, functionSymbol(node));
      }
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) {
        if (node.initializer && isFunctionLikeNode(node.initializer)) {
          declare(node.name.text, functionSymbol(node.initializer));
        } else {
          declare(node.name.text, variableSymbol(node, scope));
        }
      } else if (ts.isObjectBindingPattern(node.name) && node.initializer) {
        const initializer = node.initializer;
        if (ts.isIdentifier(initializer)) {
          const index = parameterIndexOf(initializer.text);
          if (index >= 0 && isFunctionLikeNode(scope)) {
            const owner = scope;
            declareBindingPattern(node.name, (property, local) => {
              declare(local, parameterSymbol(owner, index, property));
            });
          }
        } else if (ts.isCallExpression(initializer)) {
          declareBindingPattern(node.name, (property, local) => {
            declare(local, destructuredCallSymbol(initializer, property));
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  if (isFunctionLikeNode(scope)) {
    if (scope.body) visit(scope.body);
  } else {
    visit(scope);
  }

  if (ts.isSourceFile(scope)) {
    for (const statement of scope.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) {
        continue;
      }
      const specifier = literalSpecifier(statement.moduleSpecifier);
      if (!specifier) continue;
      if (statement.importClause.name) {
        symbols.set(
          statement.importClause.name.text,
          importSymbol("default", specifier),
        );
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          symbols.set(
            element.name.text,
            importSymbol(
              (element.propertyName ?? element.name).text,
              specifier,
            ),
          );
        }
      }
    }
  }
  return symbols;
}
