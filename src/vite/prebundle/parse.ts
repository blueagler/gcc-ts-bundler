import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { dynamicImportSpecifier, hasModifier } from "../../shared/typescript";
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

interface ModuleParseCollected {
  bareImportSpecifiers: Set<string>;
  dependencyFilePaths: Set<string>;
  dependencyImports: ParsedDependencyImport[];
  exportedNames: Set<string>;
  hasDefaultExport: boolean;
  hasDefineReferences: boolean;
  staticAuthoredImports: Set<string>;
}

/**
 * A cached parser over materialized runtime modules: exports, authored
 * imports, and dependency imports that may become region bundles.
 */
export function createModuleParser(targets: ParseTargets) {
  const parseCache = new Map<string, ParsedMaterializedModule>();

  async function parseModule(
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
    const collected: ModuleParseCollected = {
      bareImportSpecifiers: new Set<string>(),
      dependencyFilePaths: new Set<string>(),
      dependencyImports: [],
      exportedNames: new Set<string>(),
      hasDefaultExport: false,
      hasDefineReferences: false,
      staticAuthoredImports: new Set<string>(),
    };
    collectStaticModuleFacts(
      sourceFile,
      normalizedFilePath,
      targets,
      collected,
    );
    visitDynamicImports(sourceFile, normalizedFilePath, targets, collected);
    if (!collected.hasDefaultExport && collected.exportedNames.size === 0) {
      // A CommonJS-only dependency (jquery's UMD wrapper, any `module.exports`
      // package) has no ESM export syntax to collect, but its ESM view still
      // has a default binding: `module.exports`. Without this, a stock
      // `import $ from "jquery"` renders a region entry with no exports and
      // the bundler-runtime stage has no slot to bind the default to.
      collected.hasDefaultExport = assignsCommonJsExports(sourceFile);
    }

    const parsed = toParsedMaterializedModule(sourceText, collected);
    parseCache.set(normalizedFilePath, parsed);
    return parsed;
  }

  /**
   * Forget the modules whose text on disk a rewrite pass may have changed.
   * Every other module keeps its parse, so rewriting a handful of files no
   * longer costs a re-read and re-parse of the whole materialized graph.
   */
  function invalidate(filePaths: Iterable<string>) {
    for (const filePath of filePaths) {
      parseCache.delete(normalizePath(filePath));
    }
  }

  return { invalidate, parseModule };
}

function collectStaticModuleFacts(
  sourceFile: ts.SourceFile,
  importerFilePath: string,
  targets: ParseTargets,
  collected: ModuleParseCollected,
) {
  for (const statement of sourceFile.statements) {
    collected.hasDefaultExport =
      collectLocalExportNames(statement, collected.exportedNames) ||
      collected.hasDefaultExport;
    recordBareModuleSpecifier(statement, collected.bareImportSpecifiers);
    applyParsedStatementTarget(
      parseStatementTarget(statement, importerFilePath, targets),
      collected,
    );
  }
}

function recordBareModuleSpecifier(
  statement: ts.Statement,
  bareImportSpecifiers: Set<string>,
) {
  if (
    !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
    !statement.moduleSpecifier ||
    !ts.isStringLiteralLike(statement.moduleSpecifier) ||
    !isBareSpecifier(statement.moduleSpecifier.text)
  ) {
    return;
  }
  bareImportSpecifiers.add(statement.moduleSpecifier.text);
}

function applyParsedStatementTarget(
  parsed: ParsedStatementTarget,
  collected: ModuleParseCollected,
) {
  if (!parsed) {
    return;
  }
  if (parsed.kind === "authored") {
    collected.staticAuthoredImports.add(parsed.target);
    return;
  }
  if (parsed.kind === "dependency") {
    collected.dependencyFilePaths.add(parsed.dependencyImport.targetFilePath);
    collected.dependencyImports.push(parsed.dependencyImport);
    return;
  }
  for (const name of parsed.localExportedNames) {
    collected.exportedNames.add(name);
  }
  if (parsed.hasDefaultExport) {
    collected.hasDefaultExport = true;
    collected.exportedNames.add("default");
  }
  if (parsed.dependencyImport) {
    collected.dependencyFilePaths.add(parsed.dependencyImport.targetFilePath);
    collected.dependencyImports.push(parsed.dependencyImport);
  }
}

function visitDynamicImports(
  node: ts.Node,
  importerFilePath: string,
  targets: ParseTargets,
  collected: ModuleParseCollected,
) {
  const firstArgument = ts.isCallExpression(node)
    ? node.arguments[0]
    : undefined;
  if (
    (ts.isIdentifier(node) && /^__[A-Z\d_]+__$/u.test(node.text)) ||
    isProcessNodeEnvAccess(node)
  ) {
    collected.hasDefineReferences = true;
  }
  const specifier = dynamicImportSpecifier(node);
  if (specifier !== null && specifier.startsWith(".")) {
    recordRelativeDynamicImport(
      specifier,
      importerFilePath,
      targets,
      collected.dependencyFilePaths,
    );
  } else if (
    ts.isCallExpression(node) &&
    firstArgument !== undefined &&
    ts.isStringLiteralLike(firstArgument) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) &&
        node.expression.text === "require")) &&
    isBareSpecifier(firstArgument.text)
  ) {
    collected.bareImportSpecifiers.add(firstArgument.text);
  }
  ts.forEachChild(node, (child) => {
    visitDynamicImports(child, importerFilePath, targets, collected);
  });
}

