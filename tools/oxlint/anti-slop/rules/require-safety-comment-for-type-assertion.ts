import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const commentOwnerKinds = new Set([
  "ExpressionStatement",
  "PropertyDefinition",
  "ReturnStatement",
  "ThrowStatement",
  "VariableDeclaration",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function isJustifiedBefore(
  sourceCode: SourceCode,
  owner: ESTree.Node,
  assertion: TypeAssertion,
): boolean {
  return sourceCode
    .getCommentsBefore(owner)
    .some((comment) => comment.end <= assertion.start && /\bSAFETY\s*:/u.test(comment.value));
}

function isExportWrapper(node: ESTree.Node): boolean {
  return node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
}

function hasSafetyComment(sourceCode: SourceCode, node: TypeAssertion): boolean {
  let current: ESTree.Node = node;
  while (true) {
    if (isJustifiedBefore(sourceCode, current, node)) return true;
    const parent: ESTree.Node = current.parent;
    if (commentOwnerKinds.has(current.type)) {
      // An `export` keyword sits between the justification and the declaration it documents, so the
      // comment attaches to the export rather than to the statement the walk stops at.
      return isExportWrapper(parent) && isJustifiedBefore(sourceCode, parent, node);
    }
    if (parent.type === "Program") return false;
    current = parent;
  }
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a nearby SAFETY comment for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no `SAFETY:` justification. State the checked invariant immediately before the assertion or its containing statement.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node) || hasSafetyComment(context.sourceCode, node)) return;
      context.report({ node, messageId: "missingSafetyComment" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
