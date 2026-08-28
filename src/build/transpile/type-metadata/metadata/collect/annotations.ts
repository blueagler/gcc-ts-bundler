import ts from "@typescript/typescript6";

import { hasModifier } from "../../../../../shared/typescript";
import {
  buildClassMemberDoc,
  buildClassJsDoc,
  buildFunctionLikeDoc,
  buildFunctionJsDoc,
  buildObjectMemberDoc,
  buildVariableJsDoc,
  getClassMemberName,
  getObjectPropertyName,
} from "../docs";
import {
  createClosureDocRenderContext,
  referencesForTemplate,
} from "../type-render/index";
import type { ClosureAnnotation } from "../../types";
import type { ClosureIrFileFeatures } from "../scan";

export function collectClosureDocsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  features: ClosureIrFileFeatures,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
) {
  const annotations: ClosureAnnotation[] = [];
  const pushAnnotation = (
    template: string,
    target: ClosureAnnotation["target"],
  ) => {
    annotations.push({
      references: referencesForTemplate(template, renderContext),
      target,
      template,
      typeBearing: hasTypeBearingTag(template),
    });
  };
  const shouldAnnotateJs =
    !features.docEligibility.isTypeScriptLike &&
    features.docEligibility.hasJsDocText;
  const shouldAnnotateTypeScript = features.docEligibility.isTypeScriptLike;

  const annotateFunctionDeclaration = (
    node: ts.FunctionDeclaration,
    name: ts.Identifier,
  ) => {
    if (!shouldAnnotateTypeScript && !shouldAnnotateJs) {
      return;
    }
    const jsdoc = buildFunctionJsDoc(node, checker, renderContext);
    if (jsdoc) {
      pushAnnotation(jsdoc, {
        bindingName: name.text,
        kind: "binding",
      });
    }
  };

  const annotateObjectLiteralMembers = (
    objectLiteral: ts.ObjectLiteralExpression,
    ownerBindingName: string,
  ) => {
    for (const member of objectLiteral.properties) {
      const memberName = getObjectPropertyName(member);
      if (!memberName) {
        continue;
      }
      const memberDoc = buildObjectMemberDoc({
        checker,
        context: renderContext,
        member,
      });
      if (memberDoc) {
        pushAnnotation(memberDoc, {
          kind: "member",
          memberKind: objectMemberKind(member),
          memberName,
          ownerBindingName,
          static: false,
        });
      }
    }
  };

  const annotateVariableDeclaration = (
    node: ts.VariableDeclaration,
    name: ts.Identifier,
  ) => {
    if (!shouldAnnotateTypeScript && !shouldAnnotateJs) {
      return;
    }
    const jsdoc = buildVariableJsDoc({
      checker,
      context: renderContext,
      initializer: node.initializer,
      typeNode: node.type,
    });
    if (jsdoc) {
      pushAnnotation(jsdoc, {
        bindingName: name.text,
        kind: "binding",
      });
    }
    if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      annotateObjectLiteralMembers(node.initializer, name.text);
    }
  };

  const annotateClassDeclaration = (
    node: ts.ClassDeclaration,
    name: ts.Identifier,
  ) => {
    const className = name.text;
    const jsdoc = ensureClassConstructorStruct(
      buildClassJsDoc(node, checker, renderContext),
    );
    pushAnnotation(jsdoc, {
      bindingName: className,
      kind: "binding",
    });

    for (const member of node.members) {
      const memberName = getClassMemberName(member);
      if (!memberName) {
        continue;
      }
      const memberDoc = buildClassMemberDoc({
        checker,
        context: renderContext,
        member,
      });
      if (memberDoc) {
        pushAnnotation(memberDoc, {
          kind: "member",
          memberKind: classMemberKind(member),
          memberName,
          ownerBindingName: className,
          static: hasModifier(member, ts.SyntaxKind.StaticKeyword),
        });
      }
    }
  };

  const annotateStandaloneMethodOrAccessor = (
    node:
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
  ) => {
    if (!ts.isIdentifier(node.name)) {
      return;
    }
    const jsdoc = buildFunctionLikeDoc(node, checker, renderContext);
    if (jsdoc) {
      pushAnnotation(jsdoc, { bindingName: node.name.text, kind: "binding" });
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      annotateFunctionDeclaration(node, node.name);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      annotateVariableDeclaration(node, node.name);
    } else if (ts.isClassDeclaration(node) && node.name) {
      annotateClassDeclaration(node, node.name);
    } else if (isStandaloneMethodOrAccessor(node) && shouldAnnotateTypeScript) {
      annotateStandaloneMethodOrAccessor(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return annotations;
}

/** Method or accessor whose owner is not a class body or object literal. */
function isStandaloneMethodOrAccessor(
  node: ts.Node,
): node is
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration {
  return (
    (ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    !ts.isClassDeclaration(node.parent) &&
    !ts.isClassExpression(node.parent) &&
    !ts.isObjectLiteralExpression(node.parent)
  );
}

function objectMemberKind(
  member: ts.ObjectLiteralElementLike,
): Extract<ClosureAnnotation["target"], { kind: "member" }>["memberKind"] {
  if (ts.isGetAccessorDeclaration(member)) return "getter";
  if (ts.isSetAccessorDeclaration(member)) return "setter";
  if (ts.isMethodDeclaration(member)) return "method";
  return "field";
}

function classMemberKind(
  member: ts.ClassElement,
): Extract<ClosureAnnotation["target"], { kind: "member" }>["memberKind"] {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  if (ts.isGetAccessorDeclaration(member)) return "getter";
  if (ts.isSetAccessorDeclaration(member)) return "setter";
  if (ts.isPropertyDeclaration(member)) return "field";
  return "method";
}

function ensureClassConstructorStruct(jsdoc: string | null) {
  const required = [" * @constructor", " * @struct"];
  if (!jsdoc) {
    return `/**\n${required.join("\n")}\n */\n`;
  }
  const missing = required.filter((tag) => !jsdoc.includes(tag));
  if (missing.length === 0) {
    return jsdoc;
  }
  return jsdoc.replace("/**\n", `/**\n${missing.join("\n")}\n`);
}

function hasTypeBearingTag(template: string) {
  return /@(constructor|enum|extends|implements|param|return|template|this|type|typedef)\b/u.test(
    template,
  );
}
