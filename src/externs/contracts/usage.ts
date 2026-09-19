import ts from "@typescript/typescript6";

import { renderStructuralExternLine } from "../barriers";
import type { ExternAnalysisContext } from "../context";
import {
  collectStructuralContractMembers,
  isExternPropertyName,
  isProjectAppSourceFile,
  resolveTypeSymbol,
  resolveValueSymbol,
} from "../shared";
import type { ContractRegistry } from "../shared";
import { collectContracts } from "./registry";

interface UsageAnalysis {
  nominalMembers: Set<string>;
  structuralContracts: Set<ts.Symbol>;
  structuralMembers: Set<string>;
}

function analyzeAppUsage(analysis: ExternAnalysisContext) {
  const { checker, program, projectRoot, scannedFiles } = analysis;
  const registry = collectContracts({ checker, program, scannedFiles });
  const usage: UsageAnalysis = {
    nominalMembers: new Set(),
    structuralContracts: new Set(),
    structuralMembers: new Set(),
  };
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) =>
      isProjectAppSourceFile(sourceFile.fileName, projectRoot),
    );

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        analyzeNewExpression(node, checker, registry, usage);
      } else if (
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        analyzeMemberAccess(node, checker, registry, usage);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const structuralMembers = new Set<string>();
  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, registry)) {
      structuralMembers.add(member);
    }
  }
  for (const member of usage.structuralMembers) {
    structuralMembers.add(member);
  }
  return {
    nominalMembers: usage.nominalMembers,
    structuralMembers,
  };
}

export function collectBoundaryAwareExternLines(
  analysis: ExternAnalysisContext,
) {
  const usage = analyzeAppUsage(analysis);
  const emittedLines = new Set<string>();

  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }

  return emittedLines;
}

export function collectBoundaryAwareUsageMemberNames(
  analysis: ExternAnalysisContext,
) {
  const usage = analyzeAppUsage(analysis);
  const members = usage.structuralMembers;
  for (const member of usage.nominalMembers) {
    members.add(member);
  }

  return members;
}

function analyzeNewExpression(
  node: ts.NewExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
) {
  const calleeSymbol =
    resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker) ??
    resolveValueSymbol(node.expression, checker);
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

function analyzeMemberAccess(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  registry: ContractRegistry,
  usage: UsageAnalysis,
) {
  const propertyName = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  if (!propertyName || !isExternPropertyName(propertyName)) {
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
    usage.nominalMembers.add(propertyName);
  } else if (
    registry.interfaceContracts.has(typeSymbol) ||
    registry.typeAliasContracts.has(typeSymbol)
  ) {
    usage.structuralMembers.add(propertyName);
  }
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
