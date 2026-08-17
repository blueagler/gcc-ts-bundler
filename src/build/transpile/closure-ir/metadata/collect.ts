import ts from "@typescript/typescript6";

import { transpileDecoratedSource } from "../decorators";
import {
  buildClassMemberDoc,
  buildClassJsDoc,
  buildFunctionLikeDoc,
  buildFunctionJsDoc,
  buildInterfaceDeclarationSnippet,
  buildObjectLiteralBrandDeclaration,
  buildObjectMemberDoc,
  buildTypeAliasDeclarationSnippet,
  buildVariableJsDoc,
  getClassMemberName,
  getObjectPropertyName,
  hasStaticModifier,
} from "./docs";
import {
  canonicalSymbolId,
  createClosureDocRenderContext,
  referencesForTemplate,
} from "./type-render";
import type { ClosureDocRenderContext } from "./type-render";
import { buildEnumDeclarationMetadata, isErasableConstEnum } from "./enums";
import type {
  ClosureAnnotation,
  ClosureEnumDeclaration,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
} from "../types";
import type { ClosureIrFileFeatures } from "./scan";

export function collectClosureIrFileMetadata({
  classOnlyInterfaceSymbolIds,
  compilerOptions,
  checker,
  features,
  sourceFile,
  unsafeEnumSymbols,
}: {
  classOnlyInterfaceSymbolIds: ReadonlySet<string>;
  compilerOptions: ts.CompilerOptions;
  checker: ts.TypeChecker;
  features: ClosureIrFileFeatures;
  sourceFile: ts.SourceFile;
  unsafeEnumSymbols: Set<ts.Symbol>;
}): { diagnostics: ts.Diagnostic[]; file: ClosureTypeMetadataFile } {
  const diagnostics: ts.Diagnostic[] = [];
  const renderContext = createClosureDocRenderContext(sourceFile);
  const explicitTypeDeclarations = features.hasTypeDeclarations
    ? collectTypeDeclarationsForSourceFile(
        sourceFile,
        checker,
        renderContext,
        classOnlyInterfaceSymbolIds,
      )
    : [];
  const brandMetadata = collectObjectLiteralBrands(
    sourceFile,
    checker,
    renderContext,
  );
  const annotations = [
    ...(features.hasTopLevelDocs
      ? collectClosureDocsForSourceFile(
          sourceFile,
          checker,
          features,
          renderContext,
        )
      : []),
    ...brandMetadata.annotations,
  ];
  const declarations = [
    ...explicitTypeDeclarations,
    ...renderContext.typeDeclarations,
    ...brandMetadata.declarations,
  ];
  const { enumDeclarations, erasedConstEnums } = features.hasEnumDeclarations
    ? collectEnumDeclarationsForSourceFile(
        sourceFile,
        checker,
        unsafeEnumSymbols,
        compilerOptions,
      )
    : { enumDeclarations: [], erasedConstEnums: [] };
  for (const enumDeclaration of enumDeclarations) {
    if (!renderContext.symbolsById.has(enumDeclaration.symbolId)) {
      renderContext.symbolsById.set(enumDeclaration.symbolId, {
        diagnosticName: enumDeclaration.bindingName,
        id: enumDeclaration.symbolId,
        kind: "runtime",
        localName: enumDeclaration.bindingName,
      });
    }
  }
  const decoratedOutputText = features.hasDecorators
    ? collectDecoratedOutputText({
        compilerOptions,
        diagnostics,
        fileName: sourceFile.fileName,
        sourceText: sourceFile.getFullText(),
      })
    : undefined;

  return {
    diagnostics,
    file: {
      annotations,
      declarations,
      decoratedOutputText,
      diagnostics: renderContext.diagnostics,
      enums: enumDeclarations,
      erasedConstEnums,
      filePath: sourceFile.fileName,
      sourceFilePath: sourceFile.fileName,
      symbols: [...renderContext.symbolsById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    },
  };
}

function collectObjectLiteralBrands(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  context: ClosureDocRenderContext,
) {
  const declarations: ClosureTypeDeclaration[] = [];
  const annotations: ClosureAnnotation[] = [];
  const importedSymbols = collectImportedSymbols(sourceFile, checker);
  const exportedSymbols = collectExportedSymbols(sourceFile, checker);
  const dynamicallyKeyedSymbols = collectDynamicallyKeyedSymbols(
    sourceFile,
    checker,
  );
  const brandNameByShape = new Map<string, string>();
  const declaredBrandNames = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = objectLiteralBrandKeys(node);
      if (
        keys &&
        keys.length > 0 &&
        isBrandableObjectLiteral(node, {
          checker,
          dynamicallyKeyedSymbols,
          exportedSymbols,
          importedSymbols,
          sourceFile,
        })
      ) {
        const sortedKeys = [...keys].sort();
        const shape = sortedKeys.join("\0");
        let brandName = brandNameByShape.get(shape);
        if (!brandName) {
          brandName = `Brand$${brandNameByShape.size}`;
          brandNameByShape.set(shape, brandName);
        }
        if (!declaredBrandNames.has(brandName)) {
          declaredBrandNames.add(brandName);
          declarations.push(
            buildObjectLiteralBrandDeclaration({
              brandName,
              checker,
              context,
              keys: sortedKeys,
              literal: node,
            }),
          );
        }
        const bindingName = objectLiteralBindingName(node);
        if (bindingName) {
          const template = brandTypeAnnotationTemplate(brandName, context);
          annotations.push({
            references: referencesForTemplate(template, context),
            target: { bindingName, kind: "binding" },
            template,
            typeBearing: true,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { annotations, declarations };
}

function objectLiteralBrandKeys(literal: ts.ObjectLiteralExpression) {
  const keys: string[] = [];
  for (const member of literal.properties) {
    if (ts.isSpreadAssignment(member)) {
      return null;
    }
    if (
      !(
        ts.isPropertyAssignment(member) ||
        ts.isShorthandPropertyAssignment(member) ||
        ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)
      )
    ) {
      return null;
    }
    const name = member.name;
    if (!name || ts.isComputedPropertyName(name)) {
      return null;
    }
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
      keys.push(name.text);
      continue;
    }
    return null;
  }
  return keys;
}

function isBrandableObjectLiteral(
  literal: ts.ObjectLiteralExpression,
  input: {
    checker: ts.TypeChecker;
    dynamicallyKeyedSymbols: ReadonlySet<ts.Symbol>;
    exportedSymbols: ReadonlySet<ts.Symbol>;
    importedSymbols: ReadonlySet<ts.Symbol>;
    sourceFile: ts.SourceFile;
  },
) {
  if (isJsxPropsObject(literal)) {
    return false;
  }
  if (
    isArgumentToImportedCallee(literal, input.checker, input.importedSymbols)
  ) {
    return false;
  }
  if (
    isReturnedFromExportedFunction(
      literal,
      input.checker,
      input.exportedSymbols,
    )
  ) {
    return false;
  }
  if (
    isExportedBindingInitializer(literal, input.checker, input.exportedSymbols)
  ) {
    return false;
  }
  if (
    isAssignedOntoImportedOrGlobal(
      literal,
      input.checker,
      input.sourceFile,
      input.importedSymbols,
    )
  ) {
    return false;
  }
  const bindingSymbol = objectLiteralBindingSymbol(literal, input.checker);
  if (bindingSymbol && input.dynamicallyKeyedSymbols.has(bindingSymbol)) {
    return false;
  }
  if (!bindingSymbol && objectLiteralBindingName(literal)) {
    return false;
  }
  return true;
}

function isJsxPropsObject(literal: ts.ObjectLiteralExpression) {
  for (
    let ancestor: ts.Node | undefined = literal.parent;
    ancestor;
    ancestor = ancestor.parent
  ) {
    if (
      ts.isJsxAttributes(ancestor) ||
      ts.isJsxSpreadAttribute(ancestor) ||
      ts.isJsxOpeningElement(ancestor) ||
      ts.isJsxSelfClosingElement(ancestor)
    ) {
      return true;
    }
  }
  const call = enclosingCallArgument(literal);
  return !!call && isJsxCallee(call.expression) && call.argumentIndex === 1;
}

const JSX_CALLEE_NAMES = new Set([
  "_jsx",
  "_jsxs",
  "jsx",
  "jsxs",
  "jsxDEV",
  "jsxsDEV",
  "createElement",
]);

function isJsxCallee(expression: ts.Expression) {
  const name = calleePropertyName(expression);
  return name !== null && JSX_CALLEE_NAMES.has(name);
}

function calleePropertyName(expression: ts.Expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) {
    return unwrapped.text;
  }
  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.name)
  ) {
    return unwrapped.name.text;
  }
  if (
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression &&
    ts.isStringLiteralLike(unwrapped.argumentExpression)
  ) {
    return unwrapped.argumentExpression.text;
  }
  return null;
}

