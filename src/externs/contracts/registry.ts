import path from "path";
import ts from "@typescript/typescript6";

import {
  createEmptyContractRegistry,
  getPropertyNameText,
  hasNonPublicModifier,
  hasStaticModifier,
  isExportedDeclaration,
  isExternPropertyName,
  isScannedDeclarationSymbol,
  resolveAliasedSymbol,
  symbolCacheKey,
} from "../shared";
import type { ContractRegistry } from "../shared";

interface ContractCollectionContext {
  checker: ts.TypeChecker;
  registry: ContractRegistry;
  scannedFileSet: Set<string>;
}

export function collectContracts({
  checker,
  program,
  scannedFiles,
}: {
  checker: ts.TypeChecker;
  program: ts.Program;
  scannedFiles: string[];
}): ContractRegistry {
  const registry = createEmptyContractRegistry();
  const context: ContractCollectionContext = {
    checker,
    registry,
    scannedFileSet: registry.scannedFiles,
  };
  for (const filePath of scannedFiles) {
    registry.scannedFiles.add(path.resolve(filePath));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (!registry.scannedFiles.has(path.resolve(sourceFile.fileName))) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      collectContract(statement, context);
    }
  }

  return registry;
}

function collectContract(
  statement: ts.Statement,
  context: ContractCollectionContext,
) {
  // Declaration packages built as ambient namespaces (`declare namespace
  // JQuery { interface Deferred { ... } }`, `declare global`) publish their
  // contracts without export keywords and nest them in module blocks.
  if (
    ts.isModuleDeclaration(statement) &&
    statement.body &&
    ts.isModuleBlock(statement.body)
  ) {
    for (const inner of statement.body.statements) {
      collectContract(inner, context);
    }
    return;
  }
  if (
    !isExportedDeclaration(statement) &&
    !statement.getSourceFile().isDeclarationFile
  ) {
    return;
  }
  if (ts.isInterfaceDeclaration(statement)) {
    collectInterfaceContract(statement, context);
  } else if (ts.isTypeAliasDeclaration(statement)) {
    collectTypeAliasContract(statement, context);
  } else if (ts.isClassDeclaration(statement) && statement.name) {
    collectClassContract(statement, context);
  }
}

function collectInterfaceContract(
  statement: ts.InterfaceDeclaration,
  context: ContractCollectionContext,
) {
  const symbol = context.checker.getSymbolAtLocation(statement.name);
  if (!symbol) {
    return;
  }
  context.registry.interfaceContracts.set(symbol, {
    extends: getReferencedContractSymbols(
      statement.heritageClauses?.flatMap((clause) => clause.types) ?? [],
      context.checker,
      context.scannedFileSet,
    ),
    members: collectTypeElementMembers(statement.members),
    name: statement.name.text,
    symbol,
  });
}

function collectTypeAliasContract(
  statement: ts.TypeAliasDeclaration,
  context: ContractCollectionContext,
) {
  const symbol = context.checker.getSymbolAtLocation(statement.name);
  const members = collectAliasMembers(statement.type);
  if (!symbol || members.size === 0) {
    return;
  }
  context.registry.typeAliasContracts.set(symbol, {
    members,
    name: statement.name.text,
    symbol,
  });
}

function collectClassContract(
  statement: ts.ClassDeclaration,
  context: ContractCollectionContext,
) {
  if (!statement.name) {
    return;
  }
  const symbol = context.checker.getSymbolAtLocation(statement.name);
  if (!symbol) {
    return;
  }
  const { instanceMembers, staticMembers } = collectClassMembers(statement);
  context.registry.classContracts.set(symbol, {
    constructorParamContracts: collectConstructorParamContracts(
      statement,
      context.checker,
      context.scannedFileSet,
    ),
    instanceMembers,
    name: statement.name.text,
    staticMembers,
    symbol,
    usedImplementedContracts: getClassImplementedContracts(
      statement,
      context.checker,
      context.scannedFileSet,
    ),
  });
}

function collectClassMembers(statement: ts.ClassDeclaration) {
  const instanceMembers = new Set<string>();
  const staticMembers = new Set<string>();
  for (const member of statement.members) {
    if (ts.isConstructorDeclaration(member) || hasNonPublicModifier(member)) {
      continue;
    }
    const memberName = getPropertyNameText(member.name);
    if (!memberName || !isExternPropertyName(memberName)) {
      continue;
    }
    (hasStaticModifier(member) ? staticMembers : instanceMembers).add(
      memberName,
    );
  }
  return { instanceMembers, staticMembers };
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
