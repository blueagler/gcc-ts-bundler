import ts from "typescript";

import { ClosureIrTypeDeclaration, FunctionObjectParamRecord } from "../types";

export function buildInterfaceDeclarationSnippet(
  statement: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
): ClosureIrTypeDeclaration {
  const lines: string[] = ["/**"];
  lines.push(" * @record");
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(" */");
  lines.push(`function ${statement.name.text}() {}`);

  for (const member of statement.members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      continue;
    }
    if (ts.isPropertySignature(member)) {
      const propertyType = member.type
        ? toClosureType(checker.getTypeFromTypeNode(member.type), checker)
        : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(
        `${statement.name.text}.prototype.${renderPropertyName(memberName)};`,
      );
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(signature, checker);
      lines.push(`/** @type {${functionType}} */`);
      lines.push(
        `${statement.name.text}.prototype.${renderPropertyName(memberName)};`,
      );
    }
  }

  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }

  return {
    snippet: `${lines.join("\n")}\n`,
  };
}

export function buildTypeAliasDeclarationSnippet(
  statement: ts.TypeAliasDeclaration,
  checker: ts.TypeChecker,
): ClosureIrTypeDeclaration {
  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker);
  const lines: string[] = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
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
  firstParamObjectRecordTypeName?: string,
) {
  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  for (const [index, parameter] of signature.getParameters().entries()) {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration
      ? checker.getTypeOfSymbolAtLocation(parameter, declaration)
      : checker.getTypeOfSymbol(parameter);
    const parameterName =
      index === 0 && firstParamObjectRecordTypeName
        ? "__props"
        : parameter.getName();
    const closureType =
      index === 0 && firstParamObjectRecordTypeName
        ? `!${firstParamObjectRecordTypeName}`
        : toClosureType(parameterType, checker);
    lines.push(` * @param {${closureType}} ${parameterName}`);
  }
  const returnType = checker.getReturnTypeOfSignature(signature);
  lines.push(` * @return {${toClosureType(returnType, checker)}}`);
  lines.push(" */");
  return `${lines.join("\n")}\n`;
}

export function buildFunctionObjectParamRecord(
  statement: ts.FunctionDeclaration,
  checker: ts.TypeChecker,
): FunctionObjectParamRecord | null {
  if (!isComponentLikeName(statement.name?.text)) {
    return null;
  }
  const firstParameter = statement.parameters[0];
  if (
    !firstParameter ||
    !ts.isObjectBindingPattern(firstParameter.name) ||
    hasRestElement(firstParameter.name)
  ) {
    return null;
  }

  const parameterType = checker.getTypeAtLocation(firstParameter);
  const properties = checker.getPropertiesOfType(parameterType);
  if (properties.length === 0) {
    return null;
  }

  const typeName = `${statement.name!.text}$Param0`;
  const lines = ["/**", " * @record", " */", `function ${typeName}() {}`];
  for (const property of properties) {
    const declaration =
      property.valueDeclaration ?? property.declarations?.[0] ?? firstParameter;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration,
    );
    lines.push(`/** @type {${toClosureType(propertyType, checker)}} */`);
    lines.push(
      `${typeName}.prototype.${renderPropertyName(property.getName())};`,
    );
  }
  return {
    snippet: `${lines.join("\n")}\n`,
    typeName,
  };
}

export function buildClassJsDoc(
  statement: ts.ClassDeclaration,
  checker: ts.TypeChecker,
) {
  const typeParameters = statement.typeParameters ?? [];
  const lines = ["/**"];
  for (const templateName of getTemplateNames(typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureType(
          checker.getTypeAtLocation(typeNode),
          checker,
        );
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          lines.push(` * @implements {${closureType}}`);
        }
      }
    }
  }
  lines.push(" */");
  return `${lines.join("\n")}\n`;
}

function getTemplateNames(
  typeParameters:
    | readonly ts.TypeParameterDeclaration[]
    | ts.NodeArray<ts.TypeParameterDeclaration>
    | undefined,
) {
  return (typeParameters ?? []).map((parameter) => parameter.name.text);
}

function hasExportModifier(node: ts.Node) {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0
  );
}

function getPropertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}

function renderPropertyName(name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : `[${JSON.stringify(name)}]`;
}

function hasRestElement(pattern: ts.ObjectBindingPattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}

function isComponentLikeName(name: string | undefined) {
  return !!name && /^[A-Z]/.test(name);
}

function signatureToClosureFunctionType(
  signature: ts.Signature,
  checker: ts.TypeChecker,
) {
  const params = signature.getParameters().map((parameter) => {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration
      ? checker.getTypeOfSymbolAtLocation(parameter, declaration)
      : checker.getTypeOfSymbol(parameter);
    return toClosureType(parameterType, checker);
  });
  const returnType = toClosureType(
    checker.getReturnTypeOfSignature(signature),
    checker,
  );
  return `function(${params.join(", ")}): ${returnType}`;
}

function toClosureType(
  type: ts.Type,
  checker: ts.TypeChecker,
  seen = new Set<ts.Type>(),
): string {
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);

  if (type.flags & ts.TypeFlags.Any) return "?";
  if (type.flags & ts.TypeFlags.Unknown) return "?";
  if (type.flags & ts.TypeFlags.StringLike) return "string";
  if (type.flags & ts.TypeFlags.NumberLike) return "number";
  if (type.flags & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.flags & ts.TypeFlags.Void) return "void";
  if (type.flags & ts.TypeFlags.Undefined) return "undefined";
  if (type.flags & ts.TypeFlags.Null) return "null";
  if (type.flags & ts.TypeFlags.Never) return "never";
  if (type.flags & ts.TypeFlags.TypeParameter)
    return checker.typeToString(type);
  if (type.isUnion()) {
    return `(${type.types.map((item) => toClosureType(item, checker, seen)).join("|")})`;
  }
  if (checker.isArrayType(type)) {
    const typeArguments = checker.getTypeArguments(type as ts.TypeReference);
    const elementType = typeArguments[0]
      ? toClosureType(typeArguments[0], checker, seen)
      : "?";
    return `!Array<${elementType}>`;
  }
  if (checker.isTupleType(type)) {
    const typeArguments = checker.getTypeArguments(type as ts.TypeReference);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${typeArguments.map((item) => toClosureType(item, checker, seen)).join("|")}>`;
  }

  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0) {
    return signatureToClosureFunctionType(callSignatures[0], checker);
  }

  if (type.getSymbol()) {
    const symbolName = checker.symbolToString(type.getSymbol()!);
    if (symbolName && symbolName !== "__type") {
      return symbolName;
    }
  }

  if (
    type.isClassOrInterface() ||
    (type.getProperties().length > 0 && !(type.flags & ts.TypeFlags.Object))
  ) {
    return "!Object";
  }

  return "?";
}
