import ts from "typescript";

import type { ExternAnalysisContext } from "../context";
import {
  addMapSetValue,
  collectStructuralContractMembers,
  isExternPropertyName,
  isProjectAppSourceFile,
  resolveTypeSymbol,
  resolveValueSymbol,
} from "../shared";
import type { ContractRegistry, UsageAnalysis } from "../shared";

function analyzeAppUsage(analysis: ExternAnalysisContext): UsageAnalysis {
  const { checker, program, projectRoot, registry } = analysis;
  const usage: UsageAnalysis = {
    nominalInstanceMembers: new Map(),
    nominalStaticMembers: new Map(),
    structuralContracts: new Set(),
    structuralMembers: new Set(),
  };
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) =>
      isProjectAppSourceFile(sourceFile.fileName, projectRoot),
    );

  for (const sourceFile of sourceFiles) {
    const importBindings = collectImportedClassBindings(sourceFile, registry);
    const localBindings = new Map<string, ts.Symbol>();
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child: ts.Node) => {
          if (ts.isNewExpression(child)) {
            analyzeNewExpression(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
            );
          } else if (ts.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
              fieldBindings,
            );
          } else if (
            ts.isElementAccessExpression(child) &&
            ts.isStringLiteral(child.argumentExpression)
          ) {
            analyzeElementAccess(
              child,
              checker,
              registry,
              usage,
              importBindings,
              localBindings,
              fieldBindings,
            );
          } else if (ts.isVariableDeclaration(child)) {
            registerVariableBinding(
              child,
              checker,
              registry,
              importBindings,
              localBindings,
            );
          }
          ts.forEachChild(child, classVisit);
        };
        ts.forEachChild(node, classVisit);
        return;
      }

      if (ts.isVariableDeclaration(node)) {
        registerVariableBinding(
          node,
          checker,
          registry,
          importBindings,
          localBindings,
        );
      } else if (ts.isNewExpression(node)) {
        analyzeNewExpression(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
        );
      } else if (ts.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
          new Map(),
        );
      } else if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression)
      ) {
        analyzeElementAccess(
          node,
          checker,
          registry,
          usage,
          importBindings,
          localBindings,
          new Map(),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return usage;
}

export function collectBoundaryAwareExternLines(
  analysis: ExternAnalysisContext,
) {
  const usage = analyzeAppUsage(analysis);
  const emittedLines = new Set<string>();

  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(
      symbol,
      analysis.registry,
    )) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }

  return emittedLines;
}

export function collectBoundaryAwareUsageMemberNames(
  analysis: ExternAnalysisContext,
) {
  const usage = analyzeAppUsage(analysis);
  const members = new Set<string>();

  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(
      symbol,
      analysis.registry,
    )) {
      members.add(member);
    }
  }
  for (const member of usage.structuralMembers) {
    members.add(member);
  }
  for (const names of usage.nominalInstanceMembers.values()) {
    for (const member of names) {
      members.add(member);
    }
  }
  for (const names of usage.nominalStaticMembers.values()) {
    for (const member of names) {
      members.add(member);
    }
  }

  return members;
}

function analyzeNewExpression(
  node: ts.NewExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
) {
  const calleeSymbol =
    resolveBoundClassSymbol(
      node.expression,
      importBindings,
      localBindings,
      new Map(),
    ) ??
    resolveValueSymbol(node.expression, checker) ??
    resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!calleeSymbol) {
    return;
  }
  const classContract = registry.classContracts.get(calleeSymbol);
  if (!classContract) {
    return;
  }

  for (const [
    index,
    contractSymbols,
  ] of classContract.constructorParamContracts.entries()) {
    const argument = node.arguments?.[index];
    if (!argument || !isStructuralBoundaryArgument(argument)) {
      continue;
    }
    for (const symbol of contractSymbols) {
      usage.structuralContracts.add(symbol);
    }
  }
}

