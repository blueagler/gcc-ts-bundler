import fs from "fs";
import ts from "@typescript/typescript6";

import {
  getScriptKindForFile,
  getStringLiteralMemberName,
  isAssignmentOperator,
  isKnownConstructorExpression,
  isKnownPrototypeExpression,
  isObjectDefinePropertyCall,
  isRuntimeExternPropertyName,
  isThisOrSuperExpression,
} from "./shared";

/**
 * Evidence classes for member renaming, not a flat "defined"/"accessed" split.
 *
 * A member only needs an extern when its definition and its reads *cannot
 * rename together* inside one Closure invocation. Dot-defined plus dot-accessed
 * renames consistently and needs nothing; the hazard is a mixed pair, where one
 * side is a string that Closure leaves alone while the other side gets renamed.
 *
 * Definitions stay restricted to recognisable runtime targets (`this`/`super`,
 * a known constructor or its prototype) because that is what makes them
 * attributable. Reads are deliberately *unrestricted*: the string-keyed
 * definition and the dot read usually live in different functions, and the read
 * side is normally a plain parameter (`effect.nodes`), so a target restriction
 * there would miss the hazard the rule exists to catch.
 */
export interface RuntimeRenameHazards {
  /**
   * Identifier-shaped heads of template literals that build property keys
   * (`` node[`$evt${type}`] ``, vue vapor's event delegation). The full key
   * is invisible statically, but a dot-defined member matching a collected
   * prefix is read through it at runtime. Restricted to `$`/`_`-leading
   * heads: framework-internal protocol names by convention, which keeps
   * message templates and URL builders out of the evidence.
   */
  constructedKeyPrefixes: Set<string>;
  /**
   * Literal fragments of property keys assembled with `+` *in element-access
   * position*: `deferred[tuple[0] + "With"]` contributes the suffix `With`.
   *
   * This is the other half of the constructed-key hazard and the one that
   * actually bites in the wild. jQuery defines its Deferred API entirely
   * through concatenated keys (`deferred[tuple[0] + "With"] = list.fireWith`,
   * jquery.js:3705) and reads it back with a plain dot
   * (`readyList.resolveWith(...)`, jquery.js:3844). The definition is invisible
   * to Closure, so the runtime property keeps its literal name, while the dot
   * read renames — `TypeError: Fb.ga is not a function` on first paint.
   *
   * Unlike `constructedKeyPrefixes`, position is *required*: only an
   * `obj[… + …]` argument counts. A bare `"a" + b` anywhere in a file is a
   * message, not a key, and treating it as evidence would pin most of the
   * program.
   */
  constructedKeyFragments: Set<string>;
  /**
   * Member names a stylesheet spells out as CSS custom properties.
   *
   * `@ant-design/cssinjs` enumerates a token object and transliterates every
   * key into a `--ant-…` custom-property name, so the renamed spelling is what
   * lands in the stylesheet — and `$` is not a legal CSS identifier, so the
   * declaration is dropped. Collected by a k-bounded backward taint from the
   * escape site; see `externs/css-variable-protocol.ts`.
   *
   * The flow crosses three packages, so this class is filled by a global pass
   * over the whole post-prebundle graph, not by the per-package hazard scan.
   */
  cssVariableKeyNames: Set<string>;
  /** `o.x` read anywhere. */
  dotAccessed: Set<string>;
  /** `this.x = v`, class members, object-literal keys. */
  dotDefined: Set<string>;
  /**
   * Member names enumerated by a *finite literal key list* that provably
   * reaches computed member-access position.
   *
   * ```js
   * lodash.bind = func.bind;                                   // lodash.js:101
   * arrayEach(['bind', 'bindKey', 'curry', 'curryRight',       // :427
   *            'partial', 'partialRight'], function (methodName) {
   *   lodash[methodName].placeholder = lodash;                 // :428
   * });
   * ```
   *
   * No other evidence class sees this. The definition is a plain dot, so
   * `stringDefined ∩ dotAccessed` misses it; the read goes through a loop
   * variable rather than a literal, so `dotDefined ∩ stringLiteralRead` misses
   * it; nothing is concatenated or templated, so the constructed-key classes
   * miss it; the names live in an array, not as a sibling value of the literal
   * they name, so `selfReferentialKeys` misses it. Closure renames
   * `lodash.bind` to `nZ.cY`, the array string stays `"bind"`, and
   * `lodash["bind"]` yields `undefined` — `TypeError: Cannot set properties of
   * undefined (setting 'placeholder')` at first evaluation of the module.
   *
   * The rule is a proof, not a guess: the list must be a literal
   * (`['a', 'b']` or `'a b'.split(' ')`, including a literal ternary between
   * two such lists), and the binding it feeds — a callback parameter of the
   * same call, or a `for…of` variable — must be used as a computed key inside
   * that callback or loop body. Concatenated uses (`o[k + 'Right']`) count,
   * because the fragment class pins the suffix but not the stem.
   *
   * Measured over 4,469 materialized dependency files of a TanStack Start +
   * AntD Pro app: 11 sites, 44 names.
   */
  enumeratedKeyNames: Set<string>;
  protocolMembers: Set<string>;
  /**
   * Keys of an object literal that a *sibling* property of the same literal
   * names with a string-literal value — a self-referential key.
   *
   * ```js
   * jQuery.easing = {                       // jquery.js:7135
   *   linear:   function (p) { … },
   *   swing:    function (p) { … },
   *   _default: "swing"                     // VALUE naming a sibling KEY
   * };
   * this.easing = easing || jQuery.easing._default;   // :7045
   * this.pos = jQuery.easing[this.easing](…);         // :7063
   * ```
   *
   * No other evidence class sees this. The key is dot-defined, so
   * `stringDefined ∩ dotAccessed` misses it; the read goes through a variable,
   * so `dotDefined ∩ stringLiteralRead` misses it; nothing is concatenated, so
   * the constructed-key classes miss it. Closure renames `swing`, the string
   * does not follow, and `jQuery.easing[…]` yields `undefined` — `.animate()`
   * silently produces no tween, inside a `requestAnimationFrame` tick where
   * nothing surfaces the error.
   *
   * The rule is deliberately narrow: the value must be a plain string literal,
   * the key it names must be a sibling *identifier* key of the **same** literal
   * (a quoted key never renames, so it needs no pin), and nesting does not
   * cross literal boundaries. Audited over all 12 `_default` sites in
   * `jquery.js`: fires exactly once.
   */
  selfReferentialKeys: Set<string>;
  /**
   * `__publicField(this, "x")`, `defineProperty`, `this["x"] =`, `"x" = v`.
   * Hyphenated keys also record their identifier aliases — camelCase and
   * underscored. A hyphen is not a legal identifier, so a hyphenated site can
   * only ever reach a member through one of those spellings: framework prop
   * systems bridge quoted kebab-case pass sites to camelCase declaration keys
   * via `camelize`, and locale tables bridge `"zh-CN"` to `zh_CN`.
   */
  stringDefined: Set<string>;
  /** `o["x"]` read or `"x" in o`. */
  stringLiteralRead: Set<string>;
}