function isArgumentToImportedCallee(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  importedSymbols: ReadonlySet<ts.Symbol>,
) {
  const call = enclosingCallArgument(literal);
  if (!call) {
    return false;
  }
  const calleeRoot = expressionRootIdentifier(call.expression);
  if (!calleeRoot) {
    return true;
  }
  const symbol = resolveSymbol(checker, calleeRoot);
  if (!symbol) {
    return true;
  }
  return importedSymbols.has(symbol) || symbolDeclaresImport(symbol);
}

function isReturnedFromExportedFunction(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
) {
  const returnedFrom = enclosingReturnFunction(literal);
  if (!returnedFrom) {
    return false;
  }
  return isExportedFunctionLike(returnedFrom, checker, exportedSymbols);
}

function isExportedBindingInitializer(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
) {
  const wrapped = outermostWrapper(literal);
  if (wrapped.parent && ts.isExportAssignment(wrapped.parent)) {
    return true;
  }
  const declaration = objectLiteralVariableDeclaration(literal);
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return false;
  }
  if (variableStatementHasExport(declaration)) {
    return true;
  }
  const symbol = resolveSymbol(checker, declaration.name);
  return !!symbol && exportedSymbols.has(symbol);
}

function isAssignedOntoImportedOrGlobal(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  importedSymbols: ReadonlySet<ts.Symbol>,
) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (
    !parent ||
    !ts.isBinaryExpression(parent) ||
    parent.right !== wrapped ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return false;
  }
  if (ts.isIdentifier(parent.left)) {
    return false;
  }
  const root = expressionRootIdentifier(parent.left);
  if (!root) {
    return true;
  }
  const symbol = resolveSymbol(checker, root);
  if (!symbol) {
    return true;
  }
  if (importedSymbols.has(symbol) || symbolDeclaresImport(symbol)) {
    return true;
  }
  return isGlobalSymbol(symbol, sourceFile);
}

