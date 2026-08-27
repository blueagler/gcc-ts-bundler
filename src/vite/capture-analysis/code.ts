import ts from "@typescript/typescript6";

import { dynamicImportSpecifier } from "../../shared/typescript";
import type {
  CapturedModule,
  CapturedModuleAnalysis,
  CapturedModuleFormat,
  ViteBuildMetrics,
} from "../internal-types";
import { stripQuery } from "../capture/specifiers";

function isEffectivelyEmptyStatement(statement: ts.Statement) {
  if (ts.isEmptyStatement(statement)) {
    return true;
  }
  return isEmptyExportStatement(statement);
}

function isEmptyExportStatement(statement: ts.Statement) {
  if (!ts.isExportDeclaration(statement)) {
    return false;
  }
  if (statement.moduleSpecifier) {
    return false;
  }
  if (!statement.exportClause) {
    return true;
  }
  return (
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length === 0
  );
}

function resolveScriptKind(id: string) {
  const cleanId = stripQuery(id);
  if (cleanId.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (cleanId.endsWith(".ts")) {
    return ts.ScriptKind.TS;
  }
  if (cleanId.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

interface CapturedSourceFileEntry {
  code: string;
  sourceFile: ts.SourceFile;
}

const capturedSourceFiles = new Map<string, CapturedSourceFileEntry>();
const capturedParseCache: {
  metrics: ViteBuildMetrics | undefined;
} = { metrics: undefined };

/**
 * Returns the memoized `ts.SourceFile` for a captured module revision.
 *
 * Captured module text is parsed by several independent passes (analysis,
 * const demotion, static member annotation, graph demand), so the parse is
 * shared here instead of repeated per pass. The entry is keyed by module id
 * and validated against the exact `code` string, and a re-inserted id drops
 * its previous revision: a rewritten module yields a fresh SourceFile, never a
 * stale one, and the cache stays bounded by the number of captured modules.
 */
export function getCapturedSourceFile(id: string, code: string): ts.SourceFile {
  const cached = capturedSourceFiles.get(id);
  if (cached && cached.code === code) {
    if (capturedParseCache.metrics) {
      capturedParseCache.metrics.parseCacheHits += 1;
    }
    return cached.sourceFile;
  }
  if (capturedParseCache.metrics) {
    capturedParseCache.metrics.parseCacheMisses += 1;
  }
  const sourceFile = ts.createSourceFile(
    id,
    code,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(id),
  );
  capturedSourceFiles.set(id, { code, sourceFile });
  return sourceFile;
}

/** Mutable syntax flags the AST walk and the top-level statement scan share. */
interface ModuleCodeFlags {
  hasCommonJsSyntax: boolean;
  hasEsmSyntax: boolean;
  hasExtendingClass: boolean;
  needsClosureCompatibility: boolean;
  needsTypeScriptCompatibility: boolean;
}

/** Specifier sets the top-level scan and the recursive visit both write. */
interface ModuleSpecifierSets {
  importSpecifiers: Set<string>;
  dynamicImportSpecifiers: Set<string>;
  bridgeSpecifiers: Set<string>;
}

function collectCommonJsAliases(node: ts.Node, aliases: Set<string>) {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isModuleExportsAccess(node.left) &&
    ts.isIdentifier(node.right)
  ) {
    aliases.add(node.right.text);
  }
  ts.forEachChild(node, (child) => collectCommonJsAliases(child, aliases));
}

function noteCapturedImport(
  statement: ts.ImportDeclaration,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
): boolean {
  if (
    !statement.moduleSpecifier ||
    !ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return false;
  }
  flags.hasEsmSyntax = true;
  const specifier = statement.moduleSpecifier.text;
  specifiers.importSpecifiers.add(specifier);
  if (statement.importClause) {
    specifiers.bridgeSpecifiers.add(specifier);
  }
  return true;
}

function noteCapturedExportDeclaration(
  statement: ts.ExportDeclaration,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
) {
  flags.hasEsmSyntax = true;
  if (
    statement.moduleSpecifier &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    specifiers.importSpecifiers.add(statement.moduleSpecifier.text);
  }
}

function noteExportAssignmentOrKeyword(
  statement: ts.Statement,
  flags: ModuleCodeFlags,
) {
  if (ts.isExportAssignment(statement)) {
    if (statement.isExportEquals) {
      flags.hasCommonJsSyntax = true;
      return;
    }
    flags.hasEsmSyntax = true;
    return;
  }
  if (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    flags.hasEsmSyntax = true;
  }
}

function isForwardingStatement(
  statement: ts.Statement,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
): boolean {
  if (ts.isEmptyStatement(statement)) {
    return true;
  }
  if (
    ts.isImportDeclaration(statement) &&
    noteCapturedImport(statement, flags, specifiers)
  ) {
    return true;
  }
  if (ts.isExportDeclaration(statement)) {
    noteCapturedExportDeclaration(statement, flags, specifiers);
    return true;
  }
  noteExportAssignmentOrKeyword(statement, flags);
  return isEmptyExportStatement(statement);
}

function scanTopLevelStatements(
  sourceFile: ts.SourceFile,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
): boolean {
  let isForwardingOnly = true;
  for (const statement of sourceFile.statements) {
    if (isForwardingStatement(statement, flags, specifiers)) {
      continue;
    }
    isForwardingOnly = false;
  }
  return isForwardingOnly;
}

function visitModuleNode(
  node: ts.Node,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
  namedExports: Set<string>,
  aliases: Set<string>,
) {
  noteRequireOrExportTarget(node, flags);
  if (!collectCommonJsAssignmentExports(node, namedExports, aliases)) {
    noteModuleExportsOrDefineProperty(node, flags);
  }
  noteEsmRuntimeForms(node, flags, specifiers);
  noteClassHeritageAndPrivateSyntax(node, flags);
  noteTypeScriptCompatibilityNeeds(node, flags);
  ts.forEachChild(node, (child) =>
    visitModuleNode(child, flags, specifiers, namedExports, aliases),
  );
}

function sortedSpecifierList(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function resolveModuleFormat(flags: ModuleCodeFlags): CapturedModuleFormat {
  if (flags.hasEsmSyntax) {
    return flags.hasCommonJsSyntax ? "mixed" : "esm";
  }
  return flags.hasCommonJsSyntax ? "cjs" : "unknown";
}

function buildCapturedModuleAnalysis(
  sourceFile: ts.SourceFile,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
  commonJsNamedExports: Set<string>,
  isForwardingOnly: boolean,
): CapturedModuleAnalysis {
  return {
    bridgeSpecifiers: sortedSpecifierList(specifiers.bridgeSpecifiers),
    commonJsNamedExports: sortedSpecifierList(commonJsNamedExports),
    dynamicImportSpecifiers: sortedSpecifierList(
      specifiers.dynamicImportSpecifiers,
    ),
    importSpecifiers: sortedSpecifierList(specifiers.importSpecifiers),
    isEffectivelyEmpty: sourceFile.statements.every(
      isEffectivelyEmptyStatement,
    ),
    hasExtendingClass: flags.hasExtendingClass,
    isForwardingOnly,
    moduleFormat: resolveModuleFormat(flags),
    needsClosureCompatibilityDownlevel: flags.needsClosureCompatibility,
    needsTypeScriptCompatibilityDownlevel: flags.needsTypeScriptCompatibility,
  };
}

export function analyzeModuleCode(
  id: string,
  code: string,
): CapturedModuleAnalysis {
  const sourceFile = getCapturedSourceFile(id, code);
  const specifiers: ModuleSpecifierSets = {
    importSpecifiers: new Set<string>(),
    dynamicImportSpecifiers: new Set<string>(),
    bridgeSpecifiers: new Set<string>(),
  };
  const commonJsExportAliases = new Set<string>();
  const commonJsNamedExports = new Set<string>();
  collectCommonJsAliases(sourceFile, commonJsExportAliases);
  const flags: ModuleCodeFlags = {
    hasCommonJsSyntax: false,
    hasEsmSyntax: false,
    hasExtendingClass: false,
    needsClosureCompatibility: false,
    needsTypeScriptCompatibility: false,
  };
  const isForwardingOnly = scanTopLevelStatements(
    sourceFile,
    flags,
    specifiers,
  );
  visitModuleNode(
    sourceFile,
    flags,
    specifiers,
    commonJsNamedExports,
    commonJsExportAliases,
  );
  return buildCapturedModuleAnalysis(
    sourceFile,
    flags,
    specifiers,
    commonJsNamedExports,
    isForwardingOnly,
  );
}

function reuseCapturedModuleAnalysis(
  record: CapturedModule,
  metrics: ViteBuildMetrics | undefined,
  mode: "raw" | "normalized",
): CapturedModuleAnalysis | undefined {
  const existingAnalysis =
    mode === "normalized" ? record.normalizedAnalysis : record.rawAnalysis;
  if (existingAnalysis) {
    if (metrics) {
      metrics.parseCacheHits += 1;
    }
    return existingAnalysis;
  }
  if (
    mode !== "normalized" ||
    record.normalizedCode === undefined ||
    record.normalizedCode !== record.code ||
    !record.rawAnalysis
  ) {
    return undefined;
  }
  if (metrics) {
    metrics.parseCacheHits += 1;
  }
  record.normalizedAnalysis = record.rawAnalysis;
  return record.normalizedAnalysis;
}

export function getCapturedModuleAnalysis(
  record: CapturedModule,
  metrics?: ViteBuildMetrics,
  mode: "raw" | "normalized" = "raw",
): CapturedModuleAnalysis {
  if (metrics) {
    capturedParseCache.metrics = metrics;
  }
  const reused = reuseCapturedModuleAnalysis(record, metrics, mode);
  if (reused) {
    return reused;
  }
  if (mode === "normalized" && record.normalizedCode === undefined) {
    return getCapturedModuleAnalysis(record, metrics, "raw");
  }

  const analysis = analyzeModuleCode(
    record.id,
    mode === "normalized"
      ? (record.normalizedCode ?? record.code)
      : record.code,
  );
  if (mode === "normalized") {
    record.normalizedAnalysis = analysis;
  } else {
    record.rawAnalysis = analysis;
  }
  return analysis;
}

function isCommonJsExportTarget(node: ts.Expression): boolean {
  return commonJsExportName(node) !== null;
}

function commonJsExportName(node: ts.Expression): string | null {
  if (isModuleExportsAccess(node)) {
    return "default";
  }
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  ) {
    return null;
  }
  if (
    !isExportsIdentifier(node.expression) &&
    !isModuleExportsAccess(node.expression)
  ) {
    return null;
  }
  return propertyAccessName(node);
}

function commonJsAliasedExportName(
  node: ts.Expression,
  aliases: Set<string>,
): string | null {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    !ts.isIdentifier(node.expression) ||
    !aliases.has(node.expression.text)
  ) {
    return null;
  }
  return propertyAccessName(node);
}

function propertyAccessName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | null {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
    ? node.argumentExpression.text
    : null;
}

function isExportsIdentifier(node: ts.Node) {
  return ts.isIdentifier(node) && node.text === "exports";
}

function isModuleExportsAccess(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function isClassStaticBlockNode(node: ts.Node) {
  return node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration;
}

/**
 * `require(...)` and an assignment whose left side is a CommonJS export slot
 * both mean the module speaks CJS, regardless of whether ESM syntax is also
 * present.
 */
function noteRequireOrExportTarget(node: ts.Node, flags: ModuleCodeFlags) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  ) {
    flags.hasCommonJsSyntax = true;
    return;
  }
  if (ts.isBinaryExpression(node) && isCommonJsExportTarget(node.left)) {
    flags.hasCommonJsSyntax = true;
  }
}

