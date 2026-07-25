import ts from "typescript";

import { firstOrUndefined } from "../../../../shared/arrays";
import { uniqueSortedStrings } from "../../../../shared/files";
import {
  mergeClosureTypes,
  renderPrototypeProperty,
  sanitizeClosureName,
  stripUndefinedFromClosureType,
} from "./closure-type-strings";
import { getPropertyNameText, hasExportModifier } from "./modifiers";
import {
  buildRecordForObjectType,
  collectSignatureParamInfos,
  getTypedDeclarationClosureType,
  isWorthAnnotatingVariableType,
  signatureToClosureFunctionType,
  toClosureHeritageType,
  toClosureType,
} from "./type-render";
import type {
  ClosureDocRenderContext,
  FunctionLikeDeclaration,
  SignatureParamInfo,
} from "./type-render";

import type {
  ClosureIrTypeDeclaration,
  FunctionObjectParamRecord,
} from "../types";
type JsDocTagInput = {
  name?: string | undefined;
  text?: string | undefined;
  type?: string | undefined;
};


type ResolvedSignature = {
  declaration: FunctionLikeDeclaration;
  signature: ts.Signature;
};


const CONFLICTING_GENERATED_TAGS = new Set([
  "argument",
  "constructor",
  "extends",
  "implements",
  "param",
  "return",
  "template",
  "this",
  "type",
  "typedef",
]);


export function buildInterfaceDeclarationSnippet(
  statement: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): ClosureIrTypeDeclaration {
  const name = statement.name.text;
  context.usedRecordNames.add(name);
  const lines: string[] = ["/**"];
  lines.push(" * @record");
  appendTemplateTags(lines, statement.typeParameters);
  lines.push(" */");
  lines.push(`function ${name}() {}`);

  appendInterfaceMembers(lines, name, statement.members, checker, context);

  if (hasExportModifier(statement)) {
    lines.push(`exports.${name} = ${name};`);
  }

  return {
    snippet: `${lines.join("\n")}\n`,
  };
}