/**
 * A literal piece of a concatenated key, encoded as `prefix:<text>` or
 * `suffix:<text>`. Kept as a plain string so the hazard sets stay homogeneous
 * and `mergeRuntimeHazards` can loop over them generically.
 */
export const KEY_FRAGMENT_PREFIX = "prefix:";
export const KEY_FRAGMENT_SUFFIX = "suffix:";

export interface RuntimeProtocolHelpers {
  keyExclusionListCallees: string[];
  keyReadCallees: string[];
}

function createEmptyRuntimeHazards(): RuntimeRenameHazards {
  return {
    constructedKeyFragments: new Set(),
    constructedKeyPrefixes: new Set(),
    cssVariableKeyNames: new Set(),
    dotAccessed: new Set(),
    dotDefined: new Set(),
    enumeratedKeyNames: new Set(),
    protocolMembers: new Set(),
    selfReferentialKeys: new Set(),
    stringDefined: new Set(),
    stringLiteralRead: new Set(),
  };
}

export function mergeRuntimeHazards(
  ...hazardsList: readonly RuntimeRenameHazards[]
): RuntimeRenameHazards {
  const merged = createEmptyRuntimeHazards();
  for (const hazards of hazardsList) {
    mergeHazardSet(
      merged.constructedKeyFragments,
      hazards.constructedKeyFragments,
    );
    mergeHazardSet(
      merged.constructedKeyPrefixes,
      hazards.constructedKeyPrefixes,
    );
    mergeHazardSet(merged.cssVariableKeyNames, hazards.cssVariableKeyNames);
    mergeHazardSet(merged.dotAccessed, hazards.dotAccessed);
    mergeHazardSet(merged.dotDefined, hazards.dotDefined);
    mergeHazardSet(merged.enumeratedKeyNames, hazards.enumeratedKeyNames);
    mergeHazardSet(merged.protocolMembers, hazards.protocolMembers);
    mergeHazardSet(merged.selfReferentialKeys, hazards.selfReferentialKeys);
    mergeHazardSet(merged.stringDefined, hazards.stringDefined);
    mergeHazardSet(merged.stringLiteralRead, hazards.stringLiteralRead);
  }
  return merged;
}

