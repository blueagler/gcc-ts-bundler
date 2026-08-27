import path from "node:path";

import ts from "@typescript/typescript6";
import { transformWithEsbuild, type ResolvedConfig } from "vite";

import {
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
} from "../../shared/cache-store";
import { hashJson } from "../../shared/hash";
import { applyTextEdits } from "../../shared/text-edits";
import type { GccTsBundlerVitePluginOptions } from "../types";
import type {
  CapturedModule,
  CapturedModuleAnalysis,
  ViteBuildMetrics,
} from "../internal-types";
import { getCapturedSourceFile } from "../capture-analysis";
import {
  analyzeModuleCode,
  getCapturedModuleAnalysis,
  isDependencyModuleId,
  stripQuery,
} from "./format";

export type { CapturedModuleResolutionCache } from "./format";
export {
  classifyModuleId,
  getCapturedModuleAnalysis,
  isAuthoredModuleId,
  isSupportedExternalSpecifier,
  resolveCapturedModuleFormat,
  resolveCapturedSpecifier,
  stripQuery,
  toMaterializedRelativePath,
  toRelativeImportSpecifier,
} from "./format";
export { restoreEmptyDependencyModuleSource } from "./restore";

const VITE_CAPTURE_DIR = "vite-capture";

export function resolveViteCaptureRootPath(input: {
  config: Pick<ResolvedConfig, "base" | "mode" | "root" | "build">;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  const projectRoot = path.resolve(input.projectRoot);
  const cacheDir = input.options.compiler?.cache?.dir;
  const cacheRoot = cacheDir
    ? path.resolve(projectRoot, cacheDir)
    : getDefaultPersistentCacheRoot();
  return path.join(
    getProjectCacheDir(cacheRoot, projectRoot),
    VITE_CAPTURE_DIR,
    resolveViteCaptureRootId(input),
  );
}

function resolveViteCaptureRootId(input: {
  config: Pick<ResolvedConfig, "base" | "mode" | "root" | "build">;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  return hashJson({
    plugin: {
      externs: input.options.externs ?? {},
      runtime: input.options.runtime ?? {},
    },
    projectRoot: path.resolve(input.projectRoot),
    vite: {
      base: input.config.base,
      build: {
        assetsDir: input.config.build.assetsDir,
        cssCodeSplit: input.config.build.cssCodeSplit,
        minify: input.config.build.minify,
        target: input.config.build.target,
      },
      mode: input.config.mode,
      root: path.resolve(input.config.root),
    },
  }).slice(0, 12);
}

export function shouldCaptureModule(id: string, code: string) {
  if (id.startsWith("\0") || id.startsWith("virtual:")) {
    return true;
  }

  const cleanId = stripQuery(id);
  if (/\.(?:[cm]?[jt]sx?|mjs|cjs|svelte|vue)$/u.test(cleanId)) {
    return true;
  }

  return /\b(?:import|export)\b/u.test(code);
}

export function isNonMaterializedAssetModuleId(moduleId: string) {
  // Vite can retain stylesheet and other asset edges in transformed JS while
  // omitting the asset itself from the final JS chunk graph. The capture
  // predicate is the shared structural boundary: a module not capturable with
  // empty source is an asset, rather than a JS graph node awaiting materialization.
  return !shouldCaptureModule(moduleId, "");
}

interface DemoteReassignedConstantsResult {
  code: string;
  names: string[];
}

function collectBindingNames(name: ts.BindingName, into: Set<string>) {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, into);
    }
  }
}

function collectArrayAssignmentTargetNames(
  elements: ts.NodeArray<ts.Expression>,
  into: Set<string>,
) {
  for (const element of elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    collectAssignmentTargetNames(element, into);
  }
}

function collectObjectAssignmentTargetNames(
  properties: ts.NodeArray<ts.ObjectLiteralElementLike>,
  into: Set<string>,
) {
  for (const property of properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      collectAssignmentTargetNames(property.name, into);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      collectAssignmentTargetNames(property.initializer, into);
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      collectAssignmentTargetNames(property.expression, into);
    }
  }
}

function collectAssignmentTargetNames(
  target: ts.Expression,
  into: Set<string>,
) {
  if (ts.isIdentifier(target)) {
    into.add(target.text);
    return;
  }
  if (ts.isParenthesizedExpression(target)) {
    collectAssignmentTargetNames(target.expression, into);
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    collectArrayAssignmentTargetNames(target.elements, into);
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    collectObjectAssignmentTargetNames(target.properties, into);
    return;
  }
  if (ts.isSpreadElement(target)) {
    collectAssignmentTargetNames(target.expression, into);
  }
}