export function buildTypeAliasDeclarationSnippet(
  statement: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): ClosureIrTypeDeclaration {
  if (ts.isTypeLiteralNode(statement.type)) {
    const name = statement.name.text;
    context.usedRecordNames.add(name);
    const lines: string[] = ["/**"];
    lines.push(" * @record");
    appendTemplateTags(lines, statement.typeParameters);
    lines.push(" */");
    lines.push(`function ${name}() {}`);
    appendInterfaceMembers(lines, name, statement.type.members, checker, context);
    if (hasExportModifier(statement)) {
      lines.push(`exports.${name} = ${name};`);
    }
    return {
      snippet: `${lines.join("\n")}\n`,
    };
  }

  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker, context);
  const lines: string[] = ["/**"];
  appendTemplateTags(lines, statement.typeParameters);
  lines.push(` * @typedef {${closureType}}`);
  lines.push(" */");
  lines.push(`let ${statement.name.text};`);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join("\n")}\n`,
  };
}


export function buildFunctionJsDoc(
  statement: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
  firstParamObjectRecordTypeName?: string | undefined,
) {
  if (!statement.body) {
    return null;
  }
  const declarations = collectFunctionOverloadDeclarations(statement);
  return buildSignaturesJsDoc({
    checker,
    context,
    declarations,
    firstParamObjectRecordTypeName,
  });
}


export function buildFunctionObjectParamRecord(
  statement: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
): FunctionObjectParamRecord | null {
  const firstParameter = statement.parameters[0];
  if (
    statement.name === undefined ||
    firstParameter === undefined ||
    !ts.isObjectBindingPattern(firstParameter.name) ||
    hasRestElement(firstParameter.name)
  ) {
    return null;
  }

  const parameterType = checker.getTypeAtLocation(firstParameter);
  const recordTypeName = buildRecordForObjectType({
    checker,
    context,
    preferredName: `${statement.name.text}$Param0`,
    type: parameterType,
  });
  if (!recordTypeName) {
    return null;
  }

  return {
    snippet: "",
    typeName: recordTypeName,
  };
}


export function buildClassJsDoc(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const typeParameters = statement.typeParameters ?? [];
  const tags = [
    ...collectPreservedJsDocTags(statement),
    ...templateTags(typeParameters),
  ];
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureHeritageType(typeNode, checker, context);
        if (!closureType) {
          continue;
        }
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          tags.push({ name: "extends", type: closureType });
        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          tags.push({ name: "implements", type: closureType });
        }
      }
    }
  }
  return tags.length > 0 ? renderJsDoc(tags) : null;
}


export function buildFunctionLikeDoc(
  declaration: FunctionLikeDeclaration,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  if (isBodylessFunctionLikeDeclaration(declaration)) {
    return null;
  }
  const declarations = collectOverloadDeclarations(declaration);
  return buildSignaturesJsDoc({ checker, context, declarations });
}


export function buildVariableJsDoc({
  checker,
  context,
  initializer,
  typeNode,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  initializer?: ts.Expression | undefined;
  typeNode?: ts.TypeNode | undefined;
}) {
  if (
    initializer &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  ) {
    return buildFunctionLikeDoc(initializer, checker, context);
  }

  const type = typeNode
    ? checker.getTypeFromTypeNode(typeNode)
    : initializer
      ? checker.getTypeAtLocation(initializer)
      : null;
  if (!type || !isWorthAnnotatingVariableType(type, checker)) {
    return null;
  }

  return buildTypeJsDoc(toClosureType(type, checker, context));
}


export function buildClassMemberDoc({
  checker,
  context,
  member,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  member: ts.ClassElement;
}) {
  if (
    ts.isConstructorDeclaration(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return buildFunctionLikeDoc(member, checker, context);
  }

  if (!ts.isPropertyDeclaration(member) || !member.type) {
    return null;
  }
  return buildTypeJsDoc(getTypedDeclarationClosureType(member, checker, context));
}


export function buildObjectMemberDoc({
  checker,
  context,
  member,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  member: ts.ObjectLiteralElementLike;
}) {
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    return buildFunctionLikeDoc(member, checker, context);
  }

  if (
    ts.isPropertyAssignment(member) &&
    (ts.isArrowFunction(member.initializer) ||
      ts.isFunctionExpression(member.initializer))
  ) {
    return buildFunctionLikeDoc(member.initializer, checker, context);
  }

  if (ts.isPropertyAssignment(member)) {
    const type = checker.getTypeAtLocation(member.initializer);
    return isWorthAnnotatingVariableType(type, checker)
      ? buildTypeJsDoc(toClosureType(type, checker, context))
      : null;
  }

  return null;
}


function buildSignaturesJsDoc({
  checker,
  context,
  declarations,
  firstParamObjectRecordTypeName,
}: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  declarations: FunctionLikeDeclaration[];
  firstParamObjectRecordTypeName?: string | undefined;
}) {
  const signatures = resolveSignatures(declarations, checker);
  const implementation = declarations.at(-1);
  if (signatures.length === 0 || implementation === undefined) {
    return null;
  }

  const tags: JsDocTagInput[] = [
    ...collectPreservedJsDocTags(implementation),
    ...uniqueTemplateTags(declarations),
  ];
  const signatureParams = signatures.map(({ declaration }) =>
    collectSignatureParamInfos({
      checker,
      context,
      declaration,
      firstParamObjectRecordTypeName,
    }),
  );
  appendThisTag(tags, signatureParams);
  appendParameterTags(tags, signatureParams);
  appendReturnTag({
    checker,
    context,
    implementation,
    signatures,
    tags,
  });
  return renderJsDoc(tags);
}


function resolveSignatures(
  declarations: FunctionLikeDeclaration[],
  checker: ts.TypeChecker,
): ResolvedSignature[] {
  return declarations
    .map((declaration) => ({
      declaration,
      signature: checker.getSignatureFromDeclaration(declaration),
    }))
    .filter((entry): entry is ResolvedSignature => entry.signature !== undefined);
}


function appendThisTag(
  tags: JsDocTagInput[],
  signatureParams: SignatureParamInfo[][],
) {
  const thisTypes = uniqueSortedStrings(
    signatureParams
      .flatMap((params) => params.filter((param) => param.thisParam))
      .map((param) => param.type),
  );
  if (thisTypes.length > 0) {
    tags.push({ name: "this", type: mergeClosureTypes(thisTypes) });
  }
}


function appendParameterTags(
  tags: JsDocTagInput[],
  signatureParams: SignatureParamInfo[][],
) {
  const realParams = signatureParams.map((params) =>
    params.filter((param) => !param.thisParam),
  );
  const maxParamCount = Math.max(0, ...realParams.map((params) => params.length));
  const minParamCount = Math.min(
    ...realParams.map((params) => params.filter((param) => !param.rest).length),
  );
  let foundOptional = false;
  for (let index = 0; index < maxParamCount; index += 1) {
    const parameter = buildParameterTag({
      foundOptional,
      index,
      minParamCount,
      realParams,
    });
    if (!parameter) {
      continue;
    }
    tags.push(parameter.tag);
    foundOptional ||= parameter.optional;
    if (parameter.rest) {
      break;
    }
  }
}


function buildParameterTag(input: {
  foundOptional: boolean;
  index: number;
  minParamCount: number;
  realParams: SignatureParamInfo[][];
}): { optional: boolean; rest: boolean; tag: JsDocTagInput } | null {
  const candidates = input.realParams
    .map((params) => params[input.index])
    .filter((param): param is SignatureParamInfo => param !== undefined);
  const first = firstOrUndefined(candidates);
  if (first === undefined) {
    return null;
  }
  const rest = candidates.some((param) => param.rest);
  const optional =
    !rest &&
    (input.foundOptional ||
      input.index >= input.minParamCount ||
      candidates.some((param) => param.optional));
  const mergedType = mergeClosureTypes(
    candidates.map((param) =>
      optional ? stripUndefinedFromClosureType(param.type) : param.type,
    ),
  );
  return {
    optional,
    rest,
    tag: {
      name: "param",
      text: first.name,
      type: `${rest ? "..." : ""}${mergedType}${optional ? "=" : ""}`,
    },
  };
}


function appendReturnTag(input: {
  checker: ts.TypeChecker;
  context: ClosureDocRenderContext;
  implementation: FunctionLikeDeclaration;
  signatures: ResolvedSignature[];
  tags: JsDocTagInput[];
}) {
  if (
    input.signatures.some(({ declaration }) =>
      ts.isConstructorDeclaration(declaration),
    ) || isSetterDeclaration(input.implementation)
  ) {
    return;
  }
  input.tags.push({
    name: "return",
    type: mergeClosureTypes(
      input.signatures.map(({ signature }) =>
        toClosureType(
          input.checker.getReturnTypeOfSignature(signature),
          input.checker,
          input.context,
        ),
      ),
    ),
  });
}


function buildTypeJsDoc(closureType: string) {
  return renderJsDoc([{ name: "type", type: closureType }]);
}


function appendInterfaceMembers(
  lines: string[],
  typeName: string,
  members: ts.NodeArray<ts.TypeElement>,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  for (const member of members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      continue;
    }
    if (ts.isPropertySignature(member)) {
      const propertyType = getTypedDeclarationClosureType(
        member,
        checker,
        context,
      );
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(
        signature,
        checker,
        context,
      );
      lines.push(`/** @type {${functionType}} */`);
      lines.push(renderPrototypeProperty(typeName, memberName));
    }
  }
}


function collectFunctionOverloadDeclarations(
  implementation: ts.FunctionDeclaration,
): FunctionLikeDeclaration[] {
  if (!implementation.name || !implementation.body) {
    return [implementation];
  }
  if (
    !ts.isSourceFile(implementation.parent) &&
    !ts.isModuleBlock(implementation.parent)
  ) {
    return [implementation];
  }
  const declarations = implementation.parent.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === implementation.name?.text,
  );
  const implementationIndex = declarations.indexOf(implementation);
  return implementationIndex > 0
    ? declarations.slice(0, implementationIndex + 1)
    : [implementation];
}


function collectOverloadDeclarations(
  implementation: FunctionLikeDeclaration,
): FunctionLikeDeclaration[] {
  if (!hasFunctionBody(implementation)) {
    return [implementation];
  }
  if (ts.isFunctionDeclaration(implementation)) {
    return collectFunctionOverloadDeclarations(implementation);
  }
  if (
    ts.isMethodDeclaration(implementation) ||
    ts.isConstructorDeclaration(implementation)
  ) {
    const members = ts.isClassDeclaration(implementation.parent) ||
      ts.isClassExpression(implementation.parent)
      ? implementation.parent.members
      : undefined;
    if (!members) {
      return [implementation];
    }
    const implementationName = getClassMemberName(implementation);
    const candidates = members.filter(
      (member): member is ts.ConstructorDeclaration | ts.MethodDeclaration =>
        (ts.isMethodDeclaration(member) ||
          ts.isConstructorDeclaration(member)) &&
        getClassMemberName(member) === implementationName,
    );
    const implementationIndex = candidates.indexOf(implementation);
    return implementationIndex > 0
      ? candidates.slice(0, implementationIndex + 1)
      : [implementation];
  }
  return [implementation];
}


function hasFunctionBody(declaration: FunctionLikeDeclaration) {
  return "body" in declaration && !!declaration.body;
}


function isBodylessFunctionLikeDeclaration(declaration: FunctionLikeDeclaration) {
  return "body" in declaration && !declaration.body;
}


function collectPreservedJsDocTags(node: ts.Node): JsDocTagInput[] {
  const tags: JsDocTagInput[] = [];
  for (const tag of ts.getJSDocTags(node)) {
    const name = tag.tagName.text;
    if (CONFLICTING_GENERATED_TAGS.has(name)) {
      continue;
    }
    const text = jsDocCommentText(tag.comment);
    tags.push(text ? { name, text } : { name });
  }
  return tags;
}


function jsDocCommentText(
  comment: string | ts.NodeArray<ts.JSDocComment> | undefined,
) {
  if (!comment) {
    return "";
  }
  if (typeof comment === "string") {
    return comment.trim();
  }
  return comment.map((part) => part.getText()).join(" ").trim();
}


function uniqueTemplateTags(declarations: FunctionLikeDeclaration[]) {
  return uniqueSortedStrings(
    declarations.flatMap((declaration) =>
      getTemplateNames(getSignatureTypeParameters(declaration)),
    ),
  ).map((name) => ({ name: "template", text: name }));
}


function templateTags(
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  return getTemplateNames(typeParameters).map((name) => ({
    name: "template",
    text: name,
  }));
}


function renderJsDoc(tags: JsDocTagInput[]) {
  const lines = ["/**"];
  for (const tag of tags) {
    if (!tag.name) {
      continue;
    }
    if (tag.type && tag.text) {
      lines.push(` * @${tag.name} {${tag.type}} ${tag.text}`);
    } else if (tag.type) {
      lines.push(` * @${tag.name} {${tag.type}}`);
    } else if (tag.text) {
      lines.push(` * @${tag.name} ${tag.text}`);
    } else {
      lines.push(` * @${tag.name}`);
    }
  }
  lines.push(" */");
  return `${lines.join("\n")}\n`;
}


function getSignatureTypeParameters(declaration: FunctionLikeDeclaration) {
  return "typeParameters" in declaration ? declaration.typeParameters : undefined;
}


function appendTemplateTags(
  lines: string[],
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  for (const tag of templateTags(typeParameters)) {
    lines.push(` * @template ${tag.text}`);
  }
}


function getTemplateNames(
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  return (typeParameters ?? []).map((parameter) =>
    sanitizeClosureName(parameter.name.text),
  );
}


function hasRestElement(pattern: ts.ObjectBindingPattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}




export function getClassMemberName(member: ts.ClassElement) {
  if (ts.isConstructorDeclaration(member)) {
    return "constructor";
  }
  return getPropertyNameText(member.name);
}


export function getObjectPropertyName(member: ts.ObjectLiteralElementLike) {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member) ||
    ts.isShorthandPropertyAssignment(member)
  ) {
    return getPropertyNameText(member.name);
  }
  return null;
}


export function hasStaticModifier(node: ts.Node) {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword),
  );
}


function isSetterDeclaration(declaration: FunctionLikeDeclaration) {
  return ts.isSetAccessorDeclaration(declaration);
}
