import fs from "fs";
import ts from "typescript";

import {
  getPropertyNameText,
  getScriptKindForFile,
  getStringLiteralMemberName,
  isAssignmentOperator,
  isKnownConstructorExpression,
  isKnownPrototypeExpression,
  isObjectDefinePropertyCall,
  isRuntimeExternPropertyName,
  isThisOrSuperExpression,
} from "./shared";

export async function analyzeRuntimeUsage(runtimeEntryFiles: string[]) {
  const structuralMembers = new Set<string>();

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
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        for (const member of node.members) {
          if (
            ts.isPropertyDeclaration(member) ||
            ts.isGetAccessorDeclaration(member) ||
            ts.isSetAccessorDeclaration(member)
          ) {
            const memberName = getPropertyNameText(member.name);
            if (memberName && isRuntimeExternPropertyName(memberName)) {
              structuralMembers.add(memberName);
            }
          }
        }
      } else if (ts.isPropertyAccessExpression(node)) {
        if (
          isThisOrSuperExpression(node.expression) &&
          isRuntimeExternPropertyName(node.name.text)
        ) {
          structuralMembers.add(node.name.text);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const memberName = getStringLiteralMemberName(node.argumentExpression);
        if (
          memberName &&
          isThisOrSuperExpression(node.expression) &&
          isRuntimeExternPropertyName(memberName)
        ) {
          structuralMembers.add(memberName);
        }
      } else if (
        ts.isBinaryExpression(node) &&
        isAssignmentOperator(node.operatorToken.kind)
      ) {
        collectRuntimeAssignmentMembers(
          node.left,
          knownConstructors,
          structuralMembers,
        );
      } else if (ts.isCallExpression(node)) {
        collectRuntimeCallMembers(node, knownConstructors, structuralMembers);
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return structuralMembers;
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
  structuralMembers: Set<string>,
) {
  if (ts.isPropertyAccessExpression(target)) {
    if (
      isThisOrSuperExpression(target.expression) ||
      isKnownPrototypeExpression(target.expression, knownConstructors) ||
      isKnownConstructorExpression(target.expression, knownConstructors)
    ) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        structuralMembers.add(target.name.text);
      }
    }
    return;
  }

  if (ts.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (
      memberName &&
      (isThisOrSuperExpression(target.expression) ||
        isKnownPrototypeExpression(target.expression, knownConstructors) ||
        isKnownConstructorExpression(target.expression, knownConstructors)) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      structuralMembers.add(memberName);
    }
  }
}

function collectRuntimeCallMembers(
  node: ts.CallExpression,
  knownConstructors: Set<string>,
  structuralMembers: Set<string>,
) {
  const callee = node.expression;
  if (
    ts.isIdentifier(callee) &&
    callee.text === "__publicField" &&
    node.arguments.length >= 2
  ) {
    const memberName = getStringLiteralMemberName(node.arguments[1]);
    if (
      memberName &&
      (isThisOrSuperExpression(node.arguments[0]) ||
        isKnownConstructorExpression(node.arguments[0], knownConstructors)) &&
      isRuntimeExternPropertyName(memberName)
    ) {
      structuralMembers.add(memberName);
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
  if (
    isThisOrSuperExpression(target) ||
    isKnownConstructorExpression(target, knownConstructors) ||
    isKnownPrototypeExpression(target, knownConstructors)
  ) {
    structuralMembers.add(memberName);
  }
}
