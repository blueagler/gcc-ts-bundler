import path from "path";

import ts from "@typescript/typescript6";

export interface RuntimeBoundaryDeclarationOrigins {
  boundaryTypeSymbols: ReadonlySet<string>;
  defaultLibraryFiles: ReadonlySet<string>;
  externalValueSymbols: ReadonlySet<ts.Symbol>;
  files: ReadonlySet<string>;
  moduleFiles: ReadonlySet<string>;
  packageRoots: readonly string[];
  ownedProperties: ReadonlyMap<string, ReadonlySet<string>>;
  // These facts belong to this collection's Program. File provenance inputs
  // are complete before construction; boundaryTypeSymbols and ownedProperties
  // still change afterward and must not participate in these caches.
  readonly typeIdentities: WeakMap<ts.Type, readonly string[]>;
  readonly normalizedFileNames: WeakMap<ts.SourceFile, string>;
  readonly boundarySourceFiles: WeakMap<ts.SourceFile, boolean>;
}

export function typeIdentityKeys(
  type: ts.Type,
  origins: RuntimeBoundaryDeclarationOrigins,
): readonly string[] {
  const cached = origins.typeIdentities.get(type);
  if (cached !== undefined) return cached;
  const identities = new Set<string>();
  for (const symbol of typeOwnerSymbols(type)) {
    for (const declaration of symbol.declarations ?? []) {
      identities.add(typeIdentityKey(symbol, declaration, origins));
    }
  }
  const result = [...identities];
  origins.typeIdentities.set(type, result);
  return result;
}

export function typeIdentityKey(
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  return `${normalizedSourceFileName(declaration.getSourceFile(), origins)}:${declaration.pos}:${declaration.end}:${symbol.getName()}`;
}

export function normalizedSourceFileName(
  sourceFile: ts.SourceFile,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  const cached = origins.normalizedFileNames.get(sourceFile);
  if (cached !== undefined) return cached;
  const fileName = path.normalize(sourceFile.fileName);
  origins.normalizedFileNames.set(sourceFile, fileName);
  return fileName;
}

export function typeOwnerSymbols(type: ts.Type) {
  const symbols = new Set<ts.Symbol>();
  if (type.aliasSymbol) symbols.add(type.aliasSymbol);
  const symbol = type.getSymbol();
  if (symbol) symbols.add(symbol);
  if (isTypeReference(type)) {
    if (type.target.aliasSymbol) symbols.add(type.target.aliasSymbol);
    const targetSymbol = type.target.getSymbol();
    if (targetSymbol) symbols.add(targetSymbol);
  }
  return [...symbols];
}

export function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 && "target" in type;
}

export function typeOriginatesFromRuntimeBoundary(
  type: ts.Type,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (
    typeIdentityKeys(type, origins).some((identity) =>
      origins.boundaryTypeSymbols.has(identity),
    ) ||
    symbolOriginatesFromRuntimeBoundary(type.aliasSymbol, origins) ||
    symbolOriginatesFromRuntimeBoundary(type.getSymbol(), origins)
  ) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) =>
      typeOriginatesFromRuntimeBoundary(member, checker, origins, seen),
    );
  }
  if (isTypeReference(type)) {
    return checker
      .getTypeArguments(type)
      .some((argument) =>
        typeOriginatesFromRuntimeBoundary(argument, checker, origins, seen),
      );
  }
  return false;
}

export function symbolOriginatesFromRuntimeBoundary(
  symbol: ts.Symbol | undefined,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  return (symbol?.declarations ?? []).some((declaration) =>
    declarationOriginatesFromRuntimeBoundary(declaration, origins),
  );
}

export function expressionOriginatesFromExternalValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
): boolean {
  expression = unwrapExpression(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return false;
    if (origins.externalValueSymbols.has(symbol)) return true;
    return (
      (symbol.flags & ts.SymbolFlags.Alias) !== 0 &&
      origins.externalValueSymbols.has(checker.getAliasedSymbol(symbol))
    );
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    return expressionOriginatesFromExternalValue(
      expression.expression,
      checker,
      origins,
    );
  }
  return false;
}

export function declarationOriginatesFromRuntimeBoundary(
  declaration: ts.Declaration | undefined,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  if (!declaration) return false;
  const sourceFile = declaration.getSourceFile();
  const cached = origins.boundarySourceFiles.get(sourceFile);
  if (cached !== undefined) return cached;
  const fileName = normalizedSourceFileName(sourceFile, origins);
  const boundary =
    !origins.defaultLibraryFiles.has(fileName) &&
    (origins.moduleFiles.has(fileName) ||
      origins.files.has(fileName) ||
      origins.packageRoots.some(
        (packageRoot) =>
          fileName === packageRoot ||
          fileName.startsWith(`${packageRoot}${path.sep}`),
      ));
  origins.boundarySourceFiles.set(sourceFile, boundary);
  return boundary;
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

export function getStaticPropertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

export function toUtf8Offset(sourceFile: ts.SourceFile, offset: number) {
  return Buffer.byteLength(sourceFile.text.slice(0, offset));
}

export function forEachBoundaryCallArgument(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
  visit: (argument: ts.Expression, parameterType: ts.Type) => void,
) {
  const signature = checker.getResolvedSignature(node);
  const boundaryCall = signature
    ? declarationOriginatesFromRuntimeBoundary(
        signature.getDeclaration(),
        origins,
      )
    : false;
  const parameters = signature?.getParameters() ?? [];
  for (const [index, argument] of node.arguments.entries()) {
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    const declaration =
      parameter?.valueDeclaration ?? parameter?.declarations?.[0];
    if (!parameter || !declaration) continue;
    const parameterType = checker.getTypeOfSymbolAtLocation(
      parameter,
      declaration,
    );
    if (
      boundaryCall ||
      typeOriginatesFromRuntimeBoundary(
        parameterType,
        checker,
        origins,
        new Set(),
      )
    ) {
      visit(argument, parameterType);
    }
  }
}
