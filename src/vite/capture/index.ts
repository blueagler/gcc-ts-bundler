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

function visitBindingIdentifiers(
  name: ts.BindingName,
  visit: (identifier: ts.Identifier) => void,
) {
  if (ts.isIdentifier(name)) {
    visit(name);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      visitBindingIdentifiers(element.name, visit);
    }
  }
}

function visitAssignmentIdentifiers(
  target: ts.Expression,
  visit: (identifier: ts.Identifier) => void,
) {
  if (ts.isIdentifier(target)) {
    visit(target);
  } else if (
    ts.isParenthesizedExpression(target) ||
    ts.isSpreadElement(target)
  ) {
    visitAssignmentIdentifiers(target.expression, visit);
  } else if (ts.isArrayLiteralExpression(target)) {
    for (const element of target.elements) {
      if (!ts.isOmittedExpression(element)) {
        visitAssignmentIdentifiers(element, visit);
      }
    }
  } else if (ts.isObjectLiteralExpression(target)) {
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        visitAssignmentIdentifiers(property.name, visit);
      } else if (ts.isPropertyAssignment(property)) {
        visitAssignmentIdentifiers(property.initializer, visit);
      } else if (ts.isSpreadAssignment(property)) {
        visitAssignmentIdentifiers(property.expression, visit);
      }
    }
  }
}

function assignmentTarget(node: ts.Node) {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return node.left;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  if (
    (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    !ts.isVariableDeclarationList(node.initializer)
  ) {
    return node.initializer;
  }
  return undefined;
}

/**
 * Cheap name-based over-approximation; only a matching assignment pays for
 * the scope-aware Program. Both passes share the assignment grammar.
 */
function moduleMayReassignConst(sourceFile: ts.SourceFile) {
  const constNames = new Set<string>();
  const assignedNames = new Set<string>();
  const addConstName = (name: ts.Identifier) => constNames.add(name.text);
  const addAssignedName = (name: ts.Identifier) => assignedNames.add(name.text);
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of node.declarations) {
        visitBindingIdentifiers(declaration.name, addConstName);
      }
    } else {
      const target = assignmentTarget(node);
      if (target) visitAssignmentIdentifiers(target, addAssignedName);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of assignedNames) {
    if (constNames.has(name)) return true;
  }
  return false;
}

export function demoteReassignedConstants(
  code: string,
  id = "/__gcc_ts_bundler_capture__.js",
): DemoteReassignedConstantsResult {
  return demoteReassignedConstantsForRecord({ code, id });
}

function demoteReassignedConstantsForRecord(
  record: CapturedModule,
  metrics?: ViteBuildMetrics,
): DemoteReassignedConstantsResult {
  const { code } = record;
  if (!moduleMayReassignConst(getCapturedSourceFile(record, code, metrics))) {
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

  const addAssignedSymbol = (name: ts.Identifier) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) assignedSymbols.add(symbol);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of node.declarations) {
        visitBindingIdentifiers(declaration.name, (name) => {
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol) constLists.set(symbol, node);
        });
      }
    } else {
      const target = assignmentTarget(node);
      if (target) visitAssignmentIdentifiers(target, addAssignedSymbol);
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
  record: CapturedModule,
  analysis?: CapturedModuleAnalysis,
  metrics?: ViteBuildMetrics,
) {
  const { id } = record;
  const demoted = demoteReassignedConstantsForRecord(record, metrics);
  let nextCode = demoted.code;
  if (demoted.names.length > 0) {
    if (metrics)
      metrics.reassignedConstantDemotionCount += demoted.names.length;
    console.warn(
      `gcc-ts-bundler: changed reassigned const binding(s) to let in ${stripQuery(id)}: ${demoted.names.join(", ")}. The original module would throw when these writes run.`,
    );
  }
  const moduleAnalysis = analysis ?? getCapturedModuleAnalysis(record, metrics);

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

  return nextCode;
}

/**
 * Vite's decorator lowering can place static class-field initializers on a
 * temporary class alias inside a comma expression. Closure does not connect
 * those writes with static reads inherited through `this`, so annotate the
 * assignments in place instead of changing their evaluation order.
 */
export function annotateAliasedStaticClassMemberWrites(
  record: CapturedModule,
  code: string = record.code,
  metrics?: ViteBuildMetrics,
) {
  const sourceFile = getCapturedSourceFile(record, code, metrics);
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
  if (record.normalizedCode === undefined) {
    const analysis = getCapturedModuleAnalysis(record, metrics);
    record.normalizedCode = await normalizeCapturedCode(
      record,
      analysis,
      metrics,
    );
    if (record.normalizedCode === record.code) {
      record.normalizedAnalysis = analysis;
    }
  }
  const normalizedCode = record.normalizedCode;
  const normalizedRecord: CapturedModule = {
    code: normalizedCode,
    id: record.id,
    normalizedAnalysis:
      record.normalizedAnalysis ??
      getCapturedModuleAnalysis(record, metrics, "normalized"),
    normalizedCode,
    rawAnalysis:
      record.rawAnalysis ?? getCapturedModuleAnalysis(record, metrics),
  };
  if (record.parsedSource && record.parsedSource.code === normalizedCode) {
    normalizedRecord.parsedSource = record.parsedSource;
  }
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