function analyzePropertyAccess(
  node: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  const propertyName = node.name.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }

  if (
    ts.isIdentifier(node.expression) &&
    importBindings.has(node.expression.text)
  ) {
    const targetSymbol = importBindings.get(node.expression.text);
    if (targetSymbol) {
      const classContract = registry.classContracts.get(targetSymbol);
      if (classContract && classContract.staticMembers.has(propertyName)) {
        addMapSetValue(usage.nominalStaticMembers, targetSymbol, propertyName);
        return;
      }
    }
  }

  const boundInstanceSymbol = resolveBoundClassSymbol(
    node.expression,
    importBindings,
    localBindings,
    fieldBindings,
  );
  if (boundInstanceSymbol && registry.classContracts.has(boundInstanceSymbol)) {
    addMapSetValue(
      usage.nominalInstanceMembers,
      boundInstanceSymbol,
      propertyName,
    );
    return;
  }

  const typeSymbol = resolveTypeSymbol(
    checker.getTypeAtLocation(node.expression),
    checker,
  );
  if (!typeSymbol) {
    return;
  }

  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (
    registry.interfaceContracts.has(typeSymbol) ||
    registry.typeAliasContracts.has(typeSymbol)
  ) {
    usage.structuralMembers.add(propertyName);
  }
}

function analyzeElementAccess(
  node: ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  const argumentExpression = node.argumentExpression;
  if (!ts.isStringLiteral(argumentExpression)) {
    return;
  }
  const propertyName = argumentExpression.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  const boundSymbol = resolveBoundClassSymbol(
    node.expression,
    importBindings,
    localBindings,
    fieldBindings,
  );
  if (boundSymbol && registry.classContracts.has(boundSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundSymbol, propertyName);
    return;
  }

  const typeSymbol = resolveTypeSymbol(
    checker.getTypeAtLocation(node.expression),
    checker,
  );
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (
    registry.interfaceContracts.has(typeSymbol) ||
    registry.typeAliasContracts.has(typeSymbol)
  ) {
    usage.structuralMembers.add(propertyName);
  }
}

function collectImportedClassBindings(
  sourceFile: ts.SourceFile,
  registry: ContractRegistry,
) {
  const bindings = new Map<string, ts.Symbol>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const clause = statement.importClause;
    if (clause.name) {
      const symbol = findClassContractByName(clause.name.text, registry);
      if (symbol) {
        bindings.set(clause.name.text, symbol);
      }
    }

    const namedBindings = clause.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const symbol = findClassContractByName(importedName, registry);
      if (symbol) {
        bindings.set(specifier.name.text, symbol);
      }
    }
  }

  return bindings;
}

function collectClassFieldBindings(
  declaration: ts.ClassDeclaration,
  importBindings: Map<string, ts.Symbol>,
) {
  const bindings = new Map<string, ts.Symbol>();
  for (const member of declaration.members) {
    if (
      !ts.isPropertyDeclaration(member) ||
      !member.initializer ||
      !ts.isIdentifier(member.name) ||
      !ts.isNewExpression(member.initializer) ||
      !ts.isIdentifier(member.initializer.expression)
    ) {
      continue;
    }
    const classSymbol = importBindings.get(member.initializer.expression.text);
    if (classSymbol) {
      bindings.set(member.name.text, classSymbol);
    }
  }
  return bindings;
}

function registerVariableBinding(
  declaration: ts.VariableDeclaration,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
) {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
    return;
  }

  const initializer = declaration.initializer;
  const resolvedTypeSymbol = resolveTypeSymbol(
    checker.getTypeAtLocation(initializer),
    checker,
  );
  const classSymbol =
    (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)
      ? importBindings.get(initializer.expression.text)
      : undefined) ??
    (resolvedTypeSymbol
      ? findClassContractByName(resolvedTypeSymbol.getName(), registry)
      : undefined);

  if (!classSymbol) {
    return;
  }
  localBindings.set(declaration.name.text, classSymbol);
}

function resolveBoundClassSymbol(
  expression: ts.Expression,
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
  fieldBindings: Map<string, ts.Symbol>,
) {
  if (ts.isIdentifier(expression)) {
    return (
      localBindings.get(expression.text) ??
      importBindings.get(expression.text) ??
      null
    );
  }

  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return fieldBindings.get(expression.name.text) ?? null;
  }

  return null;
}

function findClassContractByName(name: string, registry: ContractRegistry) {
  for (const [symbol, contract] of registry.classContracts) {
    if (contract.name === name) {
      return symbol;
    }
  }
  return null;
}

function isStructuralBoundaryArgument(expression: ts.Expression) {
  return !(
    ts.isArrayLiteralExpression(expression) ||
    ts.isObjectLiteralExpression(expression) ||
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  );
}

function renderStructuralExternLine(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `Object.prototype.${name};`
    : `Object.prototype[${JSON.stringify(name)}];`;
}
