import path from "path";
import ts from "typescript";

import {
  ClassContract,
  ContractRegistry,
  getPropertyNameText,
  hasNonPublicModifier,
  hasStaticModifier,
  InterfaceContract,
  isExportedDeclaration,
  isExternPropertyName,
  isScannedDeclarationSymbol,
  resolveAliasedSymbol,
  symbolCacheKey,
  TypeAliasContract,
} from "../shared";

export function collectContracts({
  checker,
  program,
  scannedFiles,
}: {
  checker: ts.TypeChecker;
  program: ts.Program;
  scannedFiles: string[];
}): ContractRegistry {
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