function mergeHazardSet(target: Set<string>, source: ReadonlySet<string>) {
  for (const member of source) target.add(member);
}

export async function analyzeRuntimeUsage(
  runtimeEntryFiles: string[],
  protocolHelpers: RuntimeProtocolHelpers,
) {
  const hazards = createEmptyRuntimeHazards();

  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts.createSourceFile(
      runtimeEntryFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKindForFile(runtimeEntryFile),
    );
    collectFileHazards(sourceFile, hazards, protocolHelpers);
  }

  return hazards;
}

function collectFileHazards(
  sourceFile: ts.SourceFile,
  hazards: RuntimeRenameHazards,
  protocolHelpers: RuntimeProtocolHelpers,
) {
  const knownConstructors = collectKnownConstructorBindings(sourceFile);
  const provenFieldHelpers = collectProvenFieldHelperNames(sourceFile);
  collectLiteralIndexedKeyReaders(sourceFile, hazards);
  collectEnumeratedKeyNames(sourceFile, hazards);
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      addMember(hazards.dotAccessed, node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      // Position matters here and only here: an `obj[…]` argument is a
      // property key by construction, so a literal piece of it is evidence
      // even though the whole key is not statically known.
      collectConstructedKeyFragments(node.argumentExpression, hazards);
      if (!isAssignmentTarget(node)) {
        addMember(
          hazards.stringLiteralRead,
          getStringLiteralMemberName(node.argumentExpression),
        );
      }
    } else if (ts.isTemplateExpression(node)) {
      collectConstructedKeyPrefix(node, hazards);
    } else if (ts.isBinaryExpression(node)) {
      if (isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, hazards);
      } else if (node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        addMember(
          hazards.stringLiteralRead,
          getStringLiteralMemberName(node.left),
        );
      }
    } else if (ts.isCallExpression(node)) {
      collectProtocolHelperMembers(node, hazards, protocolHelpers);
      collectRuntimeCallMembers(
        node,
        knownConstructors,
        provenFieldHelpers,
        hazards,
      );
    } else if (ts.isClassLike(node)) {
      collectClassMemberDefinitions(node, hazards);
    } else if (ts.isObjectLiteralExpression(node)) {
      collectObjectLiteralDefinitions(node, hazards);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

/**
 * Resolve small local helpers that read object keys from indexed characters of
 * literal arguments, for example `matchFormat("hsv")` implemented as
 * `str[0] in input && str[1] in input && str[2] in input`.
 *
 * Closure can rename `{ h, s, v }` while those runtime string characters stay
 * fixed. Requiring a direct local function declaration, numeric character
 * indices, and direct string-literal calls keeps this a proof rather than a
 * name-based protocol guess.
 */
function collectLiteralIndexedKeyReaders(
  sourceFile: ts.SourceFile,
  hazards: RuntimeRenameHazards,
) {
  type Reader = {
    characterIndicesByParameter: Map<number, Set<number>>;
    declarationCount: number;
  };
  const readers = new Map<string, Reader>();

  const collectDeclarations = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const characterIndicesByParameter = new Map<number, Set<number>>();
      const parameterIndexByName = new Map<string, number>();
      for (const [index, parameter] of node.parameters.entries()) {
        if (ts.isIdentifier(parameter.name)) {
          parameterIndexByName.set(parameter.name.text, index);
        }
      }
      const inspect = (child: ts.Node) => {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.InKeyword &&
          ts.isElementAccessExpression(child.left) &&
          ts.isIdentifier(child.left.expression) &&
          child.left.argumentExpression &&
          ts.isNumericLiteral(child.left.argumentExpression)
        ) {
          const parameterIndex = parameterIndexByName.get(
            child.left.expression.text,
          );
          const characterIndex = Number(child.left.argumentExpression.text);
          if (
            parameterIndex !== undefined &&
            Number.isSafeInteger(characterIndex) &&
            characterIndex >= 0
          ) {
            const indices =
              characterIndicesByParameter.get(parameterIndex) ??
              new Set<number>();
            indices.add(characterIndex);
            characterIndicesByParameter.set(parameterIndex, indices);
          }
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node.body);
      if (characterIndicesByParameter.size > 0) {
        const previous = readers.get(node.name.text);
        readers.set(node.name.text, {
          characterIndicesByParameter,
          declarationCount: (previous?.declarationCount ?? 0) + 1,
        });
      }
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const reader = readers.get(node.expression.text);
      if (reader?.declarationCount === 1) {
        for (const [
          parameterIndex,
          characterIndices,
        ] of reader.characterIndicesByParameter) {
          const argument = node.arguments[parameterIndex];
          if (!argument || !ts.isStringLiteralLike(argument)) continue;
          for (const characterIndex of characterIndices) {
            addMember(hazards.stringLiteralRead, argument.text[characterIndex]);
          }
        }
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);
}

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
function collectEnumeratedKeyNames(
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
function collectUniqueConstBindings(sourceFile: ts.SourceFile) {
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
  | { apply: KeyTransform; kind: "element" }
  | { kind: "literal"; text: string };

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
function collectConstructedKeyFragments(
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
function collectConstructedKeyPrefix(
  node: ts.TemplateExpression,
  hazards: RuntimeRenameHazards,
) {
  const head = node.head.text;
  if (/^[$_][\w$]*$/u.test(head) && head.length >= 2) {
    hazards.constructedKeyPrefixes.add(head);
  }
}

function addMember(target: Set<string>, memberName: string | null | undefined) {
  if (memberName && isRuntimeExternPropertyName(memberName)) {
    target.add(memberName);
    // A hyphenated key is never the renamed form of an identifier member, so
    // its identifier spellings are what a hyphenated site actually reaches.
    // Prop systems bridge quoted kebab-case pass sites ("click-count") to
    // camelCase declaration keys via camelize; locale tables bridge dashed
    // keys ("zh-CN") to underscored ones. pro-components builds its intl map
    // with `Object.fromEntries(Object.keys(localeMessages).map(k =>
    // [k.replace("_", "-"), …]))` and then reads `intlMap["zh-CN"]`, so
    // renaming `zh_CN` leaves every lookup undefined.
    if (memberName.includes("-")) {
      const camelized = memberName.replace(/-(\w)/gu, (_, letter: string) =>
        letter.toUpperCase(),
      );
      if (isRuntimeExternPropertyName(camelized)) {
        target.add(camelized);
      }
      const underscored = memberName.replace(/-/gu, "_");
      if (isRuntimeExternPropertyName(underscored)) {
        target.add(underscored);
      }
    }
  }
}

/** True when this element access is the left-hand side of an assignment. */
function isAssignmentTarget(node: ts.ElementAccessExpression) {
  const { parent } = node;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    isAssignmentOperator(parent.operatorToken.kind)
  );
}

/**
 * Class fields and methods. A quoted name survives renaming verbatim, so it is
 * string-defined; a bare one renames with its dot reads.
 */
function collectClassMemberDefinitions(
  node: ts.ClassLikeDeclaration,
  hazards: RuntimeRenameHazards,
) {
  for (const member of node.members) {
    const { name } = member;
    if (!name) {
      continue;
    }
    if (ts.isIdentifier(name)) {
      addMember(hazards.dotDefined, name.text);
      continue;
    }
    addMember(hazards.stringDefined, getDeclarationStringName(name));
  }
}

/**
 * Object-literal keys are dot-definitions: generous here is safe, because the
 * set only ever matters intersected with a literal string read of the same
 * name — which is exactly the hazard.
 *
 * The same pass records self-referential keys (see `selfReferentialKeys`):
 * identifier keys of this literal that a sibling property names with a plain
 * string-literal value.
 */
function collectObjectLiteralDefinitions(
  node: ts.ObjectLiteralExpression,
  hazards: RuntimeRenameHazards,
) {
  const identifierKeys = new Set<string>();
  const stringValues = new Set<string>();
  for (const property of node.properties) {
    const { name } = property;
    if (!name) {
      continue;
    }
    if (ts.isIdentifier(name)) {
      addMember(hazards.dotDefined, name.text);
      identifierKeys.add(name.text);
    } else {
      addMember(hazards.stringDefined, getDeclarationStringName(name));
    }
    const value = siblingStringValue(property);
    if (value !== null) {
      stringValues.add(value);
    }
  }
  for (const value of stringValues) {
    if (identifierKeys.has(value)) {
      addMember(hazards.selfReferentialKeys, value);
    }
  }
}

/**
 * The plain string-literal value of `key: "text"`, or null.
 *
 * Only a direct property assignment with a bare string literal qualifies.
 * Shorthand, spread, accessors, methods and template substitutions carry no
 * key-naming evidence, and admitting expressions would turn every literal
 * holding a message string into a pin.
 */
function siblingStringValue(property: ts.ObjectLiteralElementLike) {
  if (!ts.isPropertyAssignment(property)) {
    return null;
  }
  const { initializer } = property;
  return ts.isStringLiteral(initializer) ||
    ts.isNoSubstitutionTemplateLiteral(initializer)
    ? initializer.text
    : null;
}

/** Quoted member name of a class member or object-literal property. */
function getDeclarationStringName(name: ts.PropertyName) {
  return ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)
    ? name.text
    : null;
}

function collectProtocolHelperMembers(
  node: ts.CallExpression,
  hazards: RuntimeRenameHazards,
  protocolHelpers: RuntimeProtocolHelpers,
) {
  const signature = getProtocolHelperCallSignature(node, protocolHelpers);
  if (!signature) {
    return;
  }

  if (signature.kind === "direct-key-read") {
    addMember(
      hazards.protocolMembers,
      getStringLiteralMemberName(node.arguments[1]),
    );
    return;
  }

  const memberList = node.arguments[1];
  if (!memberList || !ts.isArrayLiteralExpression(memberList)) {
    return;
  }
  for (const element of memberList.elements) {
    if (
      !ts.isStringLiteral(element) &&
      !ts.isNoSubstitutionTemplateLiteral(element)
    ) {
      continue;
    }
    addMember(hazards.protocolMembers, element.text);
  }
}

type ProtocolHelperCallSignature =
  | {
      kind: "direct-key-read";
    }
  | {
      kind: "key-exclusion-list";
    };

function getProtocolHelperCallSignature(
  node: ts.CallExpression,
  protocolHelpers: RuntimeProtocolHelpers,
): ProtocolHelperCallSignature | null {
  if (node.arguments.length < 2) {
    return null;
  }

  const calleeName = getProtocolHelperCalleeName(node.expression);
  if (!calleeName) {
    return null;
  }

  if (protocolHelpers.keyReadCallees.includes(calleeName)) {
    return { kind: "direct-key-read" };
  }
  if (protocolHelpers.keyExclusionListCallees.includes(calleeName)) {
    return { kind: "key-exclusion-list" };
  }
  return null;
}

function getProtocolHelperCalleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    return getStringLiteralMemberName(expression.argumentExpression);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return getProtocolHelperCalleeName(expression.expression);
  }
  return null;
}

