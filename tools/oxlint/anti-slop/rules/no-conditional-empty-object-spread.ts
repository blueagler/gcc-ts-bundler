import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type ObjectSpread = ESTree.SpreadElement | ESTree.JSXSpreadAttribute;

/** Strips wrappers that leave the spread value unchanged, such as `as T` and `satisfies T`. */
function unwrapSpreadValue(node: ESTree.Expression): ESTree.Expression {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion"
  ) {
    current = current.expression;
  }
  return current;
}

function isObjectExpression(node: ESTree.Expression): boolean {
  return unwrapSpreadValue(node).type === "ObjectExpression";
}

function isEmptyObjectExpression(node: ESTree.Expression): boolean {
  const value = unwrapSpreadValue(node);
  return value.type === "ObjectExpression" && value.properties.length === 0;
}

function isConditionalEmptyObjectSpread(node: ESTree.Expression): boolean {
  const value = unwrapSpreadValue(node);
  if (value.type === "ConditionalExpression") {
    return isEmptyObjectExpression(value.consequent) || isEmptyObjectExpression(value.alternate);
  }
  if (value.type === "LogicalExpression" && (value.operator === "&&" || value.operator === "||")) {
    if (isEmptyObjectExpression(value.left) || isEmptyObjectExpression(value.right)) return true;
    // `...(hasTimeout && { timeout })` omits the key through the operator's falsy result, so the
    // empty object is never written down anywhere. One operand supplying the properties while the
    // other only decides whether they appear is the same omission with less for the reader to see.
    // Two object operands are a choice between shapes rather than an omission, so they stay silent.
    return isObjectExpression(value.left) !== isObjectExpression(value.right);
  }
  return false;
}

/** Ban conditional empty-object spreads without changing their omission semantics. */
export const noConditionalEmptyObjectSpreadRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow object and JSX attribute spreads that conditionally spread an empty object to omit fields.",
    },
    messages: {
      avoid:
        "This conditional spread hides property omission behind an empty object. Build the object in separate statements and add the property only when present.",
    },
  },
  createOnce(context) {
    const checkSpread = (node: ObjectSpread) => {
      if (node.type === "SpreadElement" && node.parent.type !== "ObjectExpression") return;

      if (isConditionalEmptyObjectSpread(node.argument)) {
        context.report({ node, messageId: "avoid" });
      }
    };

    return {
      SpreadElement: checkSpread,
      JSXSpreadAttribute: checkSpread,
    };
  },
});