function objectLiteralBindingName(literal: ts.ObjectLiteralExpression) {
  const declaration = objectLiteralVariableDeclaration(literal);
  if (
    !declaration ||
    !ts.isIdentifier(declaration.name) ||
    !isConstOrLetDeclaration(declaration)
  ) {
    return null;
  }
  return declaration.name.text;
}

function objectLiteralBindingSymbol(
  literal: ts.ObjectLiteralExpression,
  checker: ts.TypeChecker,
) {
  const declaration = objectLiteralVariableDeclaration(literal);
  if (!declaration || !ts.isIdentifier(declaration.name)) {
    return null;
  }
  return resolveSymbol(checker, declaration.name);
}

function objectLiteralVariableDeclaration(literal: ts.ObjectLiteralExpression) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === wrapped
  ) {
    return parent;
  }
  return null;
}

function isConstOrLetDeclaration(declaration: ts.VariableDeclaration) {
  const flags = ts.getCombinedNodeFlags(declaration);
  return (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Let) !== 0;
}

function variableStatementHasExport(declaration: ts.VariableDeclaration) {
  const statement = declaration.parent?.parent;
  if (statement === undefined) {
    return false;
  }
  if (ts.isVariableStatement(statement) === false) {
    return false;
  }
  const modifiers = ts.getModifiers(statement);
  if (modifiers === undefined) {
    return false;
  }
  return modifiers.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function enclosingCallArgument(literal: ts.ObjectLiteralExpression) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (!parent || !(ts.isCallExpression(parent) || ts.isNewExpression(parent))) {
    return null;
  }
  const argumentIndex =
    parent.arguments?.findIndex((argument) => argument === wrapped) ?? -1;
  if (argumentIndex < 0) {
    return null;
  }
  return { argumentIndex, expression: parent.expression };
}

