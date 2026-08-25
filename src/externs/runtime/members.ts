import ts from "@typescript/typescript6";

import {
  getStringLiteralMemberName,
  isKnownConstructorExpression,
  isKnownPrototypeExpression,
  isObjectDefinePropertyCall,
  isThisOrSuperExpression,
} from "../shared";
import {
  addMember,
  type RuntimeProtocolHelpers,
  type RuntimeRenameHazards,
} from "./types";

/**
 * Class fields and methods. A quoted name survives renaming verbatim, so it is
 * string-defined; a bare one renames with its dot reads.
 */
export function collectClassMemberDefinitions(
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
export function collectObjectLiteralDefinitions(
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

export function collectProtocolHelperMembers(
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

export function collectKnownConstructorBindings(sourceFile: ts.SourceFile) {
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

export function collectRuntimeAssignmentMembers(
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

export function collectRuntimeCallMembers(
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
    const memberName = getStringLiteralMemberName(memberExpression);
    if (
      target.kind === ts.SyntaxKind.ThisKeyword &&
      isJsIdentifierMemberName(memberName) &&
      isNamedFieldHelperCall(callee)
    ) {
      addMember(hazards.dotDefined, memberName);
    } else if (isRelevantRuntimeTarget(target, knownConstructors)) {
      addMember(hazards.stringDefined, memberName);
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
 * esbuild lowers class fields to `__publicField(this, "x", v)`; Babel lowers
 * them to `_defineProperty(this, "x", v)` / `babelHelpers.defineProperty`.
 * Identifier keys on `this` are rewritten to `this.x = v` before Closure, so
 * those are `dotDefined`. Non-identifier keys and minified proven helpers
 * stay string-defined.
 *
 * Trailing digits are accepted because bundlers suffix duplicate helper
 * bindings (`__publicField2`, `_defineProperty3`) when they merge modules.
 */
function isFieldHelperName(name: string) {
  return (
    name.startsWith("__publicField") || /^_+defineProperty\d*$/u.test(name)
  );
}

function isNamedFieldHelperCall(expression: ts.Expression): boolean {
  if (isFieldHelperCall(expression, new Set())) {
    return true;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return isNamedFieldHelperCall(expression.expression);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "defineProperty" &&
    ts.isIdentifier(expression.expression) &&
    (expression.expression.text === "babelHelpers" ||
      expression.expression.text.startsWith("babelHelpers$$"))
  );
}

function isJsIdentifierMemberName(name: string | null): name is string {
  return name !== null && /^[A-Za-z_$][\w$]*$/u.test(name);
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
export function collectProvenFieldHelperNames(sourceFile: ts.SourceFile) {
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