/**
 * Named `exports.foo =` / alias.foo = bindings. Returns true when `node` is
 * an `=` assignment so the caller can skip the mutually exclusive
 * `module.exports` / `Object.defineProperty` checks that lived in the same
 * `if`/`else if` chain.
 */
function collectCommonJsAssignmentExports(
  node: ts.Node,
  namedExports: Set<string>,
  aliases: Set<string>,
) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
  ) {
    return false;
  }
  const directExportName = commonJsExportName(node.left);
  if (directExportName && directExportName !== "default") {
    namedExports.add(directExportName);
  }
  const aliasedExportName = commonJsAliasedExportName(node.left, aliases);
  if (aliasedExportName) {
    namedExports.add(aliasedExportName);
  }
  return true;
}

/**
 * A bare `module.exports` mention, or `Object.defineProperty` on `exports` /
 * `module.exports`, is CJS even when it is not an `=` assignment.
 */
function noteModuleExportsOrDefineProperty(
  node: ts.Node,
  flags: ModuleCodeFlags,
) {
  if (isModuleExportsAccess(node)) {
    flags.hasCommonJsSyntax = true;
    return;
  }
  if (isObjectDefinePropertyOnExports(node)) {
    flags.hasCommonJsSyntax = true;
  }
}

function isObjectDefinePropertyOnExports(node: ts.Node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== "Object" ||
    node.expression.name.text !== "defineProperty" ||
    node.arguments[0] === undefined
  ) {
    return false;
  }
  return (
    isExportsIdentifier(node.arguments[0]) ||
    isModuleExportsAccess(node.arguments[0])
  );
}

