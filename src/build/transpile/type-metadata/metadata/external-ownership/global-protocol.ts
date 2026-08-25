import path from "path";

import ts from "@typescript/typescript6";

import {
  getStaticPropertyName,
  toUtf8Offset,
  unwrapExpression,
} from "./shared";

export interface ExternalGlobalProtocolEvidence {
  externalGlobals: readonly string[];
  memberAccessesByFile: ReadonlyMap<string, readonly number[]>;
  memberProperties: readonly string[];
  rootProperties: readonly string[];
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