function noteConstOrAssignment(
  node: ts.Node,
  constNames: Set<string>,
  assignedNames: Set<string>,
) {
  if (
    ts.isVariableDeclarationList(node) &&
    (node.flags & ts.NodeFlags.Const) !== 0
  ) {
    for (const declaration of node.declarations) {
      collectBindingNames(declaration.name, constNames);
    }
    return;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    collectAssignmentTargetNames(node.left, assignedNames);
    return;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    collectAssignmentTargetNames(node.operand, assignedNames);
    return;
  }
  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    collectAssignmentTargetNames(node.initializer, assignedNames);
  }
}

function addArrayAssignedSymbols(
  elements: ts.NodeArray<ts.Expression>,
  checker: ts.TypeChecker,
  assignedSymbols: Set<ts.Symbol>,
) {
  for (const element of elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }
    addTarget(element, checker, assignedSymbols);
  }
}

function addObjectAssignedSymbols(
  properties: ts.NodeArray<ts.ObjectLiteralElementLike>,
  checker: ts.TypeChecker,
  assignedSymbols: Set<ts.Symbol>,
) {
  for (const property of properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      addTarget(property.name, checker, assignedSymbols);
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      addTarget(property.initializer, checker, assignedSymbols);
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      addTarget(property.expression, checker, assignedSymbols);
    }
  }
}

function addTarget(
  target: ts.Expression,
  checker: ts.TypeChecker,
  assignedSymbols: Set<ts.Symbol>,
) {
  if (ts.isIdentifier(target)) {
    const symbol = checker.getSymbolAtLocation(target);
    if (symbol) assignedSymbols.add(symbol);
    return;
  }
  if (ts.isParenthesizedExpression(target)) {
    addTarget(target.expression, checker, assignedSymbols);
    return;
  }
  if (ts.isArrayLiteralExpression(target)) {
    addArrayAssignedSymbols(target.elements, checker, assignedSymbols);
    return;
  }
  if (ts.isObjectLiteralExpression(target)) {
    addObjectAssignedSymbols(target.properties, checker, assignedSymbols);
    return;
  }
  if (ts.isSpreadElement(target)) {
    addTarget(target.expression, checker, assignedSymbols);
  }
}

