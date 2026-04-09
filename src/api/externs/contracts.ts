import path from "path";
import ts from "typescript";

import {
  addMapSetValue,
  ClassContract,
  collectStructuralContractMembers,
  ContractRegistry,
  createEmptyContractRegistry,
  getPropertyNameText,
  hasNonPublicModifier,
  hasStaticModifier,
  InterfaceContract,
  isExportedDeclaration,
  isExternPropertyName,
  isProjectAppSourceFile,
  isScannedDeclarationSymbol,
  renderStructuralExternLine,
  resolveAliasedSymbol,
  resolveTypeSymbol,
  resolveValueSymbol,
  symbolCacheKey,
  TypeAliasContract,
  UsageAnalysis,
} from "./shared";

export function collectContracts(
  program: ts.Program,
  scannedFiles: string[],
): ContractRegistry {
  const checker = program.getTypeChecker();
  const scannedFileSet = new Set(
    scannedFiles.map((filePath) => path.resolve(filePath)),
  );
  const interfaceContracts = new Map<ts.Symbol, InterfaceContract>();
  const typeAliasContracts = new Map<ts.Symbol, TypeAliasContract>();
  const classContracts = new Map<ts.Symbol, ClassContract>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(path.resolve(sourceFile.fileName))) {
      continue;
    }

    for (const statement of sourceFile.statements) {
      if (
        ts.isInterfaceDeclaration(statement) &&
        isExportedDeclaration(statement)
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        interfaceContracts.set(symbol, {
          extends: getReferencedContractSymbols(
            statement.heritageClauses?.flatMap((clause) => clause.types) ?? [],
            checker,
            scannedFileSet,
          ),
          members: collectTypeElementMembers(statement.members),
          name: statement.name.text,
          symbol,
        });
        continue;
      }

      if (
        ts.isTypeAliasDeclaration(statement) &&
        isExportedDeclaration(statement)
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const members = collectAliasMembers(statement.type);
        if (members.size === 0) {
          continue;
        }
        typeAliasContracts.set(symbol, {
          members,
          name: statement.name.text,
          symbol,
        });
        continue;
      }

      if (
        ts.isClassDeclaration(statement) &&
        statement.name &&
        isExportedDeclaration(statement)
      ) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set<string>();
        const staticMembers = new Set<string>();
        for (const member of statement.members) {
          if (ts.isConstructorDeclaration(member)) {
            continue;
          }
          if (hasNonPublicModifier(member)) {
            continue;
          }
          const memberName = getPropertyNameText(member.name);
          if (!memberName || !isExternPropertyName(memberName)) {
            continue;
          }
          if (hasStaticModifier(member)) {
            staticMembers.add(memberName);
          } else {
            instanceMembers.add(memberName);
          }
        }
        classContracts.set(symbol, {
          constructorParamContracts: collectConstructorParamContracts(
            statement,
            checker,
            scannedFileSet,
          ),
          instanceMembers,
          name: statement.name.text,
          staticMembers,
          symbol,
          usedImplementedContracts: getClassImplementedContracts(
            statement,
            checker,
            scannedFileSet,
          ),
        });
      }
    }
  }

  return {
    classContracts,
    interfaceContracts,
    scannedFiles: scannedFileSet,
    typeAliasContracts,
  };
}

export function collectCandidateExternLines(registry: ContractRegistry) {
  const properties = new Set<string>();
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(
      contract.symbol,
      registry,
    )) {
      properties.add(member);
    }
  }
  for (const contract of registry.typeAliasContracts.values()) {
    for (const member of contract.members) {
      properties.add(member);
    }
  }
  for (const contract of registry.classContracts.values()) {
    for (const member of contract.instanceMembers) {
      properties.add(member);
    }
  }

  return new Set(
    [...properties]
      .sort((left, right) => left.localeCompare(right))
      .map((property) => renderStructuralExternLine(property)),
  );
}

export function collectBoundaryAwareExternLines({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  registry: ContractRegistry;
}) {
  const usage = analyzeAppUsage({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry,
  });
  const emittedLines = new Set<string>();

  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, registry)) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }

  return emittedLines;
}

