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

export interface RuntimeRenameHazards {
  accessedMembers: Set<string>;
  definedMembers: Set<string>;
  protocolMembers: Set<string>;
}

export async function analyzeRuntimeUsage(runtimeEntryFiles: string[]) {
  const hazards: RuntimeRenameHazards = {
    accessedMembers: new Set(),
    definedMembers: new Set(),
    protocolMembers: new Set(),
  };

  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts.createSourceFile(
      runtimeEntryFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      getScriptKindForFile(runtimeEntryFile),
    );
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        if (
          isRelevantRuntimeTarget(node.expression, knownConstructors) &&
          isRuntimeExternPropertyName(node.name.text)
        ) {
          hazards.accessedMembers.add(node.name.text);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, hazards);
      } else if (ts.isCallExpression(node)) {
        collectProtocolHelperMembers(node, hazards);
        collectRuntimeCallMembers(node, knownConstructors, hazards);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return hazards;
}

function collectProtocolHelperMembers(
  node: ts.CallExpression,
  hazards: RuntimeRenameHazards,
) {
  const signature = getProtocolHelperCallSignature(node);
  if (!signature) {
    return;
  }

  if (signature.kind === "direct-key-read") {
    const memberName = getStringLiteralMemberName(node.arguments[1]);
    if (memberName && isRuntimeExternPropertyName(memberName)) {
      hazards.protocolMembers.add(memberName);
    }
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
    if (isRuntimeExternPropertyName(element.text)) {
      hazards.protocolMembers.add(element.text);
    }
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
): ProtocolHelperCallSignature | null {
  if (node.arguments.length < 2) {
    return null;
  }

  const calleeName = getProtocolHelperCalleeName(node.expression);
  if (!calleeName) {
    return null;
  }

  switch (calleeName) {
    case "prop":
      return { kind: "direct-key-read" };
    case "rest_props":
    case "legacy_rest_props":
      return { kind: "key-exclusion-list" };
    default:
      return null;
  }
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
      if (isRuntimeExternPropertyName(target.name.text)) {
        hazards.definedMembers.add(target.name.text);
      }
    }
    return;
  }

  if (ts.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (
      memberName &&
      isRelevantRuntimeTarget(target.expression, knownConstructors) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      hazards.definedMembers.add(memberName);
    }
  }
}

function collectRuntimeCallMembers(
  node: ts.CallExpression,
  knownConstructors: Set<string>,
  hazards: RuntimeRenameHazards,
) {
  const callee = node.expression;
  if (isPublicFieldHelperCall(callee) && node.arguments.length >= 2) {
    const memberName = getStringLiteralMemberName(node.arguments[1]);
    if (
      memberName &&
      isRelevantRuntimeTarget(node.arguments[0], knownConstructors) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      hazards.definedMembers.add(memberName);
    }
    return;
  }

  if (!isObjectDefinePropertyCall(callee) || node.arguments.length < 2) {
    return;
  }

  const memberName = getStringLiteralMemberName(node.arguments[1]);
  if (!memberName || !isRuntimeExternPropertyName(memberName)) {
    return;
  }
  const target = node.arguments[0];
  if (isRelevantRuntimeTarget(target, knownConstructors)) {
    hazards.definedMembers.add(memberName);
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
  expression: ts.Node,
  knownConstructors: Set<string>,
) {
  return (
    isThisOrSuperExpression(expression) ||
    isKnownPrototypeExpression(
      expression as ts.Expression,
      knownConstructors,
    ) ||
    isKnownConstructorExpression(expression as ts.Expression, knownConstructors)
  );
}