function collectKnownConstructorBindings(sourceFile: ts.SourceFile) {
  const knownConstructors = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name
    ) {
      knownConstructors.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isClassExpression(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        ts.isArrowFunction(node.initializer))
    ) {
      knownConstructors.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}

function collectRuntimeAssignmentMembers(
  target: ts.Expression,
  knownConstructors: Set<string>,
  hazards: RuntimeRenameHazards,
) {
  if (ts.isPropertyAccessExpression(target)) {
    if (isRelevantRuntimeTarget(target.expression, knownConstructors)) {
      addMember(hazards.dotDefined, target.name.text);
    }
    return;
  }

  if (ts.isElementAccessExpression(target)) {
    if (isRelevantRuntimeTarget(target.expression, knownConstructors)) {
      addMember(
        hazards.stringDefined,
        getStringLiteralMemberName(target.argumentExpression),
      );
    }
  }
}

function collectRuntimeCallMembers(
  node: ts.CallExpression,
  knownConstructors: Set<string>,
  provenFieldHelpers: ReadonlySet<string>,
  hazards: RuntimeRenameHazards,
) {
  const callee = node.expression;
  const [target, memberExpression] = node.arguments;
  if (target === undefined || memberExpression === undefined) {
    return;
  }

  if (
    isKnownConstructorExpression(target, knownConstructors) &&
    ts.isArrayLiteralExpression(memberExpression)
  ) {
    collectClassDescriptorMembers(memberExpression, hazards);
  }

  if (isFieldHelperCall(callee, provenFieldHelpers)) {
    if (isRelevantRuntimeTarget(target, knownConstructors)) {
      addMember(
        hazards.stringDefined,
        getStringLiteralMemberName(memberExpression),
      );
    }
    return;
  }

  if (!isObjectDefinePropertyCall(callee)) {
    return;
  }
  if (isRelevantRuntimeTarget(target, knownConstructors)) {
    addMember(
      hazards.stringDefined,
      getStringLiteralMemberName(memberExpression),
    );
  }
}

