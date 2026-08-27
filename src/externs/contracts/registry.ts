import path from "path";
import ts from "@typescript/typescript6";

import { getPropertyNameText, hasModifier } from "../../shared/typescript";
import {
  createEmptyContractRegistry,
  hasNonPublicModifier,
  isExternPropertyName,
  isScannedDeclarationSymbol,
  resolveAliasedSymbol,
} from "../shared";
import type { ContractRegistry } from "../shared";

interface ContractCollectionContext {
  checker: ts.TypeChecker;
  dependencyQueue: ts.Symbol[];
  program: ts.Program;
  registry: ContractRegistry;
  scannedFileSet: Set<string>;
  visitedDependencySymbols: Set<ts.Symbol>;
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
    dependencyQueue: [],
    program,
    registry,
    scannedFileSet: registry.scannedFiles,
    visitedDependencySymbols: new Set(),
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

  drainDependencyContracts(context);

  return registry;
}
/**
 * A package can type a boundary parameter with an interface that lives in one
 * of its own dependencies (`host: BaseHost`, where `BaseHost` is declared by
 * `base-host/index.d.ts`). Those declaration files sit outside the scanned set
 * whenever the plan resolves types without dependencies, yet the contract they
 * describe is still part of the package's call surface into app-owned objects.
 * Referenced dependency symbols are therefore queued while the scanned sweep
 * runs and collected afterwards, in reference order.
 */
function drainDependencyContracts(context: ContractCollectionContext) {
  for (let index = 0; index < context.dependencyQueue.length; index += 1) {
    const symbol = context.dependencyQueue[index];
    if (!symbol) continue;
    for (const declaration of symbol.declarations ?? []) {
      if (!isCollectableContractDeclaration(declaration)) continue;
      collectContract(declaration, context);
    }
  }
}

function isCollectableContractDeclaration(
  declaration: ts.Declaration,
): declaration is
  | ts.InterfaceDeclaration
  | ts.TypeAliasDeclaration
  | ts.ClassDeclaration {
  return (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isClassDeclaration(declaration)
  );
}

/**
 * Contract references are honoured when they resolve into the scanned set, and
 * additionally when they resolve into a non-default-library declaration file
 * reachable from it. The latter are queued so their members are collected too;
 * default libraries stay excluded so `Promise` or DOM members never leak in.
 */
function acceptsContractSymbol(
  symbol: ts.Symbol,
  context: ContractCollectionContext,
) {
  if (isScannedDeclarationSymbol(symbol, context.scannedFileSet)) {
    return true;
  }
  if (!isDependencyDeclarationSymbol(symbol, context.program)) {
    return false;
  }
  if (!context.visitedDependencySymbols.has(symbol)) {
    context.visitedDependencySymbols.add(symbol);
    context.dependencyQueue.push(symbol);
  }
  return true;
}

function isDependencyDeclarationSymbol(symbol: ts.Symbol, program: ts.Program) {
  return (symbol.declarations ?? []).some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return (
      sourceFile.isDeclarationFile &&
      !program.isSourceFileDefaultLibrary(sourceFile)
    );
  });
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
    !hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
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
      context,
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
      context,
    ),
    instanceMembers,
    name: statement.name.text,
    staticMembers,
    symbol,
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
    (hasModifier(member, ts.SyntaxKind.StaticKeyword)
      ? staticMembers
      : instanceMembers
    ).add(memberName);
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
  context: ContractCollectionContext,
) {
  const symbols = new Set<ts.Symbol>();
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(typeNode, context)) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

function getContractSymbolsFromTypeNode(
  typeNode: ts.TypeNode | ts.ExpressionWithTypeArguments,
  context: ContractCollectionContext,
): Set<ts.Symbol> {
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(
      context.checker.getSymbolAtLocation(typeNode.expression),
      context.checker,
    );
    return symbol && acceptsContractSymbol(symbol, context)
      ? new Set<ts.Symbol>([symbol])
      : new Set<ts.Symbol>();
  }

  if (ts.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, context);
  }

  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    const symbols = new Set<ts.Symbol>();
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(child, context)) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(typeNode.typeName, context);
  }

  return new Set<ts.Symbol>();
}

function getContractSymbolsFromEntityName(
  entityName: ts.EntityName,
  context: ContractCollectionContext,
): Set<ts.Symbol> {
  const symbol = ts.isIdentifier(entityName)
    ? context.checker.getSymbolAtLocation(entityName)
    : context.checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, context.checker);
  if (!resolved) {
    return new Set<ts.Symbol>();
  }
  return acceptsContractSymbol(resolved, context)
    ? new Set<ts.Symbol>([resolved])
    : new Set<ts.Symbol>();
}

function collectConstructorParamContracts(
  statement: ts.ClassDeclaration,
  context: ContractCollectionContext,
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
      ? getContractSymbolsFromTypeNode(parameter.type, context)
      : new Set<ts.Symbol>(),
  );
}