function enclosingReturnFunction(literal: ts.ObjectLiteralExpression) {
  const wrapped = outermostWrapper(literal);
  const parent = wrapped.parent;
  if (!parent) {
    return null;
  }
  if (ts.isReturnStatement(parent)) {
    return enclosingFunctionLike(parent);
  }
  if (ts.isArrowFunction(parent) && parent.body === wrapped) {
    return parent;
  }
  return null;
}

function enclosingFunctionLike(node: ts.Node) {
  for (let current = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
  }
  return null;
}

function isExportedFunctionLike(
  fn:
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  checker: ts.TypeChecker,
  exportedSymbols: ReadonlySet<ts.Symbol>,
) {
  if (
    ts.canHaveModifiers(fn) &&
    (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Export) !== 0
  ) {
    return true;
  }
  if (ts.isFunctionDeclaration(fn) && fn.name) {
    const symbol = resolveSymbol(checker, fn.name);
    if (symbol && exportedSymbols.has(symbol)) {
      return true;
    }
  }
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    if (variableStatementHasExport(parent)) {
      return true;
    }
    const symbol = resolveSymbol(checker, parent.name);
    if (symbol && exportedSymbols.has(symbol)) {
      return true;
    }
  }
  return ts.isExportAssignment(parent);
}

function collectImportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const add = (name: ts.Identifier | undefined) => {
    if (!name) {
      return;
    }
    const symbol = resolveSymbol(checker, name);
    if (symbol) {
      symbols.add(symbol);
    }
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      add(statement.name);
      continue;
    }
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    add(statement.importClause.name);
    const bindings = statement.importClause.namedBindings;
    if (!bindings) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      add(bindings.name);
      continue;
    }
    for (const element of bindings.elements) {
      add(element.name);
    }
  }
  return symbols;
}

function collectExportedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return symbols;
  }
  let exported: readonly ts.Symbol[] = [];
  try {
    exported = checker.getExportsOfModule(moduleSymbol);
  } catch {
    return symbols;
  }
  for (const symbol of exported) {
    symbols.add(symbol);
    const resolved = resolveAliasedSymbol(checker, symbol);
    if (resolved) {
      symbols.add(resolved);
    }
  }
  return symbols;
}