function recordRelativeDynamicImport(
  specifier: string,
  importerFilePath: string,
  targets: ParseTargets,
  dependencyFilePaths: Set<string>,
) {
  const targetFilePath = normalizePath(
    path.resolve(path.dirname(importerFilePath), specifier),
  );
  if (
    targets.moduleFilePaths.has(targetFilePath) &&
    !targets.authoredFiles.has(targetFilePath)
  ) {
    dependencyFilePaths.add(targetFilePath);
  }
}

function toParsedMaterializedModule(
  sourceText: string,
  collected: ModuleParseCollected,
): ParsedMaterializedModule {
  return {
    bareImportSpecifiers: localeSorted(collected.bareImportSpecifiers),
    dependencyFilePaths: localeSorted(collected.dependencyFilePaths),
    dependencyImports: collected.dependencyImports,
    exportedNames: localeSorted(collected.exportedNames),
    hasDefaultExport: collected.hasDefaultExport,
    hasDefineReferences: collected.hasDefineReferences,
    isFusedDistribution:
      (sourceText.match(/(?:^|\n)\s*\/\/\s*#region\b/gu)?.length ?? 0) > 1,
    staticAuthoredImports: localeSorted(collected.staticAuthoredImports),
  } satisfies ParsedMaterializedModule;
}

function localeSorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/** Matches `process.env.NODE_ENV`, the define Vite substitutes at capture. */
function isProcessNodeEnvAccess(node: ts.Node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "NODE_ENV" &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process"
  );
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
  const assignmentDefault = collectExportAssignmentDefault(
    statement,
    exportedNames,
  );
  if (assignmentDefault !== undefined) {
    return assignmentDefault;
  }
  const defaultDeclaration = collectDefaultExportedDeclaration(
    statement,
    exportedNames,
  );
  if (defaultDeclaration !== undefined) {
    return defaultDeclaration;
  }
  const namedClause = collectNamedExportClauseNames(statement, exportedNames);
  if (namedClause !== undefined) {
    return namedClause;
  }
  collectExportedDeclarationNames(statement, exportedNames);
  return false;
}

/**
 * `export default <expr>` (not `export =`). Returns undefined when the
 * statement is a different form so later collectors can still run.
 */
function collectExportAssignmentDefault(
  statement: ts.Statement,
  exportedNames: Set<string>,
): boolean | undefined {
  if (!ts.isExportAssignment(statement) || statement.isExportEquals) {
    return undefined;
  }
  exportedNames.add("default");
  return true;
}

/**
 * `export default function` / `export default class`, including anonymous
 * ones. Must run before the named-declaration collector so `foo` in
 * `export default function foo()` is not also recorded as a named export.
 */
function collectDefaultExportedDeclaration(
  statement: ts.Statement,
  exportedNames: Set<string>,
): boolean | undefined {
  if (!(
    ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
  )) {
    return undefined;
  }
  if (!hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
    return undefined;
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return undefined;
  }
  exportedNames.add("default");
  return true;
}

/**
 * A local `export { a, b as c, default }`. Returns whether `default` was
 * among the exported names; undefined when the statement is not this form.
 */
function collectNamedExportClauseNames(
  statement: ts.Statement,
  exportedNames: Set<string>,
): boolean | undefined {
  if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier) {
    return undefined;
  }
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return undefined;
  }
  let hasDefaultExport = false;
  for (const element of statement.exportClause.elements) {
    exportedNames.add(element.name.text);
    hasDefaultExport ||= element.name.text === "default";
  }
  return hasDefaultExport;
}

/**
 * `export function` / `export class` / `export const` names. Binding patterns
 * are skipped, matching the previous collector: only identifier declarators
 * become export names.
 */
function collectExportedDeclarationNames(
  statement: ts.Statement,
  exportedNames: Set<string>,
) {
  if (!isExportedFunctionClassOrVariable(statement)) {
    return;
  }
  if (ts.isVariableStatement(statement)) {
    collectExportedVariableIdentifierNames(statement, exportedNames);
    return;
  }
  if (statement.name) {
    exportedNames.add(statement.name.text);
  }
}

function isExportedFunctionClassOrVariable(
  statement: ts.Statement,
): statement is
  ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement {
  if (!(
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isVariableStatement(statement)
  )) {
    return false;
  }
  return hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function collectExportedVariableIdentifierNames(
  statement: ts.VariableStatement,
  exportedNames: Set<string>,
) {
  for (const declaration of statement.declarationList.declarations) {
    if (!ts.isIdentifier(declaration.name)) {
      continue;
    }
    exportedNames.add(declaration.name.text);
  }
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
  if (!importClause) {
    return {
      dependencyImport: {
        hasDefault: false,
        hasNamespace: false,
        isSideEffectOnly: true,
        namedExports: [],
        node: statement,
        targetFilePath,
      },
      kind: "dependency",
    };
  }

  const namedExports = new Set<string>();
  let hasNamespace = false;
  if (
    importClause.namedBindings &&
    ts.isNamespaceImport(importClause.namedBindings)
  ) {
    hasNamespace = true;
  } else if (importClause.namedBindings) {
    for (const element of importClause.namedBindings.elements) {
      namedExports.add((element.propertyName ?? element.name).text);
    }
  }

  return {
    dependencyImport: {
      hasDefault: importClause.name !== undefined,
      hasNamespace,
      isSideEffectOnly: false,
      namedExports: localeSorted(namedExports),
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
      namedExports: localeSorted(namedExports),
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
function assignsCommonJsExports(sourceFile: ts.SourceFile): boolean {
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