function analyzeAppUsage({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  registry: ContractRegistry;
}) {
  const program = ts.createProgram(appEntryFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
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
            registerVariableBinding(child, importBindings, localBindings);
          }
          ts.forEachChild(child, classVisit);
        };
        ts.forEachChild(node, classVisit);
        return;
      }

      if (ts.isVariableDeclaration(node)) {
        registerVariableBinding(node, importBindings, localBindings);
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
  importBindings: Map<string, ts.Symbol>,
  localBindings: Map<string, ts.Symbol>,
) {
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isNewExpression(declaration.initializer) ||
    !ts.isIdentifier(declaration.initializer.expression)
  ) {
    return;
  }
  const classSymbol = importBindings.get(
    declaration.initializer.expression.text,
  );
  if (classSymbol) {
    localBindings.set(declaration.name.text, classSymbol);
  }
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

function collectTypeElementMembers(members: ts.NodeArray<ts.TypeElement>) {
  const collected = new Set<string>();
  for (const member of members) {
    if (
      ts.isPropertySignature(member) ||
      ts.isMethodSignature(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}

function collectAliasMembers(typeNode: ts.TypeNode): Set<string> {
  if (ts.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }

  if (ts.isIntersectionTypeNode(typeNode)) {
    const members = new Set<string>();
    for (const child of typeNode.types) {
      for (const member of collectAliasMembers(child)) {
        members.add(member);
      }
    }
    return members;
  }

  return new Set();
}

function getReferencedContractSymbols(
  typeNodes: readonly (ts.TypeNode | ts.ExpressionWithTypeArguments)[],
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
) {
  const symbols = new Set<ts.Symbol>();
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(
      typeNode,
      checker,
      scannedFiles,
    )) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

function getContractSymbolsFromTypeNode(
  typeNode: ts.TypeNode | ts.ExpressionWithTypeArguments,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
): Set<ts.Symbol> {
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(
      checker.getSymbolAtLocation(typeNode.expression),
      checker,
    );
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles)
      ? new Set<ts.Symbol>([symbol])
      : new Set<ts.Symbol>();
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    const symbols = new Set<ts.Symbol>();
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(
        child,
        checker,
        scannedFiles,
      )) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(
      typeNode.typeName,
      checker,
      scannedFiles,
    );
  }

  return new Set<ts.Symbol>();
}

function getContractSymbolsFromEntityName(
  entityName: ts.EntityName,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
): Set<ts.Symbol> {
  const symbol = ts.isIdentifier(entityName)
    ? checker.getSymbolAtLocation(entityName)
    : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set<ts.Symbol>();
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles)
    ? new Set<ts.Symbol>([resolved])
    : new Set<ts.Symbol>();
}

function collectConstructorParamContracts(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
) {
  const constructorDeclaration = statement.members.find((member) =>
    ts.isConstructorDeclaration(member),
  );
  if (
    !constructorDeclaration ||
    !ts.isConstructorDeclaration(constructorDeclaration)
  ) {
    return [];
  }

  return constructorDeclaration.parameters.map((parameter) =>
    parameter.type
      ? getContractSymbolsFromTypeNode(parameter.type, checker, scannedFiles)
      : new Set<ts.Symbol>(),
  );
}

function getClassImplementedContracts(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  scannedFiles: Set<string>,
  seen = new Set<string>(),
) {
  const contracts = new Set<ts.Symbol>();
  const classSymbol =
    statement.name && checker.getSymbolAtLocation(statement.name);
  const classKey = classSymbol ? symbolCacheKey(classSymbol) : "";
  if (classKey && seen.has(classKey)) {
    return contracts;
  }
  if (classKey) {
    seen.add(classKey);
  }

  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(
          typeNode,
          checker,
          scannedFiles,
        )) {
          contracts.add(symbol);
        }
      }
      continue;
    }

    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(
          checker.getSymbolAtLocation(typeNode.expression),
          checker,
        );
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) =>
          ts.isClassDeclaration(item),
        );
        if (declaration && ts.isClassDeclaration(declaration)) {
          for (const symbol of getClassImplementedContracts(
            declaration,
            checker,
            scannedFiles,
            seen,
          )) {
            contracts.add(symbol);
          }
        }
      }
    }
  }

  return contracts;
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

export { createEmptyContractRegistry };
