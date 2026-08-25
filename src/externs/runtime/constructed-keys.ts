import ts from "@typescript/typescript6";

import { getStringLiteralMemberName } from "../shared";
import {
  KEY_FRAGMENT_PREFIX,
  KEY_FRAGMENT_SUFFIX,
  type RuntimeRenameHazards,
} from "./types";

/** Shortest literal fragment worth pinning on; below this it matches noise. */
const MIN_KEY_FRAGMENT_LENGTH = 3;

/**
 * Literal pieces of a `+`-concatenated property key.
 *
 * `deferred[tuple[0] + "With"]` yields `suffix:With`; `cache["evt" + type]`
 * yields `prefix:evt`. Only the outermost operands are read, because those are
 * the ones anchored to a key boundary: an inner fragment (`a + "x" + b`) is
 * neither a prefix nor a suffix of the finished key and cannot be matched
 * against a member name.
 *
 * Fragments shorter than `MIN_KEY_FRAGMENT_LENGTH` are dropped — a one- or
 * two-character anchor (`o[k + "s"]`) matches a large share of any program's
 * member names, which is a barrier explosion, not evidence.
 */
export function collectConstructedKeyFragments(
  argument: ts.Expression | undefined,
  hazards: RuntimeRenameHazards,
) {
  if (!argument || !ts.isBinaryExpression(argument)) return;
  if (argument.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;

  const leading = leftmostOperand(argument);
  const trailing = rightmostOperand(argument);
  const prefix = getStringLiteralMemberName(leading);
  const suffix = getStringLiteralMemberName(trailing);
  if (prefix && prefix.length >= MIN_KEY_FRAGMENT_LENGTH) {
    hazards.constructedKeyFragments.add(`${KEY_FRAGMENT_PREFIX}${prefix}`);
  }
  // A key that is entirely one literal is not concatenated evidence.
  if (
    suffix &&
    suffix.length >= MIN_KEY_FRAGMENT_LENGTH &&
    trailing !== leading
  ) {
    hazards.constructedKeyFragments.add(`${KEY_FRAGMENT_SUFFIX}${suffix}`);
  }
}

function leftmostOperand(expression: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? leftmostOperand(expression.left)
    : expression;
}

function rightmostOperand(expression: ts.Expression): ts.Expression {
  return ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ? rightmostOperand(expression.right)
    : expression;
}

/**
 * Records the head of a key-building template literal
 * (`` `$evt${type}` ``). Only `$`/`_`-leading identifier-shaped heads count:
 * that is the framework-internal-name convention, and it keeps message and
 * URL templates out of the evidence. Position is deliberately ignored -
 * vapor assigns the template to a `key` const before indexing with it, so
 * requiring an element-access parent would miss the real pattern.
 */
export function collectConstructedKeyPrefix(
  node: ts.TemplateExpression,
  hazards: RuntimeRenameHazards,
) {
  const head = node.head.text;
  if (/^[$_][\w$]*$/u.test(head) && head.length >= 2) {
    hazards.constructedKeyPrefixes.add(head);
  }
}
