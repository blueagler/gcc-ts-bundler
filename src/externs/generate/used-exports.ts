import path from "node:path";
import ts from "@typescript/typescript6";

import type { ExternAnalysisContext } from "../context";
import { isProjectAppSourceFile, resolveAliasedSymbol } from "../shared";
import type { ModuleSeed } from "../typed-render";
import { findModuleSymbol } from "../typed-render/surface";

/** Select export roots, never members of the objects or types they expose. */
export function collectUsedExportsByModule(
  analysis: ExternAnalysisContext,
  modules: readonly ModuleSeed[],
): Map<string, Set<string>> {
  const selected = new Map<string, Set<string>>();
  if (modules.length === 0) return selected;
  const { checker, program } = analysis;
  const bySymbol = new Map<ts.Symbol, Set<string>[]>();
  const byFile = new Map<string, Set<string>[]>();
  const exportEquals = new Set<Set<string>>();
  const resolutionCache = ts.createModuleResolutionCache(
    analysis.projectRoot,
    (fileName) =>
      ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
    analysis.compilerOptions,
  );
  const fileKey = (fileName: string) => {
    const absolute = path.resolve(fileName);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  };
  const index = <K>(map: Map<K, Set<string>[]>, key: K, names: Set<string>) => {
    const existing = map.get(key);
    if (existing) existing.push(names);
    else map.set(key, [names]);
  };
  for (const module of modules) {
    const names = new Set<string>();
    selected.set(module.specifier, names);
    const sourceFile = program.getSourceFile(
      path.resolve(module.declarationEntry),
    );
    const symbol = sourceFile && findModuleSymbol(module, sourceFile, checker);
    if (symbol) {
      index(bySymbol, resolveAliasedSymbol(symbol, checker) ?? symbol, names);
      const assignment = symbol.exports?.get(
        ts.InternalSymbolName.ExportEquals,
      );
      if (assignment) {
        exportEquals.add(names);
        const target = resolveAliasedSymbol(assignment, checker);
        if (target) index(bySymbol, target, names);
      }
    }
    // Several ambient modules can share one declaration file: the file alone
    // does not establish their identity.
    if (!module.ambientModuleName && !module.globalSurface) {
      index(byFile, fileKey(module.declarationEntry), names);
    }
  }
  const targetsByLiteral = new Map<ts.StringLiteralLike, Set<string>[]>();
  const targetsFor = (literal: ts.StringLiteralLike): Set<string>[] => {
    const cached = targetsByLiteral.get(literal);
    if (cached) return cached;
    const targets = new Set<Set<string>>();
    const direct = selected.get(literal.text);
    const symbol = resolveAliasedSymbol(
      checker.getSymbolAtLocation(literal),
      checker,
    );
    if (symbol) {
      for (const names of bySymbol.get(symbol) ?? []) targets.add(names);
    }
    if (!symbol?.declarations?.length) {
      const resolved = ts.resolveModuleName(
        literal.text,
        literal.getSourceFile().fileName,
        analysis.compilerOptions,
        ts.sys,
        resolutionCache,
      ).resolvedModule;
      if (resolved) {
        for (const names of byFile.get(fileKey(resolved.resolvedFileName)) ??
          []) {
          targets.add(names);
        }
        const sourceFile = program.getSourceFile(resolved.resolvedFileName);
        const resolvedSymbol =
          sourceFile && checker.getSymbolAtLocation(sourceFile);
        if (resolvedSymbol) {
          for (const names of bySymbol.get(resolvedSymbol) ?? [])
            targets.add(names);
        }
      }
    }
    // A spelling is not a declaration origin: nested dependency versions can
    // resolve it differently. Without an identity match, retain the configured
    // boundary whole instead of claiming that its export roots were proven.
    if (direct && !targets.has(direct)) {
      direct.add("*");
      targets.add(direct);
    }
    const result = [...targets];
    targetsByLiteral.set(literal, result);
    return result;
  };
  const add = (targets: readonly Set<string>[], name: string) => {
    for (const names of targets) names.add(name);
  };
  // Only namespace-import symbols can contribute identifier uses below.
  // Index their spellings without asking the checker to resolve unrelated
  // identifiers. Include declaration files and ambient module bodies because
  // namespace bindings can also be exposed through another module's exports.
  const namespaceNames = new Set<string>();
  const indexNamespaceNames = (node: ts.Node): void => {
    if (ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        if (ts.isImportDeclaration(statement)) {
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings))
            namespaceNames.add(bindings.name.text);
        } else if (ts.isModuleDeclaration(statement)) {
          indexNamespaceNames(statement);
        }
      }
    } else if (ts.isModuleDeclaration(node) && node.body) {
      indexNamespaceNames(node.body);
    }
  };
  for (const sourceFile of program.getSourceFiles())
    indexNamespaceNames(sourceFile);
  const namespaceBindings = new Map<ts.Symbol, Set<string>[]>();
  const namespaceTargets = (symbol: ts.Symbol): Set<string>[] | undefined => {
    const cached = namespaceBindings.get(symbol);
    if (cached) return cached;
    const declaration = symbol.declarations?.find(ts.isNamespaceImport);
    if (!declaration) return undefined;
    const importDeclaration = declaration.parent.parent;
    const targets =
      importDeclaration &&
      ts.isImportDeclaration(importDeclaration) &&
      ts.isStringLiteralLike(importDeclaration.moduleSpecifier)
        ? targetsFor(importDeclaration.moduleSpecifier)
        : [];
    namespaceBindings.set(symbol, targets);
    return targets;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (!clause) return;
      const targets = targetsFor(node.moduleSpecifier);
      if (clause?.name) {
        for (const names of targets)
          names.add(exportEquals.has(names) ? "export=" : "default");
      }
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          add(targets, (element.propertyName ?? element.name).text);
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        const bindingSymbol = checker.getSymbolAtLocation(bindings.name);
        if (!bindingSymbol?.declarations?.includes(bindings)) add(targets, "*");
        // export= is an object/function/class contract, not a list of ESM
        // roots. Keep it whole even when a namespace accesses one member.
        for (const names of targets)
          if (exportEquals.has(names)) names.add("export=");
      }
      return; // Binding declarations are not namespace escapes.
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const targets = targetsFor(node.moduleSpecifier);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements)
          add(targets, (element.propertyName ?? element.name).text);
      } else add(targets, "*");
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(targetsFor(node.moduleReference.expression), "*");
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isRequire(node.expression, checker))
    ) {
      // Promise flow and CommonJS interop are deliberately not a dataflow engine.
      add(targetsFor(node.arguments[0]), "*");
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      const targets = targetsFor(node.argument.literal);
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier))
        qualifier = qualifier.left;
      add(targets, qualifier?.text ?? "*");
    }
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isLocalExport =
        ts.isExportSpecifier(parent) &&
        (parent.propertyName ?? parent.name) === node;
      // Export-specifier lookup can follow aliases whose spelling differs
      // from the namespace binding. All other candidates still need semantic
      // lookup: a matching spelling alone cannot rule out lexical shadowing.
      if (namespaceNames.has(node.text) || isLocalExport) {
        const symbol =
          ts.isShorthandPropertyAssignment(parent) && parent.name === node
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : isLocalExport
              ? checker.getExportSpecifierLocalTargetSymbol(parent)
              : checker.getSymbolAtLocation(node);
        if (symbol) {
          const targets = namespaceTargets(symbol);
          if (targets && targets.length > 0) {
            const names = namespaceUse(node, checker);
            if (names) for (const name of names) add(targets, name);
            else add(targets, "*");
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  const appEntries = new Set(analysis.appEntryFiles.map(fileKey));
  // Include application modules imported by an entry, not only the entry's
  // own imports. A supplied TypeWorld can contain additional application roots;
  // keeping their uses is conservative.
  for (const sourceFile of program.getSourceFiles()) {
    if (
      !sourceFile.isDeclarationFile &&
      (appEntries.has(fileKey(sourceFile.fileName)) ||
        isProjectAppSourceFile(sourceFile.fileName, analysis.projectRoot))
    )
      visit(sourceFile);
  }
  return selected;
}

function isRequire(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== "require")
    return false;
  const symbol = checker.getSymbolAtLocation(expression);
  // An unresolved global require is common in JS inputs without Node typings.
  // Lexical parameters, variables and imported names are not that global.
  return (
    !symbol?.declarations?.length ||
    symbol.declarations.every((declaration) => {
      const sourceFile = declaration.getSourceFile();
      if (!sourceFile.isDeclarationFile) return false;
      if (!ts.isExternalModule(sourceFile)) return true;
      for (
        let parent: ts.Node | undefined = declaration.parent;
        parent;
        parent = parent.parent
      ) {
        if (
          ts.isModuleDeclaration(parent) &&
          (parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0
        )
          return true;
      }
      return false;
    })
  );
}

function namespaceUse(
  node: ts.Identifier,
  checker: ts.TypeChecker,
): string[] | undefined {
  let expression: ts.Node = node;
  while (
    ts.isParenthesizedExpression(expression.parent) ||
    ts.isNonNullExpression(expression.parent) ||
    ts.isAsExpression(expression.parent) ||
    ts.isTypeAssertionExpression(expression.parent) ||
    ts.isSatisfiesExpression(expression.parent)
  ) {
    const parent = expression.parent;
    if (parent.expression !== expression) break;
    expression = parent;
  }
  const parent = expression.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression)
    return [parent.name.text];
  if (ts.isQualifiedName(parent) && parent.left === expression)
    return [parent.right.text];
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === expression
  ) {
    return literalKeys(parent.argumentExpression, checker);
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    const names: string[] = [];
    for (const element of parent.name.elements) {
      if (element.dotDotDotToken) return undefined;
      const property =
        element.propertyName ??
        (ts.isIdentifier(element.name) ? element.name : undefined);
      if (!property) return undefined;
      if (ts.isComputedPropertyName(property)) {
        const keys = literalKeys(property.expression, checker);
        if (!keys) return undefined;
        names.push(...keys);
      } else if (
        ts.isIdentifier(property) ||
        ts.isStringLiteralLike(property) ||
        ts.isNumericLiteral(property)
      ) {
        names.push(property.text);
      } else return undefined;
    }
    return names;
  }
  // Aliases, shorthand properties, typeof ns, enumeration, assignment patterns,
  // rest/spread and namespace values crossing a call/return boundary all escape.
  return undefined;
}

function literalKeys(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): string[] | undefined {
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression))
    return [expression.text];
  const type = checker.getTypeAtLocation(expression);
  const types = type.isUnion() ? type.types : [type];
  const names: string[] = [];
  for (const member of types) {
    if (member.isStringLiteral() || member.isNumberLiteral())
      names.push(String(member.value));
    else return undefined;
  }
  return names.length > 0 ? names : undefined;
}
