import ts from "@typescript/typescript6";

import { addMember, type RuntimeRenameHazards } from "./types";

/**
 * Member names a finite literal key list feeds into computed member access.
 *
 * Three binding forms carry the list to the key position, and all three keep
 * the list and its consumer inside one expression or statement, so resolving
 * them needs no scope tracking:
 *
 * ```js
 * arrayEach(['bind', 'bindKey'], function (k) { lodash[k]… });  // callback arg
 * ['title', 'extra'].forEach((k) => { props[k]… });             // callback receiver
 * for (const axis of ['x', 'y']) { speed[axis] = 0; }           // for…of
 * ```
 *
 * Requiring the *consumer* — a computed access keyed by the bound name — is
 * what makes this evidence rather than a string census. A literal array of
 * strings that nothing indexes with is a lookup table, a message list or an
 * enum, and pinning it would be a barrier explosion.
 */
export function collectEnumeratedKeyNames(
  sourceFile: ts.SourceFile,
  hazards: RuntimeRenameHazards,
) {
  const arrayBindings = collectUniqueConstBindings(sourceFile);
  const record = (
    keyNames: readonly string[],
    keyTransforms: readonly KeyTransform[],
  ) => {
    for (const keyName of keyNames) {
      for (const keyTransform of keyTransforms) {
        addMember(hazards.enumeratedKeyNames, keyTransform(keyName));
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      // `helper(<key list>, function (k) { … })`: argument positions are free,
      // because helpers disagree on them (`arrayEach(list, fn)` versus a
      // `fn`-first signature) and the consumer check carries the proof.
      for (const [index, argument] of node.arguments.entries()) {
        const keyNames = literalKeyList(argument, arrayBindings);
        if (!keyNames) continue;
        for (const [otherIndex, other] of node.arguments.entries()) {
          if (otherIndex === index) continue;
          record(keyNames, parameterKeyTransforms(other));
        }
      }
      // `<key list>.forEach(function (k) { … })`, and every other iterator
      // method shaped like it.
      if (ts.isPropertyAccessExpression(node.expression)) {
        const keyNames = literalKeyList(
          node.expression.expression,
          arrayBindings,
        );
        if (keyNames) {
          for (const argument of node.arguments) {
            record(keyNames, parameterKeyTransforms(argument));
          }
        }
      }
    } else if (
      ts.isForOfStatement(node) &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      const keyNames = literalKeyList(node.expression, arrayBindings);
      const [declaration] = node.initializer.declarations;
      if (keyNames && declaration && ts.isIdentifier(declaration.name)) {
        record(
          keyNames,
          collectKeyTransforms(node.statement, declaration.name.text),
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

/**
 * Names declared exactly once in the file by a `const` with an initializer.
 *
 * One declaration is what makes the binding resolvable without scope analysis:
 * nothing shadows the name, `const` forbids reassignment, so the initializer
 * is what every mention of it holds. antd's responsive observer needs this —
 * its key list is a module-level `const`, not an inline literal.
 */
export function collectUniqueConstBindings(sourceFile: ts.SourceFile) {
  const declarationCounts = new Map<string, number>();
  const constantInitializers = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    const declaredName = ts.isVariableDeclaration(node)
      ? node.name
      : ts.isParameter(node)
        ? node.name
        : ts.isBindingElement(node)
          ? node.name
          : ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
            ? node.name
            : ts.isImportSpecifier(node) ||
                ts.isImportClause(node) ||
                ts.isNamespaceImport(node)
              ? node.name
              : undefined;
    if (declaredName && ts.isIdentifier(declaredName)) {
      declarationCounts.set(
        declaredName.text,
        (declarationCounts.get(declaredName.text) ?? 0) + 1,
      );
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
      ) {
        constantInitializers.set(declaredName.text, node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const bindings = new Map<string, ts.Expression>();
  for (const [name, initializer] of constantInitializers) {
    if (declarationCounts.get(name) === 1) bindings.set(name, initializer);
  }
  return bindings;
}

/**
 * The finite set of strings an expression provably evaluates to, or null.
 *
 * Only shapes whose every element is a literal qualify. A `split` on a
 * non-literal, a spread, a hole, or a computed element makes the set unknown,
 * and an unknown set is not evidence. `concat`, `reverse` and `slice` are
 * admitted because they copy, permute or drop elements and can never invent
 * one, so the resulting key *set* is bounded by the literal list either way.
 */
function literalKeyList(
  expression: ts.Expression | undefined,
  bindings: ReadonlyMap<string, ts.Expression>,
  resolving: ReadonlySet<string> = new Set(),
): string[] | null {
  if (!expression) return null;
  if (ts.isParenthesizedExpression(expression)) {
    return literalKeyList(expression.expression, bindings, resolving);
  }
  // `['a', 'b']`
  if (ts.isArrayLiteralExpression(expression)) {
    const keyNames: string[] = [];
    for (const element of expression.elements) {
      if (!ts.isStringLiteralLike(element)) return null;
      keyNames.push(element.text);
    }
    return keyNames;
  }
  // `responsiveArray`, resolved through its single `const` declaration.
  if (ts.isIdentifier(expression)) {
    const initializer = bindings.get(expression.text);
    if (!initializer || resolving.has(expression.text)) return null;
    return literalKeyList(
      initializer,
      bindings,
      new Set([...resolving, expression.text]),
    );
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression)
  ) {
    const method = expression.expression.name.text;
    const receiver = expression.expression.expression;
    // `'a b c'.split(' ')`
    if (
      method === "split" &&
      ts.isStringLiteralLike(receiver) &&
      expression.arguments.length === 1 &&
      expression.arguments[0] !== undefined &&
      ts.isStringLiteralLike(expression.arguments[0])
    ) {
      return receiver.text
        .split(expression.arguments[0].text)
        .filter((keyName) => keyName.length > 0);
    }
    // `[].concat(responsiveArray).reverse()` — antd's spelling of the same
    // list. Order and multiplicity are irrelevant to a key set.
    if (method === "reverse" || method === "slice") {
      return literalKeyList(receiver, bindings, resolving);
    }
    if (method === "concat") {
      const keyNames = literalKeyList(receiver, bindings, resolving);
      if (!keyNames) return null;
      for (const argument of expression.arguments) {
        const argumentNames = ts.isStringLiteralLike(argument)
          ? [argument.text]
          : literalKeyList(argument, bindings, resolving);
        if (!argumentNames) return null;
        keyNames.push(...argumentNames);
      }
      return keyNames;
    }
    return null;
  }
  // `cond ? ['a'] : ['b']` — both arms must be literal lists.
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = literalKeyList(expression.whenTrue, bindings, resolving);
    const whenFalse = literalKeyList(expression.whenFalse, bindings, resolving);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

/** A total, statically evaluable transformation of one list element. */
type KeyTransform = (element: string) => string;

/**
 * One piece of a key built from a list element: either a fixed literal, or a
 * part that carries the element through a chain of total transformations.
 */
type KeyPart =
  { apply: KeyTransform; kind: "element" } | { kind: "literal"; text: string };

/** Keys the parameters of a callback argument build from a list element. */
function parameterKeyTransforms(argument: ts.Expression | undefined) {
  if (
    !argument ||
    !(ts.isFunctionExpression(argument) || ts.isArrowFunction(argument))
  ) {
    return [];
  }
  return argument.parameters.flatMap((parameter) =>
    ts.isIdentifier(parameter.name)
      ? collectKeyTransforms(argument.body, parameter.name.text)
      : [],
  );
}

/**
 * Every key that `elementName` provably reaches computed member-access
 * position as, inside `body`.
 *
 * The plain case is the identity (`speed[axis]`), but antd routes the element
 * through two intermediate `const`s before using it:
 *
 * ```js
 * const breakpointUpper = breakpoint.toUpperCase();       // 'XS'
 * const screenMin = `screen${breakpointUpper}Min`;        // 'screenXSMin'
 * if (!(token[screenMin] <= token[screen])) throw …       // STRING reads
 * ```
 *
 * Following those bindings needs no scope analysis: they are `const`, they are
 * visited in source order, and each one is admitted only when it evaluates to
 * a *total* transformation of the element — `toUpperCase`, `toLowerCase`, and
 * concatenation with fixed literals. Anything partial or unknown (a `replace`,
 * a lookup, another variable) stops the chain, so the computed key set stays
 * exactly as large as the literal list.
 */
function collectKeyTransforms(body: ts.Node, elementName: string) {
  const transforms = new Map<string, KeyTransform>([
    [elementName, (element) => element],
  ]);
  const keyTransforms: KeyTransform[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
    ) {
      const part = evaluateKeyPart(node.initializer, transforms);
      if (part?.kind === "element") transforms.set(node.name.text, part.apply);
    } else if (ts.isElementAccessExpression(node)) {
      const part = evaluateKeyPart(node.argumentExpression, transforms);
      if (part?.kind === "element") keyTransforms.push(part.apply);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return keyTransforms;
}

/** How an expression builds a key out of the element bound in `transforms`. */
function evaluateKeyPart(
  expression: ts.Expression,
  transforms: ReadonlyMap<string, KeyTransform>,
): KeyPart | null {
  if (ts.isParenthesizedExpression(expression)) {
    return evaluateKeyPart(expression.expression, transforms);
  }
  if (ts.isStringLiteralLike(expression)) {
    return { kind: "literal", text: expression.text };
  }
  if (ts.isIdentifier(expression)) {
    const apply = transforms.get(expression.text);
    return apply ? { apply, kind: "element" } : null;
  }
  // `k.toUpperCase()` / `k.toLowerCase()`: total on every string, so the key
  // set stays the size of the list.
  if (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 0 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    (expression.expression.name.text === "toUpperCase" ||
      expression.expression.name.text === "toLowerCase")
  ) {
    const toUpperCase = expression.expression.name.text === "toUpperCase";
    const inner = evaluateKeyPart(expression.expression.expression, transforms);
    if (!inner) return null;
    const changeCase = (value: string) =>
      toUpperCase ? value.toUpperCase() : value.toLowerCase();
    return inner.kind === "element"
      ? {
          apply: (element) => changeCase(inner.apply(element)),
          kind: "element",
        }
      : { kind: "literal", text: changeCase(inner.text) };
  }
  // `` `screen${upper}Min` ``
  if (ts.isTemplateExpression(expression)) {
    const parts: KeyPart[] = [{ kind: "literal", text: expression.head.text }];
    for (const span of expression.templateSpans) {
      const part = evaluateKeyPart(span.expression, transforms);
      if (!part) return null;
      parts.push(part, { kind: "literal", text: span.literal.text });
    }
    return joinKeyParts(parts);
  }
  // `k + 'Right'`
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateKeyPart(expression.left, transforms);
    const right = evaluateKeyPart(expression.right, transforms);
    return left && right ? joinKeyParts([left, right]) : null;
  }
  return null;
}

/**
 * Concatenate key parts, or null when the result cannot name a property that
 * Closure would rename.
 *
 * jQuery is why the literal guard exists: `class2type["[object " + name + "]"]`
 * runs a name list through element access, yet `[object Boolean]` is not an
 * identifier, so `Boolean`, `Date`, `Error` and five more would be pinned for
 * nothing. antd's `` `(max-width: ${token.screenXSMax}px)` `` is the same
 * shape and equally not a key.
 */
function joinKeyParts(parts: readonly KeyPart[]): KeyPart | null {
  const applyPart = (part: KeyPart, element: string) =>
    part.kind === "element" ? part.apply(element) : part.text;
  if (!parts.some((part) => part.kind === "element")) {
    return {
      kind: "literal",
      text: parts.map((part) => applyPart(part, "")).join(""),
    };
  }
  const identifierSafe = parts.every(
    (part) => part.kind === "element" || /^[\w$]*$/u.test(part.text),
  );
  if (!identifierSafe) return null;
  return {
    apply: (element) => parts.map((part) => applyPart(part, element)).join(""),
    kind: "element",
  };
}
