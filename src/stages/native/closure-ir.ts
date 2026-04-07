import ts from "typescript";

import { loadCompilerOptions } from "./compiler-options";

export interface ClosureIrFileMetadata {
  decoratedOutputText?: string;
  enumDeclarations: ClosureIrEnumDeclaration[];
  filePath: string;
  topLevelDocs: ClosureIrTopLevelDoc[];
  typeDeclarations: ClosureIrTypeDeclaration[];
}

export interface ClosureIrEnumDeclaration {
  exported: boolean;
  members: Array<{
    name: string;
    value: boolean | number | string;
  }>;
  name: string;
  valueType: "boolean" | "number" | "string";
}

export interface ClosureIrTopLevelDoc {
  jsdoc: string;
  kind: "class" | "function";
  name: string;
}

export interface ClosureIrTypeDeclaration {
  snippet: string;
}

interface FunctionObjectParamRecord {
  snippet: string;
  typeName: string;
}

export async function collectClosureIrMetadata({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    rootDir: workspaceDir,
  });
  const program = ts.createProgram(fileNames, compilerOptions);
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const inputFiles = new Set(fileNames);

  const files: ClosureIrFileMetadata[] = [];
  const diagnostics: ts.Diagnostic[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }

    const typeDeclarations: ClosureIrTypeDeclaration[] = [];
    const topLevelDocs: ClosureIrTopLevelDoc[] = [];
    const enumDeclarations: ClosureIrEnumDeclaration[] = [];

    for (const statement of sourceFile.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(
          buildInterfaceDeclarationSnippet(statement, checker),
        );
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(
          buildTypeAliasDeclarationSnippet(statement, checker),
        );
        continue;
      }

      if (ts.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(
          statement,
          checker,
          unsafeEnumSymbols,
        );
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }

      if (ts.isFunctionDeclaration(statement) && statement.name) {
        const objectParamRecord = buildFunctionObjectParamRecord(
          statement,
          checker,
        );
        if (objectParamRecord) {
          typeDeclarations.push({ snippet: objectParamRecord.snippet });
        }
        const jsdoc = buildFunctionJsDoc(
          statement,
          checker,
          objectParamRecord?.typeName,
        );
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: statement.name.text,
          });
        }
        continue;
      }

      if (ts.isClassDeclaration(statement) && statement.name) {
        const jsdoc = buildClassJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "class",
            name: statement.name.text,
          });
        }
      }
    }

    let decoratedOutputText: string | undefined;
    if (containsDecorators(sourceFile)) {
      const transpiled = ts.transpileModule(sourceFile.getFullText(), {
        compilerOptions: {
          ...compilerOptions,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          sourceMap: false,
          target: ts.ScriptTarget.ES2018,
        },
        fileName: sourceFile.fileName,
        reportDiagnostics: true,
      });
      diagnostics.push(
        ...(transpiled.diagnostics ?? []).filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
        ),
      );
      decoratedOutputText = transpiled.outputText;
    }

    files.push({
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations,
    });
  }

  return { diagnostics, files };
}

function containsDecorators(sourceFile: ts.SourceFile) {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }
    if (
      ts.canHaveDecorators(node) &&
      (ts.getDecorators(node)?.length ?? 0) > 0
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function collectUnsafeEnumSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
) {
  const unsafe = new Set<ts.Symbol>();
  const mark = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol,
      );
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node: ts.Node) => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        mark(node.expression);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        ["entries", "keys", "values"].includes(node.expression.name.text) &&
        node.arguments.length > 0 &&
        ts.isIdentifier(node.arguments[0])
      ) {
        mark(node.arguments[0]);
      }
      if (
        ts.isIdentifier(node) &&
        !ts.isPropertyAccessExpression(node.parent) &&
        !ts.isElementAccessExpression(node.parent) &&
        !ts.isImportSpecifier(node.parent) &&
        !ts.isImportClause(node.parent) &&
        !ts.isExportSpecifier(node.parent) &&
        !ts.isEnumDeclaration(node.parent) &&
        !ts.isEnumMember(node.parent)
      ) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved =
            symbol.flags & ts.SymbolFlags.Alias
              ? checker.getAliasedSymbol(symbol)
              : symbol;
          if (resolved.flags & ts.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return unsafe;
}

function buildEnumDeclarationMetadata(
  statement: ts.EnumDeclaration,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved =
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }

  const members: ClosureIrEnumDeclaration["members"] = [];
  let valueType: ClosureIrEnumDeclaration["valueType"] | null = null;
  let nextNumber = 0;

  for (const member of statement.members) {
    const memberName = getPropertyNameText(member.name);
    if (!memberName) {
      return null;
    }

    const constantValue = checker.getConstantValue(member);
    const memberValue =
      constantValue ??
      (member.initializer
        ? literalValueFromExpression(member.initializer)
        : nextNumber);
    if (memberValue === undefined) {
      return null;
    }

    const currentValueType = typeof memberValue;
    if (
      currentValueType !== "number" &&
      currentValueType !== "string" &&
      currentValueType !== "boolean"
    ) {
      return null;
    }
    if (valueType && valueType !== currentValueType) {
      return null;
    }
    valueType = currentValueType;
    members.push({ name: memberName, value: memberValue });
    if (typeof memberValue === "number") {
      nextNumber = memberValue + 1;
    }
  }

  if (!valueType || members.length === 0) {
    return null;
  }

  if (valueType === "number" && !hasConstModifier(statement)) {
    return null;
  }

  return {
    exported: hasExportModifier(statement),
    members,
    name: statement.name.text,
    valueType,
  };
}

function buildInterfaceDeclarationSnippet(
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

function buildTypeAliasDeclarationSnippet(
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

function buildFunctionJsDoc(
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

function buildFunctionObjectParamRecord(
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

function hasRestElement(pattern: ts.ObjectBindingPattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}

function isComponentLikeName(name: string | undefined) {
  return !!name && /^[A-Z]/.test(name);
}

function buildClassJsDoc(
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

function hasConstModifier(node: ts.EnumDeclaration) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Const) !== 0;
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

function literalValueFromExpression(
  expression: ts.Expression,
): boolean | number | string | undefined {
  if (ts.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expression.operand)
  ) {
    return -Number(expression.operand.text);
  }
  return undefined;
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

  if (type.flags & ts.TypeFlags.Any) {
    return "?";
  }
  if (type.flags & ts.TypeFlags.Unknown) {
    return "?";
  }
  if (type.flags & ts.TypeFlags.StringLike) {
    return "string";
  }
  if (type.flags & ts.TypeFlags.NumberLike) {
    return "number";
  }
  if (type.flags & ts.TypeFlags.BooleanLike) {
    return "boolean";
  }
  if (type.flags & ts.TypeFlags.Void) {
    return "void";
  }
  if (type.flags & ts.TypeFlags.Undefined) {
    return "undefined";
  }
  if (type.flags & ts.TypeFlags.Null) {
    return "null";
  }
  if (type.flags & ts.TypeFlags.Never) {
    return "never";
  }
  if (type.flags & ts.TypeFlags.TypeParameter) {
    return checker.typeToString(type);
  }
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
