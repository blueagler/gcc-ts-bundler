import path from "path";

import ts from "@typescript/typescript6";

import {
  type RuntimeBoundaryDeclarationOrigins,
  declarationOriginatesFromRuntimeBoundary,
  expressionOriginatesFromExternalValue,
  forEachBoundaryCallArgument,
  isTypeReference,
  typeIdentityKey,
  typeIdentityKeys,
  typeOriginatesFromRuntimeBoundary,
  typeOwnerSymbols,
} from "./shared";

export type { RuntimeBoundaryDeclarationOrigins };

export function collectExternalDeclarationOrigins({
  boundaryModuleFileNames = [],
  externalSpecifiers,
  program,
}: {
  boundaryModuleFileNames?: readonly string[] | undefined;
  externalSpecifiers: ReadonlySet<string>;
  program: ts.Program;
}): RuntimeBoundaryDeclarationOrigins {
  const checker = program.getTypeChecker();
  const externalValueSymbols = new Set<ts.Symbol>();
  const files = new Set<string>();
  const packageRoots = new Set<string>();

  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node: ts.Node) => {
      const specifier = getModuleSpecifier(node);
      if (
        specifier &&
        isExternalSpecifier(specifier.text, externalSpecifiers)
      ) {
        const symbol = checker.getSymbolAtLocation(specifier);
        for (const declaration of symbol?.declarations ?? []) {
          addDeclarationFile(declaration.getSourceFile().fileName);
        }
        collectExternalValueSymbols(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const queue = [...files];
  for (let index = 0; index < queue.length; index += 1) {
    const fileName = queue[index];
    if (!fileName) continue;
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    const referencedSpecifiers = new Set<string>();
    const collectSpecifier = (node: ts.Node) => {
      const specifier = getModuleSpecifier(node);
      if (specifier) referencedSpecifiers.add(specifier.text);
      ts.forEachChild(node, collectSpecifier);
    };
    collectSpecifier(sourceFile);
    for (const specifier of referencedSpecifiers) {
      const resolved = ts.resolveModuleName(
        specifier,
        fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedModule?.resolvedFileName;
      if (resolved && addDeclarationFile(resolved))
        queue.push(path.normalize(resolved));
    }
    for (const reference of sourceFile.referencedFiles) {
      const resolved = path.resolve(path.dirname(fileName), reference.fileName);
      if (addDeclarationFile(resolved)) queue.push(path.normalize(resolved));
    }
    for (const reference of sourceFile.typeReferenceDirectives) {
      const resolved = ts.resolveTypeReferenceDirective(
        reference.fileName,
        fileName,
        program.getCompilerOptions(),
        ts.sys,
      ).resolvedTypeReferenceDirective?.resolvedFileName;
      if (resolved && addDeclarationFile(resolved))
        queue.push(path.normalize(resolved));
    }
  }

  const origins: RuntimeBoundaryDeclarationOrigins = {
    boundaryTypeSymbols: new Set(),
    defaultLibraryFiles: new Set(
      program
        .getSourceFiles()
        .filter((sourceFile) => program.isSourceFileDefaultLibrary(sourceFile))
        .map((sourceFile) => path.normalize(sourceFile.fileName)),
    ),
    externalValueSymbols,
    files,
    moduleFiles: new Set(
      boundaryModuleFileNames.map((fileName) => path.normalize(fileName)),
    ),
    packageRoots: [...packageRoots].sort(),
    ownedProperties: new Map(),
  };
  origins.boundaryTypeSymbols = collectBoundaryTypeSymbols(
    program,
    checker,
    origins,
  );
  const ownedProperties = collectSpreadOwnedProperties(
    program,
    checker,
    origins,
  );
  collectContextualOwnedProperties(program, checker, origins, ownedProperties);
  origins.ownedProperties = ownedProperties;
  return origins;

  function collectExternalValueSymbols(node: ts.Node) {
    const add = (name: ts.Identifier) => {
      const symbol = checker.getSymbolAtLocation(name);
      if (!symbol) return;
      externalValueSymbols.add(symbol);
      if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        externalValueSymbols.add(checker.getAliasedSymbol(symbol));
      }
    };
    if (ts.isImportDeclaration(node) && node.importClause) {
      if (node.importClause.name) add(node.importClause.name);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        add(bindings.name);
      } else if (bindings) {
        for (const element of bindings.elements) add(element.name);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      add(node.name);
    }
  }

  function addDeclarationFile(fileName: string) {
    const normalized = path.normalize(fileName);
    if (files.has(normalized)) return false;
    files.add(normalized);
    const packageRoot = findNodeModulesPackageRoot(normalized);
    if (packageRoot) packageRoots.add(packageRoot);
    return true;
  }
}

function collectBoundaryTypeSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  const symbols = new Set<string>();
  const seenTypes = new Set<ts.Type>();
  const requiredBoundaryTypes = new Map<ts.Type, string>();
  const collectType = (type: ts.Type, requiredBy?: string) => {
    if (requiredBy) requiredBoundaryTypes.set(type, requiredBy);
    if (seenTypes.has(type)) return;
    seenTypes.add(type);
    if (
      (type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.NumberLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.BigIntLike |
          ts.TypeFlags.ESSymbolLike |
          ts.TypeFlags.Void |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Null |
          ts.TypeFlags.Never)) !==
      0
    ) {
      return;
    }
    const owners = typeOwnerSymbols(type);
    const defaultLibraryType = owners.some((symbol) =>
      symbol.declarations?.some((declaration) =>
        origins.defaultLibraryFiles.has(
          path.normalize(declaration.getSourceFile().fileName),
        ),
      ),
    );
    for (const symbol of owners) {
      for (const declaration of symbol.declarations ?? []) {
        if (
          origins.defaultLibraryFiles.has(
            path.normalize(declaration.getSourceFile().fileName),
          )
        ) {
          continue;
        }
        symbols.add(typeIdentityKey(symbol, declaration));
      }
    }
    if (type.isUnionOrIntersection()) {
      for (const member of type.types) collectType(member, requiredBy);
    }
    if (isTypeReference(type)) {
      for (const argument of checker.getTypeArguments(type)) {
        collectType(argument, requiredBy);
      }
      if (defaultLibraryType) return;
    }
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration =
        property.valueDeclaration ?? property.declarations?.[0];
      if (declaration) {
        collectType(
          checker.getTypeOfSymbolAtLocation(property, declaration),
          requiredBy,
        );
      }
    }
  };

  collectRequiredRuntimeBoundarySurfaces();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        collectCallOrConstructBoundaryTypes(sourceFile, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const unclassified = [...requiredBoundaryTypes].flatMap(
    ([type, requiredBy]) => {
      const identities = typeIdentityKeys(type).filter(
        (identity) => !isDefaultLibraryIdentity(identity, origins),
      );
      if (
        identities.length === 0 ||
        identities.some((identity) => symbols.has(identity))
      ) {
        return [];
      }
      return [`${requiredBy}: ${checker.typeToString(type)}`];
    },
  );
  if (unclassified.length > 0) {
    throw new Error(
      `Runtime boundary type coverage is incomplete:\n${unclassified
        .sort()
        .map((item) => `  - ${item}`)
        .join("\n")}`,
    );
  }
  return symbols;

  function collectSerializedWriteValue(
    sourceFile: ts.SourceFile,
    node: ts.CallExpression,
  ) {
    if (!isSourceFunctionCall(node, "writeJson", "shared/cache-store.ts"))
      return;
    const value = node.arguments[1];
    if (!value) {
      throw new Error(
        `Serialized write is missing its value at ${sourceFile.fileName}:${node.getStart(sourceFile)}`,
      );
    }
    collectType(
      checker.getTypeAtLocation(value),
      `serialized write ${sourceFile.fileName}:${node.getStart(sourceFile)}`,
    );
  }

  function collectValidatedObjectSchema(
    sourceFile: ts.SourceFile,
    node: ts.CallExpression,
  ) {
    if (!isSourceFunctionCall(node, "isObjectOf", "shared/validation.ts"))
      return;
    const schema = node.arguments[0];
    if (schema) {
      collectType(
        checker.getTypeAtLocation(schema),
        `validated object schema ${sourceFile.fileName}:${node.getStart(sourceFile)}`,
      );
    }
    const validatedType = node.typeArguments?.[0];
    if (validatedType) {
      collectType(
        checker.getTypeFromTypeNode(validatedType),
        `validated object ${sourceFile.fileName}:${node.getStart(sourceFile)}`,
      );
    }
  }

  function collectExternalCallSurfaces(
    node: ts.CallExpression | ts.NewExpression,
  ) {
    const signature = checker.getResolvedSignature(node);
    const syntacticExternal = expressionOriginatesFromExternalValue(
      node.expression,
      checker,
      origins,
    );
    if (
      !syntacticExternal &&
      !(
        signature &&
        declarationOriginatesFromRuntimeBoundary(
          signature.getDeclaration(),
          origins,
        )
      )
    ) {
      return;
    }
    if (signature) {
      collectType(signature.getReturnType());
      for (const parameter of signature.getParameters()) {
        const declaration =
          parameter.valueDeclaration ?? parameter.declarations?.[0];
        if (declaration) {
          collectType(
            checker.getTypeOfSymbolAtLocation(parameter, declaration),
          );
        }
      }
    }
    if (!syntacticExternal) return;
    for (const argument of node.arguments ?? []) {
      collectType(checker.getTypeAtLocation(argument));
    }
  }

  function collectCallOrConstructBoundaryTypes(
    sourceFile: ts.SourceFile,
    node: ts.CallExpression | ts.NewExpression,
  ) {
    if (ts.isCallExpression(node)) {
      collectSerializedWriteValue(sourceFile, node);
      collectValidatedObjectSchema(sourceFile, node);
    }
    collectExternalCallSurfaces(node);
  }

  function isSourceFunctionCall(
    node: ts.CallExpression,
    functionName: string,
    sourceSuffix: string,
  ) {
    let symbol = checker.getSymbolAtLocation(node.expression);
    if (!symbol) return false;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = checker.getAliasedSymbol(symbol);
    }
    return (
      symbol.getName() === functionName &&
      (symbol.declarations ?? []).some((declaration) =>
        path
          .normalize(declaration.getSourceFile().fileName)
          .replaceAll(path.sep, "/")
          .endsWith(sourceSuffix),
      )
    );
  }

  function collectSignature(signature: ts.Signature, requiredBy: string) {
    collectType(signature.getReturnType(), `${requiredBy} return`);
    for (const parameter of signature.getParameters()) {
      const declaration =
        parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (declaration) {
        collectType(
          checker.getTypeOfSymbolAtLocation(parameter, declaration),
          `${requiredBy} parameter ${parameter.getName()}`,
        );
      }
    }
  }

  function collectPreservedModuleExports(sourceFile: ts.SourceFile) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      collectPreservedExport(sourceFile, exported);
    }
  }

  function collectPreservedExport(
    sourceFile: ts.SourceFile,
    exported: ts.Symbol,
  ) {
    const symbol =
      (exported.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(exported)
        : exported;
    const declaration =
      symbol.valueDeclaration ??
      symbol.declarations?.[0] ??
      exported.valueDeclaration ??
      exported.declarations?.[0];
    if (!declaration) return;
    const exportedType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    const signatures = [
      ...exportedType.getCallSignatures(),
      ...exportedType.getConstructSignatures(),
    ];
    const requiredBy = `preserved export ${sourceFile.fileName}#${exported.getName()}`;
    if (signatures.length === 0) {
      collectType(exportedType, requiredBy);
      return;
    }
    for (const signature of signatures) {
      collectSignature(signature, requiredBy);
    }
  }

  function collectNativeBindingSurfaces(sourceFile: ts.SourceFile) {
    for (const statement of sourceFile.statements) {
      if (
        !ts.isInterfaceDeclaration(statement) ||
        statement.name.text !== "NativeBinding"
      ) {
        continue;
      }
      for (const member of statement.members) {
        collectNativeBindingMethod(sourceFile, member);
      }
    }
  }

  function collectNativeBindingMethod(
    sourceFile: ts.SourceFile,
    member: ts.TypeElement,
  ) {
    if (!ts.isMethodSignature(member)) return;
    const signature = checker.getSignatureFromDeclaration(member);
    if (!signature) {
      throw new Error(
        `Unable to inspect native binding method ${member.name.getText(sourceFile)}`,
      );
    }
    collectSignature(
      signature,
      `native binding ${member.name.getText(sourceFile)}`,
    );
  }

  function collectRequiredRuntimeBoundarySurfaces() {
    for (const sourceFile of program.getSourceFiles()) {
      if (!origins.moduleFiles.has(path.normalize(sourceFile.fileName)))
        continue;
      collectPreservedModuleExports(sourceFile);
      collectNativeBindingSurfaces(sourceFile);
    }
  }
}

