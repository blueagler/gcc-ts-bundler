import fs from "fs";
import ts from "typescript";

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
  /** `o.x` read anywhere. */
  dotAccessed: Set<string>;
  /** `this.x = v`, class members, object-literal keys. */
  dotDefined: Set<string>;
  protocolMembers: Set<string>;
  /** `__publicField(this, "x")`, `defineProperty`, `this["x"] =`, `"x" = v`. */
  stringDefined: Set<string>;
  /** `o["x"]` read or `"x" in o`. */
  stringLiteralRead: Set<string>;
}

export interface RuntimeProtocolHelpers {
  keyExclusionListCallees: string[];
  keyReadCallees: string[];
}

export function createEmptyRuntimeHazards(): RuntimeRenameHazards {
  return {
    dotAccessed: new Set(),
    dotDefined: new Set(),
    protocolMembers: new Set(),
    stringDefined: new Set(),
    stringLiteralRead: new Set(),
  };
}

export function mergeRuntimeHazards(
  ...hazardsList: readonly RuntimeRenameHazards[]
): RuntimeRenameHazards {
  const merged = createEmptyRuntimeHazards();
  for (const hazards of hazardsList) {
    for (const key of RUNTIME_HAZARD_KEYS) {
      for (const member of hazards[key]) {
        merged[key].add(member);
      }
    }
  }
  return merged;
}

export const RUNTIME_HAZARD_KEYS = [
  "dotAccessed",
  "dotDefined",
  "protocolMembers",
  "stringDefined",
  "stringLiteralRead",
] as const satisfies ReadonlyArray<keyof RuntimeRenameHazards>;

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
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      addMember(hazards.dotAccessed, node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      if (!isAssignmentTarget(node)) {
        addMember(
          hazards.stringLiteralRead,
          getStringLiteralMemberName(node.argumentExpression),
        );
      }
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

function addMember(target: Set<string>, memberName: string | null | undefined) {
  if (memberName && isRuntimeExternPropertyName(memberName)) {
    target.add(memberName);
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
 */
function collectObjectLiteralDefinitions(
  node: ts.ObjectLiteralExpression,
  hazards: RuntimeRenameHazards,
) {
  for (const property of node.properties) {
    const { name } = property;
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