function collectClassDescriptorMembers(
  descriptors: ts.ArrayLiteralExpression,
  hazards: RuntimeRenameHazards,
) {
  for (const element of descriptors.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    let memberName: string | null = null;
    let hasFunctionBody = false;
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const propertyName = getDeclarationStringName(property.name);
      const identifierName = ts.isIdentifier(property.name)
        ? property.name.text
        : propertyName;
      if (identifierName === "key") {
        memberName = getStringLiteralMemberName(property.initializer);
      } else if (
        (identifierName === "value" ||
          identifierName === "get" ||
          identifierName === "set") &&
        (ts.isFunctionExpression(property.initializer) ||
          ts.isArrowFunction(property.initializer))
      ) {
        hasFunctionBody = true;
      }
    }
    if (hasFunctionBody) {
      addMember(hazards.stringDefined, memberName);
    }
  }
}

/**
 * Callees that define a field under a *string* key.
 *
 * Two toolchains, one hazard. esbuild lowers class fields to
 * `__publicField(this, "x", v)`; Babel lowers them to
 * `_defineProperty(this, "x", v)`, and bundler interop spells the same helper
 * `_defineProperty2.default(...)`. Either way the key survives renaming
 * verbatim while every `this.x` read of it renames, which is the
 * `stringDefined ∩ dotAccessed` hazard.
 *
 * Trailing digits are accepted because bundlers suffix duplicate helper
 * bindings (`__publicField2`, `_defineProperty3`) when they merge modules.
 */
