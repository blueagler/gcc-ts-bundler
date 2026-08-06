import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { normalizePath } from "./shared";
import type {
  ParsedDependencyImport,
  ParsedMaterializedModule,
} from "./shared";

interface ParseTargets {
  authoredFiles: Set<string>;
  moduleFilePaths: Set<string>;
}

type ParsedStatementTarget =
  | { kind: "authored"; target: string }
  | { kind: "dependency"; dependencyImport: ParsedDependencyImport }
  | {
      kind: "reexport";
      dependencyImport: ParsedDependencyImport | null;
      hasDefaultExport: boolean;
      localExportedNames: string[];
    }
  | null;

/**
 * A cached parser over materialized runtime modules: exports, authored
 * imports, and dependency imports that may become region bundles.
 */
export function createModuleParser(targets: ParseTargets) {
  const parseCache = new Map<string, ParsedMaterializedModule>();

  return async function parseModule(
    filePath: string,
  ): Promise<ParsedMaterializedModule> {
    const normalizedFilePath = normalizePath(filePath);
    const cached = parseCache.get(normalizedFilePath);
    if (cached) {
      return cached;
    }

    const sourceText = await fs.readFile(normalizedFilePath, "utf8");
    const sourceFile = ts.createSourceFile(
      normalizedFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const staticAuthoredImports = new Set<string>();
    const bareImportSpecifiers = new Set<string>();
    const dependencyFilePaths = new Set<string>();
    const dependencyImports: ParsedDependencyImport[] = [];
    const exportedNames = new Set<string>();
    let hasDefaultExport = false;

    for (const statement of sourceFile.statements) {
      hasDefaultExport =
        collectLocalExportNames(statement, exportedNames) || hasDefaultExport;
      if (
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier) &&
        isBareSpecifier(statement.moduleSpecifier.text)
      ) {
        bareImportSpecifiers.add(statement.moduleSpecifier.text);
      }

      const parsed = parseStatementTarget(
        statement,
        normalizedFilePath,
        targets,
      );
      if (!parsed) {
        continue;
      }
      if (parsed.kind === "authored") {
        staticAuthoredImports.add(parsed.target);
        continue;
      }
      if (parsed.kind === "dependency") {
        dependencyFilePaths.add(parsed.dependencyImport.targetFilePath);
        dependencyImports.push(parsed.dependencyImport);
        continue;
      }
      for (const name of parsed.localExportedNames) {
        exportedNames.add(name);
      }
      if (parsed.hasDefaultExport) {
        hasDefaultExport = true;
        exportedNames.add("default");
      }
      if (parsed.dependencyImport) {
        dependencyFilePaths.add(parsed.dependencyImport.targetFilePath);
        dependencyImports.push(parsed.dependencyImport);
      }
    }

    const visitDynamicImports = (node: ts.Node) => {
      const firstArgument = ts.isCallExpression(node)
        ? node.arguments[0]
        : undefined;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        firstArgument !== undefined &&
        ts.isStringLiteralLike(firstArgument) &&
        firstArgument.text.startsWith(".")
      ) {
        const targetFilePath = normalizePath(
          path.resolve(path.dirname(normalizedFilePath), firstArgument.text),
        );
        if (
          targets.moduleFilePaths.has(targetFilePath) &&
          !targets.authoredFiles.has(targetFilePath)
        ) {
          dependencyFilePaths.add(targetFilePath);
        }
      } else if (
        ts.isCallExpression(node) &&
        firstArgument !== undefined &&
        ts.isStringLiteralLike(firstArgument) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        isBareSpecifier(firstArgument.text)
      ) {
        bareImportSpecifiers.add(firstArgument.text);
      }
      ts.forEachChild(node, visitDynamicImports);
    };
    visitDynamicImports(sourceFile);

    if (!hasDefaultExport && exportedNames.size === 0) {
      // A CommonJS-only dependency (jquery's UMD wrapper, any `module.exports`
      // package) has no ESM export syntax to collect, but its ESM view still
      // has a default binding: `module.exports`. Without this, a stock
      // `import $ from "jquery"` renders a region entry with no exports and
      // the bundler-runtime stage has no slot to bind the default to.
      hasDefaultExport = hasCommonJsExportShape(sourceFile);
    }

    const parsed = {
      bareImportSpecifiers: [...bareImportSpecifiers].sort((left, right) =>
        left.localeCompare(right),
      ),
      dependencyFilePaths: [...dependencyFilePaths].sort((left, right) =>
        left.localeCompare(right),
      ),
      dependencyImports,
      exportedNames: [...exportedNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      hasDefaultExport,
      staticAuthoredImports: [...staticAuthoredImports].sort((left, right) =>
        left.localeCompare(right),
      ),
    } satisfies ParsedMaterializedModule;
    parseCache.set(normalizedFilePath, parsed);
    return parsed;
  };
}

