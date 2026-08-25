import ts from "@typescript/typescript6";

import { buildObjectLiteralBrandDeclaration } from "../docs";
import { referencesForTemplate } from "../type-render/index";
import type { ClosureDocRenderContext } from "../type-render/index";
import type { ClosureAnnotation, ClosureTypeDeclaration } from "../../types";
import {
  collectDynamicallyKeyedSymbols,
  collectExportedSymbols,
  collectImportedSymbols,
  enclosingCallArgument,
  enclosingReturnFunction,
  expressionRootIdentifier,
  isExportedFunctionLike,
  isGlobalSymbol,
  objectLiteralBindingName,
  objectLiteralBindingSymbol,
  objectLiteralVariableDeclaration,
  outermostWrapper,
  resolveSymbol,
  symbolDeclaresImport,
  unwrapExpression,
  variableStatementHasExport,
} from "./object-literals";

export function collectObjectLiteralBrands(
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