function isFieldHelperName(name: string) {
  return (
    name.startsWith("__publicField") || /^_+defineProperty\d*$/u.test(name)
  );
}

function isFieldHelperCall(
  expression: ts.Expression,
  provenFieldHelpers: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expression)) {
    return (
      isFieldHelperName(expression.text) ||
      provenFieldHelpers.has(expression.text)
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    // `ns.__publicField(...)`, and Babel's CJS interop `_defineProperty2.default(...)`.
    return (
      isFieldHelperName(expression.name.text) ||
      (expression.name.text === "default" &&
        ts.isIdentifier(expression.expression) &&
        isFieldHelperName(expression.expression.text))
    );
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isFieldHelperCall(expression.expression, provenFieldHelpers);
  }
  return false;
}

/**
 * Local functions that *are* a field-definition helper, whatever they are called.
 *
 * A published bundle often ships the Babel helper already minified, so the
 * name carries no signal: `@wecom/jssdk` emits `J(this, "url", void 0)` beside
 * `this.url = …`, and a name-matching rule cannot see it. The body can:
 *
 * ```js
 * function J(e, t, n) {                                  // wecom.prod.js:141
 *   return t in e ? Object.defineProperty(e, t, { value: n, … }) : e[t] = n, e;
 * }
 * ```
 *
 * Requiring three parameters, a single declaration of the name, and a body
 * that writes `param0[param1]` — by element assignment or through
 * `Object.defineProperty` — keeps this a proof rather than an arity guess.
 * Shape alone would be far too loose: `fn.call(this, "name", value)` and
 * `store.set(this, "key", value)` have the same three arguments and define no
 * field at all.
 */