function collectDynamicallyKeyedSymbols(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
) {
  const symbols = new Set<ts.Symbol>();
  const visit = (node: ts.Node) => {
    if (ts.isElementAccessExpression(node)) {
      const root = unwrapExpression(node.expression);
      if (ts.isIdentifier(root)) {
        const symbol = resolveSymbol(checker, root);
        if (symbol) {
          symbols.add(symbol);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols;
}

function brandTypeAnnotationTemplate(
  brandName: string,
  context: ClosureDocRenderContext,
) {
  const symbolId = context.symbolIdByDeclaredName.get(brandName);
  let typeName = brandName;
  if (symbolId) {
    const token = `__GCC_TYPE_${context.nextReferenceId}__`;
    context.nextReferenceId += 1;
    context.referencesByToken.set(token, { symbolId, token });
    typeName = token;
  }
  return `/** @type {!${typeName}} */\n`;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isWrapperExpression(node: ts.Node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

function outermostWrapper(literal: ts.ObjectLiteralExpression) {
  let current: ts.Node = literal;
  while (current.parent && isWrapperExpression(current.parent)) {
    const parent = current.parent;
    if (
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        ts.isTypeAssertionExpression(parent) ||
        ts.isSatisfiesExpression(parent) ||
        ts.isNonNullExpression(parent)) &&
      parent.expression === current
    ) {
      current = parent;
      continue;
    }
    break;
  }
  return current;
}

function expressionRootIdentifier(expression: ts.Expression) {
  let current = unwrapExpression(expression);
  while (true) {
    if (ts.isIdentifier(current)) {
      return current;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    if (ts.isCallExpression(current)) {
      current = unwrapExpression(current.expression);
      continue;
    }
    return null;
  }
}

function resolveSymbol(checker: ts.TypeChecker, node: ts.Node) {
  try {
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      return null;
    }
    return resolveAliasedSymbol(checker, symbol) ?? symbol;
  } catch {
    return null;
  }
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol) {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol;
  }
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return null;
  }
}

function symbolDeclaresImport(symbol: ts.Symbol) {
  const declarations = [
    ...(symbol.getDeclarations() ?? []),
    ...(symbol.declarations ?? []),
  ];
  return declarations.some(
    (declaration) =>
      ts.isImportSpecifier(declaration) ||
      ts.isImportClause(declaration) ||
      ts.isNamespaceImport(declaration) ||
      ts.isImportEqualsDeclaration(declaration),
  );
}

function isGlobalSymbol(symbol: ts.Symbol, sourceFile: ts.SourceFile) {
  const declarations = symbol.getDeclarations() ?? symbol.declarations;
  if (!declarations || declarations.length === 0) {
    return true;
  }
  return declarations.every(
    (declaration) =>
      declaration.getSourceFile() !== sourceFile ||
      sourceFile.isDeclarationFile,
  );
}

function collectTypeDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  renderContext: ReturnType<typeof createClosureDocRenderContext>,
  classOnlyInterfaceSymbolIds: ReadonlySet<string>,
) {
  const typeDeclarations: ClosureTypeDeclaration[] = [];
  // One synthesised declaration per *merged symbol*, not per declaration site.
  // TypeScript lets a type be reopened (`declare interface Reopen` twice, an
  // interface merged with a namespace, a class merged with an interface), and
  // emitting a `function Name() {}` record per site produced duplicates that
  // Closure rejects outright with
  // JSC_BLOCK_SCOPED_DECL_MULTIPLY_DECLARED_ERROR. The checker already gives
  // us one symbol for all the sites, and `canonicalSymbolId` already reduces
  // that symbol to a stable identity, so the merge is decided by the same
  // identity the rest of the IR is keyed on rather than by name matching.
  const seenSymbolIds = new Set<string>();
  const isFirstDeclarationOfSymbol = (declaration: ts.NamedDeclaration) => {
    const symbol = declaration.name
      ? checker.getSymbolAtLocation(declaration.name)
      : undefined;
    if (!symbol) {
      return true;
    }
    const id = canonicalSymbolId(symbol);
    if (seenSymbolIds.has(id)) {
      return false;
    }
    seenSymbolIds.add(id);
    return true;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement)) {
      if (isFirstDeclarationOfSymbol(statement)) {
        typeDeclarations.push(
          classifyInterfaceDeclarationSnippet(
            buildInterfaceDeclarationSnippet(statement, checker, renderContext),
            statement,
            checker,
            classOnlyInterfaceSymbolIds,
          ),
        );
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (isFirstDeclarationOfSymbol(statement)) {
        typeDeclarations.push(
          buildTypeAliasDeclarationSnippet(statement, checker, renderContext),
        );
      }
    }
  }

  return typeDeclarations;
}

function collectClosureDocsForSourceFile(
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

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const jsdoc = buildFunctionJsDoc(node, checker, renderContext);
        if (jsdoc) {
          pushAnnotation(jsdoc, {
            bindingName: node.name.text,
            kind: "binding",
          });
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (shouldAnnotateTypeScript || shouldAnnotateJs) {
        const jsdoc = buildVariableJsDoc({
          checker,
          context: renderContext,
          initializer: node.initializer,
          typeNode: node.type,
        });
        if (jsdoc) {
          pushAnnotation(jsdoc, {
            bindingName: node.name.text,
            kind: "binding",
          });
        }
        if (
          node.initializer &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          for (const member of node.initializer.properties) {
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
                ownerBindingName: node.name.text,
                static: false,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
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
            static: hasStaticModifier(member),
          });
        }
      }
      ts.forEachChild(node, visit);
      return;
    }

    if (
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      !ts.isClassDeclaration(node.parent) &&
      !ts.isClassExpression(node.parent) &&
      !ts.isObjectLiteralExpression(node.parent) &&
      shouldAnnotateTypeScript
    ) {
      const name =
        "name" in node && node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : null;
      if (name) {
        const jsdoc = buildFunctionLikeDoc(node, checker, renderContext);
        if (jsdoc) {
          pushAnnotation(jsdoc, { bindingName: name, kind: "binding" });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return annotations;
}

function classifyInterfaceDeclarationSnippet(
  declaration: ClosureTypeDeclaration,
  statement: ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  classOnlyInterfaceSymbolIds: ReadonlySet<string>,
): ClosureTypeDeclaration {
  const symbol = checker.getSymbolAtLocation(statement.name);
  if (!symbol || !classOnlyInterfaceSymbolIds.has(canonicalSymbolId(symbol))) {
    return declaration;
  }
  return {
    ...declaration,
    template: declaration.template.replace(" * @record\n", " * @interface\n"),
  };
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

export function collectClassOnlyInterfaceSymbolIds(
  program: ts.Program,
  checker: ts.TypeChecker,
) {
  const implementedByAnnotatedClass = new Set<string>();
  const objectLiteralSatisfied = new Set<string>();

  const addInterfaceIdsFromType = (
    type: ts.Type | undefined,
    into: Set<string>,
  ) => {
    if (!type) {
      return;
    }
    try {
      if (type.isUnion()) {
        for (const part of type.types) {
          addInterfaceIdsFromType(part, into);
        }
        return;
      }
      const symbol = type.aliasSymbol ?? type.getSymbol();
      if (!symbol) {
        return;
      }
      const resolved =
        symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
      if (resolved.flags & ts.SymbolFlags.Interface) {
        into.add(canonicalSymbolId(resolved));
      }
    } catch {
      // Checker failure means we cannot prove class-only; keep @record.
    }
  };

  const isAnnotatedClass = (
    node: ts.ClassDeclaration,
    sourceFile: ts.SourceFile,
  ) =>
    Boolean(node.name) &&
    !sourceFile.isDeclarationFile &&
    (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) === 0;

  for (const sourceFile of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sourceFile)) {
      continue;
    }
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && isAnnotatedClass(node, sourceFile)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
            continue;
          }
          for (const typeNode of clause.types) {
            try {
              addInterfaceIdsFromType(
                checker.getTypeAtLocation(typeNode),
                implementedByAnnotatedClass,
              );
            } catch {
              // keep @record
            }
          }
        }
      }

      if (ts.isObjectLiteralExpression(node)) {
        try {
          addInterfaceIdsFromType(
            checker.getContextualType(node),
            objectLiteralSatisfied,
          );
        } catch {
          // keep @record
        }
      }

      if (
        (ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) ||
          ts.isSatisfiesExpression(node)) &&
        ts.isObjectLiteralExpression(node.expression)
      ) {
        try {
          addInterfaceIdsFromType(
            checker.getTypeFromTypeNode(node.type),
            objectLiteralSatisfied,
          );
        } catch {
          // keep @record
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const classOnly = new Set<string>();
  for (const id of implementedByAnnotatedClass) {
    if (!objectLiteralSatisfied.has(id)) {
      classOnly.add(id);
    }
  }
  return classOnly;
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

function collectEnumDeclarationsForSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  unsafeEnumSymbols: Set<ts.Symbol>,
  compilerOptions: ts.CompilerOptions,
) {
  const enumDeclarations: ClosureEnumDeclaration[] = [];
  const erasedConstEnums: string[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isEnumDeclaration(statement)) {
      continue;
    }

    if (isErasableConstEnum(statement, compilerOptions)) {
      // Name only: there is nothing to emit. The declaration is dropped from
      // the module and every read was already inlined from the TypeScript AST.
      erasedConstEnums.push(statement.name.text);
      continue;
    }

    const enumDeclaration = buildEnumDeclarationMetadata(
      statement,
      checker,
      unsafeEnumSymbols,
      compilerOptions,
    );
    if (enumDeclaration) {
      enumDeclarations.push(enumDeclaration);
    }
  }

  return { enumDeclarations, erasedConstEnums };
}

function collectDecoratedOutputText({
  compilerOptions,
  diagnostics,
  fileName,
  sourceText,
}: {
  compilerOptions: ts.CompilerOptions;
  diagnostics: ts.Diagnostic[];
  fileName: string;
  sourceText: string;
}) {
  const transpiled = transpileDecoratedSource({
    compilerOptions,
    fileName,
    sourceText,
  });
  diagnostics.push(
    ...(transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
  );
  return transpiled.outputText;
}

function hasTypeBearingTag(template: string) {
  return /@(constructor|enum|extends|implements|param|return|template|this|type|typedef)\b/u.test(
    template,
  );
}
