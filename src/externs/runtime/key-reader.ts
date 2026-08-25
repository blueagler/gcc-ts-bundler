import ts from "@typescript/typescript6";

import { getStringLiteralMemberName, isAssignmentOperator } from "../shared";
import { collectUniqueConstBindings } from "./literal-keys";

/**
 * The property name an `o[k]` or `k in o` key expression provably reads.
 *
 * A string literal is the direct case. The other one is a *named* literal — a
 * file-local `const` bound once to a string, spelled out at the read site:
 *
 * ```js
 * const SKIP_CHECK  = "_skip_check_";                    // cssinjs
 * const MULTI_VALUE = "_multi_value_";
 * SKIP_CHECK in value || MULTI_VALUE in value            // the read
 * ```
 *
 * `in` with an identifier operand is the novel shape here, and it is the whole
 * hazard: antd defines the marker as an object-literal identifier key
 * (`margin: { _skip_check_: true, value: … }`), so the definition renames while
 * the const string does not. cssinjs then stops recognising its own RTL-exempt
 * wrapper, treats it as a nested selector and emits
 * `.ant-tabs-tab margin{va:true;value:…}` instead of `.ant-tabs-tab{margin:…}`.
 * No other evidence class sees it: the definition is a plain dot, so
 * `stringDefined ∩ dotAccessed` misses it; nothing is concatenated or
 * templated; no literal key list feeds a loop variable; no sibling names the
 * key. Only the resolution step was missing — the pin itself is the existing
 * `dotDefined ∩ stringLiteralRead` intersection.
 *
 * `collectUniqueConstBindings` supplies the proof: one declaration of the name
 * in the file, `const`, initialised to a literal. Measured over a 5,280-file
 * materialized tree: 9 names read this way, 4 of them dot-defined.
 */
export function createKeyNameReader(sourceFile: ts.SourceFile) {
  const constBindings = collectUniqueConstBindings(sourceFile);
  return (expression: ts.Expression | undefined) => {
    const literalName = getStringLiteralMemberName(expression);
    if (literalName !== null) {
      return literalName;
    }
    return expression && ts.isIdentifier(expression)
      ? getStringLiteralMemberName(constBindings.get(expression.text))
      : null;
  };
}

/** True when this element access is the left-hand side of an assignment. */
export function isAssignmentTarget(node: ts.ElementAccessExpression) {
  const { parent } = node;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    isAssignmentOperator(parent.operatorToken.kind)
  );
}