function collectProvenFieldHelperNames(sourceFile: ts.SourceFile) {
  const proven = new Set<string>();
  const declarationCounts = new Map<string, number>();

  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      node.parameters.length === 3
    ) {
      const helperName = node.name.text;
      declarationCounts.set(
        helperName,
        (declarationCounts.get(helperName) ?? 0) + 1,
      );
      const [targetName, keyName] = node.parameters.map((parameter) =>
        ts.isIdentifier(parameter.name) ? parameter.name.text : undefined,
      );
      if (
        targetName !== undefined &&
        keyName !== undefined &&
        writesParameterKeyedField(node.body, targetName, keyName)
      ) {
        proven.add(helperName);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const helperName of [...proven]) {
    if (declarationCounts.get(helperName) !== 1) {
      proven.delete(helperName);
    }
  }
  return proven;
}

/** True when `body` writes `target[key]` for the two named parameters. */
function writesParameterKeyedField(
  body: ts.Node,
  targetName: string,
  keyName: string,
) {
  let found = false;
  const namesParameters = (
    targetExpression: ts.Expression | undefined,
    keyExpression: ts.Expression | undefined,
  ) =>
    targetExpression !== undefined &&
    keyExpression !== undefined &&
    ts.isIdentifier(targetExpression) &&
    targetExpression.text === targetName &&
    ts.isIdentifier(keyExpression) &&
    keyExpression.text === keyName;

  const visit = (node: ts.Node) => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      namesParameters(node.left.expression, node.left.argumentExpression)
    ) {
      found = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      isObjectDefinePropertyCall(node.expression) &&
      namesParameters(node.arguments[0], node.arguments[1])
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function isRelevantRuntimeTarget(
  expression: ts.Expression,
  knownConstructors: Set<string>,
) {
  return (
    isThisOrSuperExpression(expression) ||
    isKnownPrototypeExpression(expression, knownConstructors) ||
    isKnownConstructorExpression(expression, knownConstructors)
  );
}