function assignedNameHitsConst(
  assignedNames: Set<string>,
  constNames: Set<string>,
) {
  if (constNames.size === 0 || assignedNames.size === 0) {
    return false;
  }
  for (const name of assignedNames) {
    if (constNames.has(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Cheap name-based over-approximation of "this module writes a const
 * binding". False positives (shadowed names) still pay for the Program;
 * false negatives would skip a required demotion, so every assignment
 * form the checker walk understands is collected here too.
 */
function moduleMayReassignConst(sourceFile: ts.SourceFile) {
  const constNames = new Set<string>();
  const assignedNames = new Set<string>();
  const visit = (node: ts.Node) => {
    noteConstOrAssignment(node, constNames, assignedNames);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return assignedNameHitsConst(assignedNames, constNames);
}

export function demoteReassignedConstants(
  code: string,
  id = "/__gcc_ts_bundler_capture__.js",
): DemoteReassignedConstantsResult {
  if (!moduleMayReassignConst(getCapturedSourceFile(id, code))) {
    return { code, names: [] };
  }

  const fileName = "/__gcc_ts_bundler_capture__.js";
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? code : undefined);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName
      ? ts.createSourceFile(name, code, languageVersion, true, ts.ScriptKind.JS)
      : undefined;
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) {
    return { code, names: [] };
  }
  const checker = program.getTypeChecker();
  const constLists = new Map<ts.Symbol, ts.VariableDeclarationList>();
  const assignedSymbols = new Set<ts.Symbol>();

  const addBinding = (
    name: ts.BindingName,
    declarationList: ts.VariableDeclarationList,
  ) => {
    if (ts.isIdentifier(name)) {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol) constLists.set(symbol, declarationList);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element))
        addBinding(element.name, declarationList);
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of node.declarations) {
        addBinding(declaration.name, node);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addTarget(node.left, checker, assignedSymbols);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      addTarget(node.operand, checker, assignedSymbols);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      addTarget(node.initializer, checker, assignedSymbols);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const lists = new Set<ts.VariableDeclarationList>();
  const names: string[] = [];
  for (const symbol of assignedSymbols) {
    const declarationList = constLists.get(symbol);
    if (declarationList) {
      lists.add(declarationList);
      names.push(String(symbol.escapedName));
    }
  }
  const edits = [...lists].map((declarationList) => ({
    end: declarationList.getStart(sourceFile) + "const".length,
    start: declarationList.getStart(sourceFile),
    text: "let",
  }));
  return {
    code: edits.length === 0 ? code : applyTextEdits(code, edits),
    names: names.sort(),
  };
}

async function normalizeCapturedCode(
  id: string,
  code: string,
  analysis?: CapturedModuleAnalysis,
  metrics?: ViteBuildMetrics,
) {
  const demoted = demoteReassignedConstants(code, id);
  let nextCode = demoted.code;
  if (demoted.names.length > 0) {
    if (metrics)
      metrics.reassignedConstantDemotionCount += demoted.names.length;
    console.warn(
      `gcc-ts-bundler: changed reassigned const binding(s) to let in ${stripQuery(id)}: ${demoted.names.join(", ")}. The original module would throw when these writes run.`,
    );
  }
  const moduleAnalysis = analysis ?? analyzeModuleCode(id, code);

  // Dependency compatibility syntax is owned downstream: ESM-clean graphs use
  // native Oxc lowering, while ambiguous/CJS graphs use the esbuild prebundle.
  // Lowering it here would either duplicate helpers or erase the routing evidence.
  if (
    moduleAnalysis.needsClosureCompatibilityDownlevel &&
    !isDependencyModuleId(id)
  ) {
    const result = await transformWithEsbuild(nextCode, stripQuery(id), {
      format: "esm",
      loader: resolveEsbuildLoader(id),
      sourcemap: false,
      target: "es2021",
    });
    nextCode = result.code;
  }

  if (
    moduleAnalysis.needsTypeScriptCompatibilityDownlevel &&
    // TypeScript's ES5 class emit turns a subclass into a function that calls
    // `Base.call(this)`. When the base class comes from another module that was
    // not lowered (a real ES6 class, e.g. lit's ReactiveElement), the browser
    // throws "Class constructor cannot be invoked without 'new'". Lowering a
    // whole inheritance chain consistently is not possible per module, so
    // modules that extend a class keep their native syntax; Closure accepts
    // `super` member access in that shape.
    !moduleAnalysis.hasExtendingClass
  ) {
    nextCode = ts.transpileModule(nextCode, {
      compilerOptions: {
        allowJs: true,
        checkJs: false,
        importHelpers: false,
        module: ts.ModuleKind.ESNext,
        sourceMap: false,
        target: ts.ScriptTarget.ES5,
        useDefineForClassFields: false,
      },
      fileName: stripQuery(id),
      reportDiagnostics: false,
    }).outputText;
  }

  return annotateAliasedStaticClassMemberWrites(id, nextCode);
}

/**
 * Vite's decorator lowering can place static class-field initializers on a
 * temporary class alias inside a comma expression. Closure does not connect
 * those writes with static reads inherited through `this`, so annotate the
 * assignments in place instead of changing their evaluation order.
 */
export function annotateAliasedStaticClassMemberWrites(
  id: string,
  code: string,
) {
  const sourceFile = getCapturedSourceFile(id, code);
  const edits: Array<{ end: number; start: number; text: string }> = [];

  const visit = (node: ts.Node) => {
    if (!ts.isVariableStatement(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const declaration = node.declarationList.declarations[0];
    if (
      node.declarationList.declarations.length !== 1 ||
      !declaration ||
      !ts.isIdentifier(declaration.name) ||
      !declaration.initializer
    ) {
      return;
    }

    const expressions = flattenCommaExpression(declaration.initializer);
    const classAssignment = expressions[0];
    const finalExpression = expressions.at(-1);
    if (
      !classAssignment ||
      !finalExpression ||
      expressions.length < 3 ||
      !isAliasedClassAssignment(classAssignment) ||
      !ts.isIdentifier(finalExpression) ||
      finalExpression.text !== classAssignment.left.text
    ) {
      return;
    }

    const staticWrites = expressions.slice(1, -1);
    if (
      staticWrites.length === 0 ||
      !staticWrites.every((write) =>
        isAliasedStaticMemberWrite(write, classAssignment.left.text),
      )
    ) {
      return;
    }

    for (const write of staticWrites) {
      if (
        !ts.isBinaryExpression(write) ||
        !ts.isPropertyAccessExpression(write.left) ||
        code
          .slice(write.getFullStart(), write.getStart(sourceFile))
          .includes("@nocollapse")
      ) {
        continue;
      }
      edits.push({
        end: write.getStart(sourceFile),
        start: write.getStart(sourceFile),
        text: "/** @nocollapse */ ",
      });
    }
  };

  ts.forEachChild(sourceFile, visit);
  return edits.length === 0 ? code : applyTextEdits(code, edits);
}

function flattenCommaExpression(expression: ts.Expression): ts.Expression[] {
  const unwrapped = ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.CommaToken
  ) {
    return [
      ...flattenCommaExpression(unwrapped.left),
      ...flattenCommaExpression(unwrapped.right),
    ];
  }
  return [unwrapped];
}

function isAliasedClassAssignment(
  expression: ts.Expression,
): expression is ts.BinaryExpression & { left: ts.Identifier } {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(expression.left) &&
    ts.isClassExpression(expression.right)
  );
}

function isAliasedStaticMemberWrite(expression: ts.Expression, alias: string) {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(expression.left) &&
    ts.isIdentifier(expression.left.expression) &&
    expression.left.expression.text === alias
  );
}

export async function normalizeRetainedCapturedModules(input: {
  capturedModules: Map<string, CapturedModule>;
  metrics?: ViteBuildMetrics | undefined;
  moduleIds: string[];
}) {
  const normalizedEntries = await Promise.all(
    input.moduleIds.map(
      async (moduleId): Promise<readonly [string, CapturedModule]> => {
        const record = input.capturedModules.get(moduleId);
        if (!record) {
          throw new Error(
            `gccTsBundler() could not normalize retained module ${moduleId}.`,
          );
        }
        const normalizedRecord = await getNormalizedCapturedModule(
          record,
          input.metrics,
        );
        return [moduleId, normalizedRecord];
      },
    ),
  );

  return new Map(normalizedEntries);
}

async function getNormalizedCapturedModule(
  record: CapturedModule,
  metrics?: ViteBuildMetrics,
): Promise<CapturedModule> {
  if (record.normalizedCode !== undefined) {
    const normalizedRecord: CapturedModule = {
      code: record.normalizedCode,
      id: record.id,
      normalizedAnalysis:
        record.normalizedAnalysis ??
        getCapturedModuleAnalysis(record, metrics, "normalized"),
      normalizedCode: record.normalizedCode,
      rawAnalysis:
        record.rawAnalysis ?? getCapturedModuleAnalysis(record, metrics),
    };
    if (record.format !== undefined) {
      normalizedRecord.format = record.format;
    }
    if (record.renderedLength !== undefined) {
      normalizedRecord.renderedLength = record.renderedLength;
    }
    return normalizedRecord;
  }

  const analysis = getCapturedModuleAnalysis(record, metrics);
  const normalizedCode = await normalizeCapturedCode(
    record.id,
    record.code,
    analysis,
    metrics,
  );
  record.normalizedCode = normalizedCode;
  if (normalizedCode === record.code) {
    record.normalizedAnalysis = record.rawAnalysis ?? analysis;
  }
  const normalizedRecord: CapturedModule = {
    code: normalizedCode,
    id: record.id,
    normalizedAnalysis:
      record.normalizedAnalysis ??
      getCapturedModuleAnalysis(record, metrics, "normalized"),
    normalizedCode,
    rawAnalysis: record.rawAnalysis ?? analysis,
  };
  if (record.format !== undefined) {
    normalizedRecord.format = record.format;
  }
  if (record.renderedLength !== undefined) {
    normalizedRecord.renderedLength = record.renderedLength;
  }
  return normalizedRecord;
}

function resolveEsbuildLoader(id: string) {
  const cleanId = stripQuery(id);
  if (cleanId.endsWith(".tsx")) {
    return "tsx";
  }
  if (cleanId.endsWith(".ts")) {
    return "ts";
  }
  if (cleanId.endsWith(".jsx")) {
    return "jsx";
  }
  return "js";
}
