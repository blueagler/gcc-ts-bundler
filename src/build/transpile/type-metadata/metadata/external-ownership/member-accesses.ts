import ts from "@typescript/typescript6";

import {
  type RuntimeBoundaryDeclarationOrigins,
  forEachBoundaryCallArgument,
  getStaticPropertyName,
  symbolOriginatesFromRuntimeBoundary,
  toUtf8Offset,
  typeIdentityKeys,
  typeOriginatesFromRuntimeBoundary,
  unwrapExpression,
} from "./shared";

export type { RuntimeBoundaryDeclarationOrigins };

export function collectExternalOwnedMemberAccesses({
  checker,
  externalGlobalMemberAccesses = [],
  origins,
  sourceFile,
}: {
  checker: ts.TypeChecker;
  externalGlobalMemberAccesses?: readonly number[] | undefined;
  origins: RuntimeBoundaryDeclarationOrigins;
  sourceFile: ts.SourceFile;
}): number[] {
  const starts = new Set<number>(externalGlobalMemberAccesses);
  if (
    origins.files.size === 0 &&
    origins.moduleFiles.size === 0 &&
    origins.packageRoots.length === 0
  )
    return [...starts].sort((left, right) => left - right);
  const visitedInitializers = new Set<ts.Node>();
  const isBoundaryType = (type: ts.Type | undefined) =>
    type !== undefined &&
    typeOriginatesFromRuntimeBoundary(type, checker, origins, new Set());
  const hasBoundaryProperty = (type: ts.Type, name: string) =>
    symbolOriginatesFromRuntimeBoundary(
      checker.getPropertyOfType(type, name),
      origins,
    ) ||
    typeIdentityKeys(type).some((identity) =>
      origins.ownedProperties.get(identity)?.has(name),
    );
  const markKey = (key: ts.PropertyName | ts.BindingName) => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
      starts.add(toUtf8Offset(sourceFile, key.getStart(sourceFile)));
    }
  };
  function markContextualValue(
    expression: ts.Expression,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) {
      followIdentifierInitializers(expression, expectedType, followedSymbols);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      markContextualValue(expression.whenTrue, expectedType, followedSymbols);
      markContextualValue(expression.whenFalse, expectedType, followedSymbols);
      return;
    }
    if (ts.isCallExpression(expression)) {
      markMappedCallbackReturns(expression, expectedType, followedSymbols);
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      markArrayLiteralElements(expression, expectedType, followedSymbols);
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;
    for (const property of expression.properties) {
      markObjectLiteralProperty(property, expectedType, followedSymbols);
    }
  }
  function followIdentifierInitializers(
    expression: ts.Identifier,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    if (!symbol || followedSymbols.has(symbol)) return;
    const nextSymbols = new Set(followedSymbols).add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        visitedInitializers.has(declaration.initializer)
      ) {
        continue;
      }
      visitedInitializers.add(declaration.initializer);
      markContextualValue(declaration.initializer, expectedType, nextSymbols);
    }
  }
  function markMappedCallbackReturns(
    expression: ts.CallExpression,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    const methodName = ts.isPropertyAccessExpression(expression.expression)
      ? expression.expression.name.text
      : null;
    if (methodName !== "map" && methodName !== "flatMap") return;
    const elementType = checker.getIndexTypeOfType(
      expectedType,
      ts.IndexKind.Number,
    );
    const callback = expression.arguments[0];
    if (
      elementType &&
      callback &&
      (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ) {
      markFunctionReturns(
        callback,
        elementType,
        methodName === "flatMap" ? expectedType : undefined,
        followedSymbols,
      );
    }
  }
  function markArrayLiteralElements(
    expression: ts.ArrayLiteralExpression,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    const elementType = checker.getIndexTypeOfType(
      expectedType,
      ts.IndexKind.Number,
    );
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        markContextualValue(element.expression, expectedType, followedSymbols);
      } else if (elementType) {
        markContextualValue(element, elementType, followedSymbols);
      }
    }
  }
  function markObjectLiteralProperty(
    property: ts.ObjectLiteralElementLike,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    if (ts.isSpreadAssignment(property)) {
      markContextualValue(property.expression, expectedType, followedSymbols);
      return;
    }
    if (property.name) markKey(property.name);
    if (!ts.isPropertyAssignment(property)) return;
    const name = getStaticPropertyName(property.name);
    const propertySymbol = name
      ? checker.getPropertyOfType(expectedType, name)
      : undefined;
    const propertyType = propertySymbol
      ? checker.getTypeOfSymbolAtLocation(propertySymbol, property.name)
      : undefined;
    if (!propertyType) return;
    markContextualValue(property.initializer, propertyType, followedSymbols);
  }
  function markFunctionReturns(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    expectedType: ts.Type,
    arrayExpectedType: ts.Type | undefined,
    followedSymbols: Set<ts.Symbol>,
  ) {
    const markReturn = (expression: ts.Expression) =>
      markContextualValue(
        expression,
        arrayExpectedType &&
          ts.isArrayLiteralExpression(unwrapExpression(expression))
          ? arrayExpectedType
          : expectedType,
        followedSymbols,
      );
    if (!ts.isBlock(callback.body)) {
      markReturn(callback.body);
      return;
    }
    const visitReturn = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        markReturn(node.expression);
        return;
      }
      if (ts.isFunctionLike(node) && node !== callback) return;
      ts.forEachChild(node, visitReturn);
    };
    visitReturn(callback.body);
  }
  function markBoundaryObjectLiteralKeys(node: ts.ObjectLiteralExpression) {
    const contextualType = checker.getContextualType(node);
    const ownType = checker.getTypeAtLocation(node);
    const boundaryType =
      isBoundaryType(ownType) || isBoundaryType(contextualType);
    for (const property of node.properties) {
      if (!property.name) continue;
      const name = getStaticPropertyName(property.name);
      if (
        boundaryType ||
        (name !== null &&
          ((contextualType && hasBoundaryProperty(contextualType, name)) ||
            hasBoundaryProperty(ownType, name)))
      ) {
        markKey(property.name);
      }
    }
  }
  function markBoundaryPropertyAccess(node: ts.PropertyAccessExpression) {
    const receiverType = checker.getTypeAtLocation(node.expression);
    if (
      isBoundaryType(receiverType) ||
      hasBoundaryProperty(receiverType, node.name.text)
    ) {
      starts.add(toUtf8Offset(sourceFile, node.name.getStart(sourceFile)));
    }
  }
  function markBoundaryBindingElement(node: ts.BindingElement) {
    const receiverType = checker.getTypeAtLocation(node.parent);
    const key = node.propertyName ?? node.name;
    const name =
      ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
    if (
      isBoundaryType(receiverType) ||
      (name !== null && hasBoundaryProperty(receiverType, name))
    ) {
      markKey(key);
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      markBoundaryObjectLiteralKeys(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      markBoundaryPropertyAccess(node);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      markBoundaryBindingElement(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isBoundaryType(checker.getTypeAtLocation(node.name))
    ) {
      markContextualValue(
        node.initializer,
        checker.getTypeAtLocation(node.name),
        new Set(),
      );
    } else if (ts.isCallExpression(node)) {
      forEachBoundaryCallArgument(
        node,
        checker,
        origins,
        (argument, parameterType) => {
          markContextualValue(argument, parameterType, new Set());
        },
      );
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isBoundaryType(checker.getTypeAtLocation(node.left))
    ) {
      markContextualValue(
        node.right,
        checker.getTypeAtLocation(node.left),
        new Set(),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...starts].sort((left, right) => left - right);
}
