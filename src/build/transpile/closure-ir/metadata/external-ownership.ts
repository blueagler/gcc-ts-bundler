import path from "path";

import ts from "@typescript/typescript6";

interface RuntimeBoundaryDeclarationOrigins {
  boundaryTypeSymbols: ReadonlySet<string>;
  defaultLibraryFiles: ReadonlySet<string>;
  externalValueSymbols: ReadonlySet<ts.Symbol>;
  files: ReadonlySet<string>;
  moduleFiles: ReadonlySet<string>;
  packageRoots: readonly string[];
  ownedProperties: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface ExternalGlobalProtocolEvidence {
  externalGlobals: readonly string[];
  memberAccessesByFile: ReadonlyMap<string, readonly number[]>;
  memberProperties: readonly string[];
  rootProperties: readonly string[];
}

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
        if (ts.isCallExpression(node)) {
          if (
            isSourceFunctionCall(node, "writeJson", "shared/cache-store.ts")
          ) {
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
          if (
            isSourceFunctionCall(node, "isObjectOf", "shared/validation.ts")
          ) {
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
        }
        const signature = checker.getResolvedSignature(node);
        const syntacticExternal = expressionOriginatesFromExternalValue(
          node.expression,
          checker,
          origins,
        );
        if (
          syntacticExternal ||
          (signature &&
            declarationOriginatesFromRuntimeBoundary(
              signature.getDeclaration(),
              origins,
            ))
        ) {
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
          if (syntacticExternal) {
            for (const argument of node.arguments ?? []) {
              collectType(checker.getTypeAtLocation(argument));
            }
          }
        }
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

  function collectRequiredRuntimeBoundarySurfaces() {
    for (const sourceFile of program.getSourceFiles()) {
      if (!origins.moduleFiles.has(path.normalize(sourceFile.fileName)))
        continue;
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (moduleSymbol) {
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
          const symbol =
            (exported.flags & ts.SymbolFlags.Alias) !== 0
              ? checker.getAliasedSymbol(exported)
              : exported;
          const declaration =
            symbol.valueDeclaration ??
            symbol.declarations?.[0] ??
            exported.valueDeclaration ??
            exported.declarations?.[0];
          if (!declaration) continue;
          const exportedType = checker.getTypeOfSymbolAtLocation(
            symbol,
            declaration,
          );
          const signatures = [
            ...exportedType.getCallSignatures(),
            ...exportedType.getConstructSignatures(),
          ];
          if (signatures.length === 0) {
            collectType(
              exportedType,
              `preserved export ${sourceFile.fileName}#${exported.getName()}`,
            );
          } else {
            for (const signature of signatures) {
              collectSignature(
                signature,
                `preserved export ${sourceFile.fileName}#${exported.getName()}`,
              );
            }
          }
        }
      }

      for (const statement of sourceFile.statements) {
        if (
          !ts.isInterfaceDeclaration(statement) ||
          statement.name.text !== "NativeBinding"
        ) {
          continue;
        }
        for (const member of statement.members) {
          if (!ts.isMethodSignature(member)) continue;
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
      }
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
  const alignTypes = (actual: ts.Type, expected: ts.Type) => {
    let expectedTypes = seen.get(actual);
    if (!expectedTypes) {
      expectedTypes = new Set();
      seen.set(actual, expectedTypes);
    }
    if (expectedTypes.has(expected)) return;
    expectedTypes.add(expected);

    if (actual.isUnionOrIntersection()) {
      for (const member of actual.types) alignTypes(member, expected);
      return;
    }
    if (expected.isUnionOrIntersection()) {
      for (const member of expected.types) alignTypes(actual, member);
      return;
    }
    if (isTypeReference(actual) && isTypeReference(expected)) {
      const actualArguments = checker.getTypeArguments(actual);
      const expectedArguments = checker.getTypeArguments(expected);
      if (
        actualArguments.length === expectedArguments.length &&
        (checker.isArrayType(actual) ||
          checker.isTupleType(actual) ||
          typeOwnerSymbols(expected).some((symbol) =>
            symbol.declarations?.some((declaration) =>
              origins.defaultLibraryFiles.has(
                path.normalize(declaration.getSourceFile().fileName),
              ),
            ),
          ))
      ) {
        for (let index = 0; index < actualArguments.length; index += 1) {
          const actualArgument = actualArguments[index];
          const expectedArgument = expectedArguments[index];
          if (actualArgument && expectedArgument) {
            alignTypes(actualArgument, expectedArgument);
          }
        }
        return;
      }
    }

    const actualOwners = typeIdentityKeys(actual).filter(
      (identity) => !identity.startsWith("<default-lib>"),
    );
    for (const expectedProperty of checker.getPropertiesOfType(expected)) {
      const name = expectedProperty.getName();
      const actualProperty = checker.getPropertyOfType(actual, name);
      if (!actualProperty) continue;
      for (const identity of actualOwners) {
        let names = owned.get(identity);
        if (!names) {
          names = new Set();
          owned.set(identity, names);
        }
        names.add(name);
      }
      const actualDeclaration =
        actualProperty.valueDeclaration ?? actualProperty.declarations?.[0];
      const expectedDeclaration =
        expectedProperty.valueDeclaration ?? expectedProperty.declarations?.[0];
      if (actualDeclaration && expectedDeclaration) {
        alignTypes(
          checker.getTypeOfSymbolAtLocation(actualProperty, actualDeclaration),
          checker.getTypeOfSymbolAtLocation(
            expectedProperty,
            expectedDeclaration,
          ),
        );
      }
    }
  };

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
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
          const expected = checker.getTypeOfSymbolAtLocation(
            parameter,
            declaration,
          );
          if (
            boundaryCall ||
            typeOriginatesFromRuntimeBoundary(
              expected,
              checker,
              origins,
              new Set(),
            )
          ) {
            alignTypes(checker.getTypeAtLocation(argument), expected);
          }
        }
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

function typeIdentityKeys(type: ts.Type) {
  const identities = new Set<string>();
  for (const symbol of typeOwnerSymbols(type)) {
    for (const declaration of symbol.declarations ?? []) {
      identities.add(typeIdentityKey(symbol, declaration));
    }
  }
  return [...identities];
}

function typeIdentityKey(symbol: ts.Symbol, declaration: ts.Declaration) {
  return `${path.normalize(declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}:${symbol.getName()}`;
}

function typeOwnerSymbols(type: ts.Type) {
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


export function collectExternalGlobalProtocolEvidence({
  checker,
  platformGlobalNames = new Set(),
  platformGlobalPropertyAliases = new Set(),
  platformPropertyNames = new Set(),
  program,
  sourceFiles,
}: {
  checker: ts.TypeChecker;
  platformGlobalNames?: ReadonlySet<string> | undefined;
  platformGlobalPropertyAliases?: ReadonlySet<string> | undefined;
  platformPropertyNames?: ReadonlySet<string> | undefined;
  program: ts.Program;
  sourceFiles: readonly ts.SourceFile[];
}): ExternalGlobalProtocolEvidence {
  const globalNames = new Set(["globalThis", "self", "window"]);
  const aliases = new Set<ts.Symbol>();
  const symbolAt = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const isAmbientGlobal = (identifier: ts.Identifier) => {
    if (!globalNames.has(identifier.text)) return false;
    const symbol = symbolAt(identifier);
    return (
      symbol === undefined ||
      (symbol.declarations ?? []).every(
        (declaration) => declaration.getSourceFile().isDeclarationFile,
      )
    );
  };
  const isGlobalRoot = (expression: ts.Expression): boolean => {
    expression = unwrapExpression(expression);
    if (!ts.isIdentifier(expression)) return false;
    const symbol = symbolAt(expression);
    return (
      isAmbientGlobal(expression) ||
      (symbol !== undefined && aliases.has(symbol))
    );
  };
  const isGlobalAliasValue = (expression: ts.Expression): boolean => {
    expression = unwrapExpression(expression);
    if (isGlobalRoot(expression)) return true;
    if (ts.isConditionalExpression(expression)) {
      return (
        isGlobalAliasValue(expression.whenTrue) ||
        isGlobalAliasValue(expression.whenFalse)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      return (
        isGlobalAliasValue(expression.left) ||
        isGlobalAliasValue(expression.right)
      );
    }
    return false;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const sourceFile of sourceFiles) {
      const visitAlias = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isGlobalAliasValue(node.initializer)
        ) {
          const symbol = symbolAt(node.name);
          if (symbol && !aliases.has(symbol)) {
            aliases.add(symbol);
            changed = true;
          }
        }
        ts.forEachChild(node, visitAlias);
      };
      visitAlias(sourceFile);
    }
  }

  type Access = {
    nameNode: ts.Node;
    platform: boolean;
    sourceFile: ts.SourceFile;
  };
  const reads = new Map<string, Access[]>();
  const writeAccesses = new Map<string, Access[]>();
  const writes = new Set<string>();
  const addAccess = (
    target: Map<string, Access[]>,
    name: string,
    nameNode: ts.Node,
    receiver: ts.Expression,
    sourceFile: ts.SourceFile,
  ) => {
    const receiverType = checker.getTypeAtLocation(receiver);
    const property = checker.getPropertyOfType(receiverType, name);
    const platform = (property?.declarations ?? []).some((declaration) =>
      program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    );
    const existing = target.get(name) ?? [];
    existing.push({ nameNode, platform, sourceFile });
    target.set(name, existing);
  };
  const addRead = (
    name: string,
    nameNode: ts.Node,
    receiver: ts.Expression,
    sourceFile: ts.SourceFile,
  ) => addAccess(reads, name, nameNode, receiver, sourceFile);
  const addWriteAccess = (
    name: string,
    nameNode: ts.Node,
    receiver: ts.Expression,
    sourceFile: ts.SourceFile,
  ) => addAccess(writeAccesses, name, nameNode, receiver, sourceFile);
  const accessMode = (node: ts.Expression) => {
    const parent = node.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.left === node &&
      isAssignmentOperator(parent.operatorToken.kind)
    ) {
      return {
        read: parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken,
        write: true,
      };
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      (parent.operator === ts.SyntaxKind.PlusPlusToken ||
        parent.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return { read: true, write: true };
    }
    if (ts.isDeleteExpression(parent) && parent.expression === node) {
      return { read: false, write: true };
    }
    return { read: true, write: false };
  };
  const staticAccess = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && isGlobalRoot(node.expression)) {
      return {
        expression: node,
        name: node.name.text,
        nameNode: node.name,
        receiver: node.expression,
      };
    }
    if (
      ts.isElementAccessExpression(node) &&
      isGlobalRoot(node.expression) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return {
        expression: node,
        name: node.argumentExpression.text,
        nameNode: node.argumentExpression,
        receiver: node.expression,
      };
    }
    return null;
  };
  const isAmbientObject = (expression: ts.Expression) => {
    expression = unwrapExpression(expression);
    if (!ts.isIdentifier(expression) || expression.text !== "Object") {
      return false;
    }
    const symbol = symbolAt(expression);
    return (
      symbol === undefined ||
      (symbol.declarations ?? []).some((declaration) =>
        program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
      )
    );
  };

  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node) => {
      const access = staticAccess(node);
      if (access) {
        const mode = accessMode(access.expression);
        if (mode.read) {
          addRead(access.name, access.nameNode, access.receiver, sourceFile);
        }
        if (mode.write) {
          writes.add(access.name);
          addWriteAccess(
            access.name,
            access.nameNode,
            access.receiver,
            sourceFile,
          );
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "assign" &&
        isAmbientObject(node.expression.expression) &&
        node.arguments[0] &&
        isGlobalRoot(node.arguments[0])
      ) {
        for (const source of node.arguments.slice(1)) {
          const unwrapped = unwrapExpression(source);
          if (!ts.isObjectLiteralExpression(unwrapped)) continue;
          for (const property of unwrapped.properties) {
            if (ts.isSpreadAssignment(property) || !property.name) continue;
            const name = getStaticPropertyName(property.name);
            if (name !== null) writes.add(name);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const isBareRead = (identifier: ts.Identifier) => {
    const parent = identifier.parent;
    if (
      (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
      (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
      (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
      (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
      (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
      (ts.isParameter(parent) && parent.name === identifier) ||
      ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) &&
        parent.name === identifier) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isLabeledStatement(parent) ||
      (ts.isBinaryExpression(parent) &&
        parent.left === identifier &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      return false;
    }
    return true;
  };
  const producerNames = new Set<string>();
  const producerSymbols = new Set<ts.Symbol>();
  const addBindingSymbols = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      producerNames.add(name.text);
      const symbol = symbolAt(name);
      if (symbol) producerSymbols.add(symbol);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingSymbols(element.name);
    }
  };
  for (const sourceFile of sourceFiles) {
    const visitProducer = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        addBindingSymbols(node.name);
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name
      ) {
        addBindingSymbols(node.name);
      } else if (ts.isImportClause(node) && node.name) {
        addBindingSymbols(node.name);
      } else if (ts.isImportSpecifier(node)) {
        addBindingSymbols(node.name);
      } else if (ts.isNamespaceImport(node)) {
        addBindingSymbols(node.name);
      } else if (ts.isImportEqualsDeclaration(node)) {
        addBindingSymbols(node.name);
      }
      ts.forEachChild(node, visitProducer);
    };
    visitProducer(sourceFile);
  }
  const isEnvironmentIdentifier = (identifier: ts.Identifier) => {
    const symbol = symbolAt(identifier);
    if (
      (symbol?.declarations ?? []).some((declaration) =>
        program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
      )
    ) {
      return true;
    }
    return (
      !producerNames.has(identifier.text) &&
      (symbol === undefined || !producerSymbols.has(symbol))
    );
  };
  const externalGlobals = new Set<string>();
  const bindingNameCache = new Map<string, boolean>();
  const isBindingName = (name: string) => {
    let valid = bindingNameCache.get(name);
    if (valid === undefined) {
      valid =
        ts
          .createScanner(
            ts.ScriptTarget.Latest,
            false,
            ts.LanguageVariant.Standard,
            name,
          )
          .scan() === ts.SyntaxKind.Identifier;
      bindingNameCache.set(name, valid);
    }
    return valid;
  };
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node) => {
      if (
        ts.isIdentifier(node) &&
        isBareRead(node) &&
        isEnvironmentIdentifier(node) &&
        isBindingName(node.text) &&
        !globalNames.has(node.text) &&
        !platformGlobalNames.has(node.text) &&
        !platformGlobalPropertyAliases.has(node.text)
      ) {
        externalGlobals.add(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const rootProperties = [...new Set([...reads.keys(), ...externalGlobals])]
    .filter((name) => {
      if (externalGlobals.has(name)) return true;
      const accesses = reads.get(name) ?? [];
      return (
        !writes.has(name) &&
        !platformPropertyNames.has(name) &&
        !accesses.some((access) => access.platform)
      );
    })
    .sort();
  const rootPropertySet = new Set(rootProperties);
  const memberAccessesByFile = new Map<string, number[]>();
  for (const name of rootProperties) {
    for (const access of [
      ...(reads.get(name) ?? []),
      ...(externalGlobals.has(name) ? (writeAccesses.get(name) ?? []) : []),
    ]) {
      const fileName = path.normalize(access.sourceFile.fileName);
      const starts = memberAccessesByFile.get(fileName) ?? [];
      starts.push(
        toUtf8Offset(
          access.sourceFile,
          access.nameNode.getStart(access.sourceFile),
        ),
      );
      memberAccessesByFile.set(fileName, starts);
    }
  }
  for (const sourceFile of sourceFiles) {
    const visitExternalNameAccess = (node: ts.Node) => {
      const nameNode = ts.isPropertyAccessExpression(node)
        ? node.name
        : ts.isElementAccessExpression(node) &&
            node.argumentExpression &&
            ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression
          : null;
      if (nameNode && externalGlobals.has(nameNode.text)) {
        const fileName = path.normalize(sourceFile.fileName);
        const starts = memberAccessesByFile.get(fileName) ?? [];
        starts.push(toUtf8Offset(sourceFile, nameNode.getStart(sourceFile)));
        memberAccessesByFile.set(fileName, starts);
      }
      ts.forEachChild(node, visitExternalNameAccess);
    };
    visitExternalNameAccess(sourceFile);
  }
  for (const [fileName, starts] of memberAccessesByFile) {
    memberAccessesByFile.set(
      fileName,
      [...new Set(starts)].sort((left, right) => left - right),
    );
  }

  const candidates = new Set<ts.Symbol>();
  const isExternalValue = (expression: ts.Expression): boolean => {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      return symbol !== undefined && candidates.has(symbol);
    }
    const access = staticAccess(expression);
    if (access && rootPropertySet.has(access.name)) return true;
    if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      return isExternalValue(expression.expression);
    }
    if (ts.isAwaitExpression(expression)) {
      return isExternalValue(expression.expression);
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      return isExternalValue(expression.expression);
    }
    if (ts.isConditionalExpression(expression)) {
      return (
        isExternalValue(expression.whenTrue) ||
        isExternalValue(expression.whenFalse)
      );
    }
    if (ts.isBinaryExpression(expression)) {
      return (
        isExternalValue(expression.left) || isExternalValue(expression.right)
      );
    }
    if (ts.isCommaListExpression(expression)) {
      return expression.elements.some(isExternalValue);
    }
    if (ts.isTaggedTemplateExpression(expression)) {
      return isExternalValue(expression.tag);
    }
    return false;
  };
  changed = true;
  while (changed) {
    changed = false;
    for (const sourceFile of sourceFiles) {
      const visitCandidate = (node: ts.Node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isExternalValue(node.initializer)
        ) {
          const symbol = symbolAt(node.name);
          if (symbol && !candidates.has(symbol)) {
            candidates.add(symbol);
            changed = true;
          }
        }
        ts.forEachChild(node, visitCandidate);
      };
      visitCandidate(sourceFile);
    }
  }
  const memberProperties = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const visitMember = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        isExternalValue(node.expression)
      ) {
        memberProperties.add(node.name.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        isExternalValue(node.expression)
      ) {
        memberProperties.add(node.argumentExpression.text);
      }
      ts.forEachChild(node, visitMember);
    };
    visitMember(sourceFile);
  }

  return {
    externalGlobals: [...externalGlobals].sort(),
    memberAccessesByFile,
    memberProperties: [...memberProperties].sort(),
    rootProperties,
  };
}

function isAssignmentOperator(kind: ts.SyntaxKind) {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

export function collectExternalOwnedMemberAccesses({
  checker,
  externalGlobalMemberAccesses = [],
  origins,
  sourceFile,
}: {
  checker: ts.TypeChecker;
  externalGlobalMemberAccesses?: readonly number[] | undefined;
  origins: RuntimeBoundaryDeclarationOrigins;
  sourceFile: ts.SourceFile;
}): number[] {
  const starts = new Set<number>(externalGlobalMemberAccesses);
  if (
    origins.files.size === 0 &&
    origins.moduleFiles.size === 0 &&
    origins.packageRoots.length === 0
  )
    return [...starts].sort((left, right) => left - right);
  const visitedInitializers = new Set<ts.Node>();
  const isBoundaryType = (type: ts.Type | undefined) =>
    type !== undefined &&
    typeOriginatesFromRuntimeBoundary(type, checker, origins, new Set());
  const hasBoundaryProperty = (type: ts.Type, name: string) =>
    symbolOriginatesFromRuntimeBoundary(
      checker.getPropertyOfType(type, name),
      origins,
    ) ||
    typeIdentityKeys(type).some((identity) =>
      origins.ownedProperties.get(identity)?.has(name),
    );
  const markKey = (key: ts.PropertyName | ts.BindingName) => {
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
      starts.add(toUtf8Offset(sourceFile, key.getStart(sourceFile)));
    }
  };
  function markContextualValue(
    expression: ts.Expression,
    expectedType: ts.Type,
    followedSymbols: Set<ts.Symbol>,
  ) {
    expression = unwrapExpression(expression);
    if (ts.isIdentifier(expression)) {
      let symbol = checker.getSymbolAtLocation(expression);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      if (!symbol || followedSymbols.has(symbol)) return;
      const nextSymbols = new Set(followedSymbols).add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        if (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          !visitedInitializers.has(declaration.initializer)
        ) {
          visitedInitializers.add(declaration.initializer);
          markContextualValue(
            declaration.initializer,
            expectedType,
            nextSymbols,
          );
        }
      }
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      markContextualValue(expression.whenTrue, expectedType, followedSymbols);
      markContextualValue(expression.whenFalse, expectedType, followedSymbols);
      return;
    }
    if (ts.isCallExpression(expression)) {
      const methodName = ts.isPropertyAccessExpression(expression.expression)
        ? expression.expression.name.text
        : null;
      if (methodName === "map" || methodName === "flatMap") {
        const elementType = checker.getIndexTypeOfType(
          expectedType,
          ts.IndexKind.Number,
        );
        const callback = expression.arguments[0];
        if (
          elementType &&
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          markFunctionReturns(
            callback,
            elementType,
            methodName === "flatMap" ? expectedType : undefined,
            followedSymbols,
          );
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const elementType = checker.getIndexTypeOfType(
        expectedType,
        ts.IndexKind.Number,
      );
      for (const element of expression.elements) {
        if (ts.isSpreadElement(element)) {
          markContextualValue(
            element.expression,
            expectedType,
            followedSymbols,
          );
        } else if (elementType) {
          markContextualValue(element, elementType, followedSymbols);
        }
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(expression)) return;
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        markContextualValue(property.expression, expectedType, followedSymbols);
        continue;
      }
      if (property.name) markKey(property.name);
      if (!ts.isPropertyAssignment(property)) continue;
      const name = getStaticPropertyName(property.name);
      const propertySymbol = name
        ? checker.getPropertyOfType(expectedType, name)
        : undefined;
      const propertyType = propertySymbol
        ? checker.getTypeOfSymbolAtLocation(propertySymbol, property.name)
        : undefined;
      if (propertyType) {
        markContextualValue(
          property.initializer,
          propertyType,
          followedSymbols,
        );
      }
    }
  }
  function markFunctionReturns(
    callback: ts.ArrowFunction | ts.FunctionExpression,
    expectedType: ts.Type,
    arrayExpectedType: ts.Type | undefined,
    followedSymbols: Set<ts.Symbol>,
  ) {
    const markReturn = (expression: ts.Expression) =>
      markContextualValue(
        expression,
        arrayExpectedType &&
          ts.isArrayLiteralExpression(unwrapExpression(expression))
          ? arrayExpectedType
          : expectedType,
        followedSymbols,
      );
    if (!ts.isBlock(callback.body)) {
      markReturn(callback.body);
      return;
    }
    const visitReturn = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) {
        markReturn(node.expression);
        return;
      }
      if (ts.isFunctionLike(node) && node !== callback) return;
      ts.forEachChild(node, visitReturn);
    };
    visitReturn(callback.body);
  }
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const contextualType = checker.getContextualType(node);
      const ownType = checker.getTypeAtLocation(node);
      const boundaryType =
        isBoundaryType(ownType) || isBoundaryType(contextualType);
      for (const property of node.properties) {
        if (!property.name) continue;
        const name = getStaticPropertyName(property.name);
        if (
          boundaryType ||
          (name !== null &&
            ((contextualType && hasBoundaryProperty(contextualType, name)) ||
              hasBoundaryProperty(ownType, name)))
        ) {
          markKey(property.name);
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const receiverType = checker.getTypeAtLocation(node.expression);
      if (
        isBoundaryType(receiverType) ||
        hasBoundaryProperty(receiverType, node.name.text)
      ) {
        starts.add(toUtf8Offset(sourceFile, node.name.getStart(sourceFile)));
      }
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      const receiverType = checker.getTypeAtLocation(node.parent);
      const key = node.propertyName ?? node.name;
      const name =
        ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
      if (
        isBoundaryType(receiverType) ||
        (name !== null && hasBoundaryProperty(receiverType, name))
      ) {
        markKey(key);
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isBoundaryType(checker.getTypeAtLocation(node.name))
    ) {
      markContextualValue(
        node.initializer,
        checker.getTypeAtLocation(node.name),
        new Set(),
      );
    } else if (ts.isCallExpression(node)) {
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
        if (boundaryCall || isBoundaryType(parameterType)) {
          markContextualValue(argument, parameterType, new Set());
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isBoundaryType(checker.getTypeAtLocation(node.left))
    ) {
      markContextualValue(
        node.right,
        checker.getTypeAtLocation(node.left),
        new Set(),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...starts].sort((left, right) => left - right);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function getStaticPropertyName(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function toUtf8Offset(sourceFile: ts.SourceFile, offset: number) {
  return Buffer.byteLength(sourceFile.text.slice(0, offset));
}

function typeOriginatesFromRuntimeBoundary(
  type: ts.Type,
  checker: ts.TypeChecker,
  origins: RuntimeBoundaryDeclarationOrigins,
  seen: Set<ts.Type>,
): boolean {
  if (seen.has(type)) return false;
  seen.add(type);

  if (
    typeIdentityKeys(type).some((identity) =>
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

function symbolOriginatesFromRuntimeBoundary(
  symbol: ts.Symbol | undefined,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  return (symbol?.declarations ?? []).some((declaration) => {
    const fileName = path.normalize(declaration.getSourceFile().fileName);
    if (origins.defaultLibraryFiles.has(fileName)) return false;
    return (
      origins.files.has(fileName) ||
      origins.moduleFiles.has(fileName) ||
      origins.packageRoots.some(
        (packageRoot) =>
          fileName === packageRoot ||
          fileName.startsWith(`${packageRoot}${path.sep}`),
      )
    );
  });
}

function expressionOriginatesFromExternalValue(
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

function declarationOriginatesFromRuntimeBoundary(
  declaration: ts.Declaration | undefined,
  origins: RuntimeBoundaryDeclarationOrigins,
) {
  if (!declaration) return false;
  const fileName = path.normalize(declaration.getSourceFile().fileName);
  if (origins.defaultLibraryFiles.has(fileName)) return false;
  return (
    origins.moduleFiles.has(fileName) ||
    origins.files.has(fileName) ||
    origins.packageRoots.some(
      (packageRoot) =>
        fileName === packageRoot ||
        fileName.startsWith(`${packageRoot}${path.sep}`),
    )
  );
}

function isTypeReference(type: ts.Type): type is ts.TypeReference {
  return (type.flags & ts.TypeFlags.Object) !== 0 && "target" in type;
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
