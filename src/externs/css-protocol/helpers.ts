import ts from "@typescript/typescript6";

import {
  CSS_VARIABLE_MARKER,
  ITERATION_METHODS,
  KEY_ENUMERATION_METHODS,
  isFunctionLikeNode,
  type EnumeratedKeyBinding,
  type FunctionLikeNode,
} from "./types";

export function collectReturnExpressions(
  fn: FunctionLikeNode,
): ts.Expression[] {
  const body = fn.body;
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLikeNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      returns.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returns;
}

export function templateContainsMarker(template: ts.TemplateExpression) {
  return (
    template.head.text.includes(CSS_VARIABLE_MARKER) ||
    template.templateSpans.some((span) =>
      span.literal.text.includes(CSS_VARIABLE_MARKER),
    )
  );
}

export function concatenationContainsMarker(expression: ts.BinaryExpression) {
  let root: ts.Node = expression;
  while (
    ts.isBinaryExpression(root.parent) &&
    root.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    root = root.parent;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isStringLiteral(node) && node.text.includes(CSS_VARIABLE_MARKER)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Bindings that receive the enumerated keys of some object, with the scope each
 * binding is live in: `Object.keys(o).forEach(k => …)`, `for (const k in o)`,
 * `for (const [k, v] of Object.entries(o))`, and the same through a local that
 * holds the key list.
 */
export function collectEnumeratedKeyBindings(
  scope: ts.Node,
): EnumeratedKeyBinding[] {
  const bindings: EnumeratedKeyBinding[] = [];
  const aliases = new Map<string, ts.Expression>();

  const enumeratedObject = (node: ts.Expression): ts.Expression | null => {
    if (!ts.isCallExpression(node)) return null;
    const callee = node.expression;
    const [argument] = node.arguments;
    return ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      KEY_ENUMERATION_METHODS.has(callee.name.text) &&
      argument
      ? argument
      : null;
  };

  const bindingNameOf = (name: ts.BindingName): string | null => {
    if (ts.isIdentifier(name)) return name.text;
    if (!ts.isArrayBindingPattern(name)) return null;
    const [first] = name.elements;
    return first && ts.isBindingElement(first) && ts.isIdentifier(first.name)
      ? first.name.text
      : null;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const enumerated = enumeratedObject(node.initializer);
      if (enumerated) aliases.set(node.name.text, enumerated);
    }
    const keyListSource = (expression: ts.Expression) =>
      enumeratedObject(expression) ??
      (ts.isIdentifier(expression)
        ? (aliases.get(expression.text) ?? null)
        : null);

    if (
      ts.isForInStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations[0]
    ) {
      const key = bindingNameOf(node.initializer.declarations[0].name);
      if (key) {
        bindings.push({ key, scope: node.statement, source: node.expression });
      }
    }
    if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations[0]
    ) {
      const source = keyListSource(node.expression);
      const key = source
        ? bindingNameOf(node.initializer.declarations[0].name)
        : null;
      if (key && source) bindings.push({ key, scope: node.statement, source });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ITERATION_METHODS.has(node.expression.name.text)
    ) {
      const source = keyListSource(node.expression.expression);
      const [callback] = node.arguments;
      const parameter =
        callback && isFunctionLikeNode(callback)
          ? callback.parameters[0]
          : undefined;
      if (source && callback && isFunctionLikeNode(callback) && parameter) {
        const key = bindingNameOf(parameter.name);
        if (key && callback.body) {
          bindings.push({ key, scope: callback.body, source });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  // Two passes: the key list may be bound after the iteration site.
  visit(scope);
  visit(scope);

  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const key = `${binding.key}\u0000${binding.scope.pos}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