/**
 * Runtime ESM forms that are not static `import`/`export` statements:
 * `import.meta` and `import("...")`.
 */
function noteEsmRuntimeForms(
  node: ts.Node,
  flags: ModuleCodeFlags,
  specifiers: ModuleSpecifierSets,
) {
  if (
    ts.isMetaProperty(node) &&
    node.keywordToken === ts.SyntaxKind.ImportKeyword
  ) {
    flags.hasEsmSyntax = true;
  }

  const specifier = dynamicImportSpecifier(node);
  if (specifier === null) {
    return;
  }
  specifiers.importSpecifiers.add(specifier);
  specifiers.dynamicImportSpecifiers.add(specifier);
  specifiers.bridgeSpecifiers.add(specifier);
}

/**
 * Class `extends` plus private identifiers / static blocks, which Closure
 * cannot consume without a downlevel pass.
 */
function noteClassHeritageAndPrivateSyntax(
  node: ts.Node,
  flags: ModuleCodeFlags,
) {
  if (
    (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
    node.heritageClauses?.some(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    )
  ) {
    flags.hasExtendingClass = true;
  }

  if (ts.isPrivateIdentifier(node) || isClassStaticBlockNode(node)) {
    flags.needsClosureCompatibility = true;
  }
}

/**
 * Syntax TypeScript emits that Closure's parser still rejects: `super.x`,
 * `new.target`, and computed getters/setters.
 *
 * The three arms are mutually exclusive node kinds; the early returns keep
 * the original `if` / `else if` short-circuit even though a node cannot
 * actually match more than one arm.
 */
function noteTypeScriptCompatibilityNeeds(
  node: ts.Node,
  flags: ModuleCodeFlags,
) {
  if (isSuperPropertyAccess(node)) {
    flags.needsTypeScriptCompatibility = true;
    return;
  }
  if (ts.isMetaProperty(node)) {
    if (isNewTargetMetaProperty(node)) {
      flags.needsTypeScriptCompatibility = true;
    }
    return;
  }
  if (isComputedAccessor(node)) {
    flags.needsTypeScriptCompatibility = true;
  }
}

function isSuperPropertyAccess(node: ts.Node) {
  return (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    node.expression.kind === ts.SyntaxKind.SuperKeyword
  );
}

function isNewTargetMetaProperty(node: ts.MetaProperty) {
  return (
    node.keywordToken === ts.SyntaxKind.NewKeyword &&
    node.name.escapedText === "target"
  );
}

function isComputedAccessor(node: ts.Node) {
  return (
    (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
    ts.isComputedPropertyName(node.name)
  );
}