function isBareSpecifier(specifier: string) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.includes(":")
  );
}

/** Record locally declared export names; returns whether one is a default. */
function collectLocalExportNames(
  statement: ts.Statement,
  exportedNames: Set<string>,
): boolean {
  if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
    exportedNames.add("default");
    return true;
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) &&
    statement.modifiers.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  ) {
    exportedNames.add("default");
    return true;
  }
  if (
    ts.isExportDeclaration(statement) &&
    !statement.moduleSpecifier &&
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause)
  ) {
    let hasDefaultExport = false;
    for (const element of statement.exportClause.elements) {
      exportedNames.add(element.name.text);
      hasDefaultExport ||= element.name.text === "default";
    }
    return hasDefaultExport;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isVariableStatement(statement)) &&
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  ) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exportedNames.add(declaration.name.text);
        }
      }
    } else if (statement.name) {
      exportedNames.add(statement.name.text);
    }
  }
  return false;
}

function parseStatementTarget(
  statement: ts.Statement,
  importerFilePath: string,
  targets: ParseTargets,
): ParsedStatementTarget {
  if (
    !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
    !statement.moduleSpecifier ||
    !ts.isStringLiteralLike(statement.moduleSpecifier) ||
    !statement.moduleSpecifier.text.startsWith(".")
  ) {
    return null;
  }
  const targetFilePath = normalizePath(
    path.resolve(
      path.dirname(importerFilePath),
      statement.moduleSpecifier.text,
    ),
  );
  if (targets.authoredFiles.has(targetFilePath)) {
    return { kind: "authored", target: targetFilePath };
  }
  if (!targets.moduleFilePaths.has(targetFilePath)) {
    return null;
  }

  return ts.isImportDeclaration(statement)
    ? parseDependencyImport(statement, targetFilePath)
    : parseDependencyReexport(statement, targetFilePath);
}

function parseDependencyImport(
  statement: ts.ImportDeclaration,
  targetFilePath: string,
): ParsedStatementTarget {
  const importClause = statement.importClause;
  let hasDefault = false;
  let hasNamespace = false;
  const namedExports = new Set<string>();

  if (importClause) {
    if (importClause.name) {
      hasDefault = true;
    }
    if (importClause.namedBindings) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        hasNamespace = true;
      } else {
        for (const element of importClause.namedBindings.elements) {
          namedExports.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }

  return {
    dependencyImport: {
      hasDefault,
      hasNamespace,
      isSideEffectOnly: !importClause,
      namedExports: [...namedExports].sort((left, right) =>
        left.localeCompare(right),
      ),
      node: statement,
      targetFilePath,
    },
    kind: "dependency",
  };
}

function parseDependencyReexport(
  statement: ts.ExportDeclaration,
  targetFilePath: string,
): ParsedStatementTarget {
  if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
    return null;
  }

  if (!statement.exportClause) {
    return {
      dependencyImport: {
        hasDefault: false,
        hasNamespace: true,
        isSideEffectOnly: false,
        namedExports: [],
        node: statement,
        targetFilePath,
      },
      hasDefaultExport: false,
      kind: "reexport",
      localExportedNames: [],
    };
  }

  if (!ts.isNamedExports(statement.exportClause)) {
    return null;
  }

  const namedExports = new Set<string>();
  const localExportedNames: string[] = [];
  for (const element of statement.exportClause.elements) {
    namedExports.add((element.propertyName ?? element.name).text);
    localExportedNames.push(element.name.text);
  }
  const hasDefaultExport = namedExports.delete("default");
  return {
    dependencyImport: {
      hasDefault: false,
      hasNamespace: false,
      isSideEffectOnly: false,
      namedExports: [...namedExports].sort((left, right) =>
        left.localeCompare(right),
      ),
      node: statement,
      targetFilePath,
    },
    hasDefaultExport,
    kind: "reexport",
    localExportedNames,
  };
}

/**
 * True when a module writes to a CommonJS export slot anywhere (including
 * inside a UMD factory IIFE), which makes `module.exports` its ESM default.
 */
function hasCommonJsExportShape(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isCommonJsExportTarget(node.left)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Matches `module.exports`, `module.exports.foo`, and `exports.foo` targets. */
function isCommonJsExportTarget(node: ts.Expression): boolean {
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return false;
  }
  const object = node.expression;
  if (ts.isIdentifier(object)) {
    return object.text === "exports" || isModuleExportsAccess(node);
  }
  return isModuleExportsAccess(object);
}

/** Matches the `module.exports` access itself. */
function isModuleExportsAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}
