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
  /** `o.x` read anywhere. */
  dotAccessed: Set<string>;
  /** `this.x = v`, class members, object-literal keys. */
  dotDefined: Set<string>;
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
   * Hyphenated keys also record their camelCase alias: framework prop
   * systems bridge quoted kebab-case pass sites to camelCase declaration
   * keys via `camelize`, so the camelCase side must not rename either.
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
    dotAccessed: new Set(),
    dotDefined: new Set(),
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
    mergeHazardSet(merged.dotAccessed, hazards.dotAccessed);
    mergeHazardSet(merged.dotDefined, hazards.dotDefined);
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
  collectLiteralIndexedKeyReaders(sourceFile, hazards);
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
      collectRuntimeCallMembers(node, knownConstructors, hazards);
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
    // Prop systems bridge quoted kebab-case pass sites ("click-count") to
    // camelCase declaration keys via camelize, so a hyphenated string
    // definition means the camelCase member must not rename either.
    if (memberName.includes("-")) {
      const camelized = memberName.replace(/-(\w)/gu, (_, letter: string) =>
        letter.toUpperCase(),
      );
      if (isRuntimeExternPropertyName(camelized)) {
        target.add(camelized);
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

  if (isPublicFieldHelperCall(callee)) {
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

function isPublicFieldHelperCall(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text.startsWith("__publicField");
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text.startsWith("__publicField");
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isPublicFieldHelperCall(expression.expression);
  }
  return false;
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