function collectSpreadOwnedProperties(
  program: ts.Program,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  const owned = new Map<string, Set<string>>();
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const targetType = checker.getContextualType(node);
        const targetIdentities = targetType ? typeIdentityKeys(targetType) : [];
        if (targetType && targetIdentities.length > 0) {
          for (const property of node.properties) {
            if (!ts.isSpreadAssignment(property)) continue;
            const spreadType = checker.getTypeAtLocation(property.expression);
            if (
              !typeOriginatesFromRuntimeBoundary(
                spreadType,
                checker,
                origins,
                new Set(),
              )
            ) {
              continue;
            }
            for (const spreadProperty of checker.getPropertiesOfType(
              spreadType,
            )) {
              const name = spreadProperty.getName();
              if (!checker.getPropertyOfType(targetType, name)) continue;
              for (const identity of targetIdentities) {
                let names = owned.get(identity);
                if (!names) {
                  names = new Set();
                  owned.set(identity, names);
                }
                names.add(name);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return owned;
}

function collectContextualOwnedProperties(
  program: ts.Program,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
  owned: Map<string, Set<string>>,
) {
  const seen = new Map<ts.Type, Set<ts.Type>>();
  const alreadyAligned = (actual: ts.Type, expected: ts.Type) => {
    let expectedTypes = seen.get(actual);
    if (!expectedTypes) {
      expectedTypes = new Set();
      seen.set(actual, expectedTypes);
    }
    if (expectedTypes.has(expected)) return true;
    expectedTypes.add(expected);
    return false;
  };
  const alignContainerTypeArguments = (
    actual: ts.TypeReference,
    expected: ts.TypeReference,
  ) => {
    const actualArguments = checker.getTypeArguments(actual);
    const expectedArguments = checker.getTypeArguments(expected);
    if (
      actualArguments.length !== expectedArguments.length ||
      !(
        checker.isArrayType(actual) ||
        checker.isTupleType(actual) ||
        typeOwnerSymbols(expected).some((symbol) =>
          symbol.declarations?.some((declaration) =>
            origins.defaultLibraryFiles.has(
              path.normalize(declaration.getSourceFile().fileName),
            ),
          ),
        )
      )
    ) {
      return false;
    }
    for (let index = 0; index < actualArguments.length; index += 1) {
      const actualArgument = actualArguments[index];
      const expectedArgument = expectedArguments[index];
      if (actualArgument && expectedArgument) {
        alignTypes(actualArgument, expectedArgument);
      }
    }
    return true;
  };
  const recordOwnedProperty = (identity: string, name: string) => {
    let names = owned.get(identity);
    if (!names) {
      names = new Set();
      owned.set(identity, names);
    }
    names.add(name);
  };
  const alignSharedProperties = (actual: ts.Type, expected: ts.Type) => {
    const actualOwners = typeIdentityKeys(actual).filter(
      (identity) => !identity.startsWith("<default-lib>"),
    );
    for (const expectedProperty of checker.getPropertiesOfType(expected)) {
      const name = expectedProperty.getName();
      const actualProperty = checker.getPropertyOfType(actual, name);
      if (!actualProperty) continue;
      for (const identity of actualOwners) {
        recordOwnedProperty(identity, name);
      }
      const actualDeclaration =
        actualProperty.valueDeclaration ?? actualProperty.declarations?.[0];
      const expectedDeclaration =
        expectedProperty.valueDeclaration ?? expectedProperty.declarations?.[0];
      if (!actualDeclaration || !expectedDeclaration) continue;
      alignTypes(
        checker.getTypeOfSymbolAtLocation(actualProperty, actualDeclaration),
        checker.getTypeOfSymbolAtLocation(
          expectedProperty,
          expectedDeclaration,
        ),
      );
    }
  };
  const alignTypes = (actual: ts.Type, expected: ts.Type) => {
    if (alreadyAligned(actual, expected)) return;
    if (actual.isUnionOrIntersection()) {
      for (const member of actual.types) alignTypes(member, expected);
      return;
    }
    if (expected.isUnionOrIntersection()) {
      for (const member of expected.types) alignTypes(actual, member);
      return;
    }
    if (
      isTypeReference(actual) &&
      isTypeReference(expected) &&
      alignContainerTypeArguments(actual, expected)
    ) {
      return;
    }
    alignSharedProperties(actual, expected);
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        forEachBoundaryCallArgument(
          node,
          checker,
          origins,
          (argument, expected) => {
            alignTypes(checker.getTypeAtLocation(argument), expected);
          },
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function isDefaultLibraryIdentity(
  identity: string,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  return [...origins.defaultLibraryFiles].some((fileName) =>
    identity.startsWith(`${fileName}:`),
  );
}

function isExternalSpecifier(
  specifier: string,
  externalSpecifiers: ReadonlySet<string>,
) {
  return (
    externalSpecifiers.has(specifier) ||
    (specifier.startsWith("node:")
      ? externalSpecifiers.has(specifier.slice("node:".length))
      : externalSpecifiers.has(`node:${specifier}`))
  );
}

function getModuleSpecifier(node: ts.Node): ts.StringLiteralLike | null {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteralLike(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression;
  }
  return null;
}

function findNodeModulesPackageRoot(fileName: string): string | null {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = fileName.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const packageStart = markerIndex + marker.length;
  const segments = fileName.slice(packageStart).split(path.sep);
  const segmentCount = segments[0]?.startsWith("@") ? 2 : 1;
  if (segments.length < segmentCount) return null;
  return path.join(
    fileName.slice(0, markerIndex + marker.length),
    ...segments.slice(0, segmentCount),
  );
}
