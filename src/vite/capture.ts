import path from "node:path";
import { createHash } from "node:crypto";

import ts from "@typescript/typescript6";
import type { ResolvedConfig, transformWithEsbuild } from "vite";

import { hashJson } from "../shared/hash";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type {
  CapturedModule,
  CapturedModuleAnalysis,
  PluginContext,
  ViteBuildMetrics,
} from "./internal-types";

const GCC_CAPTURE_DIR = ".gcc-ts-bundler-vite";

type ViteEsbuildTransform = typeof transformWithEsbuild;

let cachedViteEsbuildTransform: Promise<ViteEsbuildTransform> | null = null;

export type CapturedModuleResolution = Awaited<
  ReturnType<PluginContext["resolve"]>
>;
export type CapturedModuleResolutionCache = Map<
  string,
  Promise<CapturedModuleResolution>
>;

export function resolveViteCaptureRootPath(input: {
  config: Pick<ResolvedConfig, "base" | "mode" | "root" | "build">;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  return path.resolve(
    input.projectRoot,
    GCC_CAPTURE_DIR,
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
      compiler: input.options.compiler ?? {},
      externs: input.options.externs ?? {},
      html: input.options.html ?? {},
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

export function getCapturedModuleAnalysis(
  record: CapturedModule,
  metrics?: ViteBuildMetrics,
  mode: "raw" | "normalized" = "raw",
): CapturedModuleAnalysis {
  const existingAnalysis =
    mode === "normalized" ? record.normalizedAnalysis : record.rawAnalysis;
  if (existingAnalysis) {
    if (metrics) {
      metrics.parseCacheHits += 1;
    }
    return existingAnalysis;
  }
  if (mode === "normalized" && record.normalizedCode === undefined) {
    return getCapturedModuleAnalysis(record, metrics, "raw");
  }
  if (
    mode === "normalized" &&
    record.normalizedCode !== undefined &&
    record.normalizedCode === record.code &&
    record.rawAnalysis
  ) {
    if (metrics) {
      metrics.parseCacheHits += 1;
    }
    record.normalizedAnalysis = record.rawAnalysis;
    return record.normalizedAnalysis;
  }

  if (metrics) {
    metrics.parseCacheMisses += 1;
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

function isDependencyModuleId(id: string) {
  return stripQuery(id).includes("/node_modules/");
}

async function normalizeCapturedCode(
  id: string,
  code: string,
  analysis?: CapturedModuleAnalysis,
) {
  let nextCode = code;
  const moduleAnalysis = analysis ?? analyzeModuleCode(id, code);

  // Dependency modules flow through the region prebundle, which lowers
  // Closure-unsupported syntax once per bundle with esbuild code splitting.
  // Lowering them here instead would duplicate esbuild's private-field
  // helpers into every module that uses them.
  if (
    moduleAnalysis.needsClosureCompatibilityDownlevel &&
    !isDependencyModuleId(id)
  ) {
    const transformWithEsbuild = await loadViteEsbuildTransform();
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
    return {
      code: record.normalizedCode,
      id: record.id,
      normalizedAnalysis:
        record.normalizedAnalysis ??
        getCapturedModuleAnalysis(record, metrics, "normalized"),
      normalizedCode: record.normalizedCode,
      rawAnalysis:
        record.rawAnalysis ?? getCapturedModuleAnalysis(record, metrics),
    };
  }

  const analysis = getCapturedModuleAnalysis(record, metrics);
  const normalizedCode = await normalizeCapturedCode(
    record.id,
    record.code,
    analysis,
  );
  record.normalizedCode = normalizedCode;
  if (normalizedCode === record.code) {
    record.normalizedAnalysis = record.rawAnalysis ?? analysis;
  }
  return {
    code: normalizedCode,
    id: record.id,
    normalizedAnalysis:
      record.normalizedAnalysis ??
      getCapturedModuleAnalysis(record, metrics, "normalized"),
    normalizedCode,
    rawAnalysis: record.rawAnalysis ?? analysis,
  };
}

export async function resolveCapturedSpecifier(
  this: PluginContext,
  input: {
    importerId: string;
    metrics?: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    specifier: string;
  },
) {
  const cacheKey = `${input.importerId}\u0000${input.specifier}`;
  let pendingResolution = input.resolutionCache.get(cacheKey);
  if (!pendingResolution) {
    // Bare package specifiers resolve identically for every importer in the
    // same directory, and most retained-graph edges are repeated package
    // imports (`svelte/internal/client` from dozens of modules).
    const directoryKey = isBarePackageSpecifier(input.specifier)
      ? `\u0001${path.dirname(stripQuery(input.importerId))}\u0000${input.specifier}`
      : null;
    if (directoryKey) {
      pendingResolution = input.resolutionCache.get(directoryKey);
    }
    if (!pendingResolution) {
      if (input.metrics) {
        input.metrics.retainedEdgeResolutionCount += 1;
      }
      pendingResolution = this.resolve(input.specifier, input.importerId, {
        skipSelf: true,
      });
      if (directoryKey) {
        input.resolutionCache.set(directoryKey, pendingResolution);
      }
    }
    input.resolutionCache.set(cacheKey, pendingResolution);
  }
  return await pendingResolution;
}

function isBarePackageSpecifier(specifier: string) {
  return (
    specifier.length > 0 &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\u0000") &&
    !path.isAbsolute(specifier)
  );
}

export function isAuthoredModuleId(moduleId: string, projectRoot: string) {
  const cleanId = stripQuery(moduleId);
  if (cleanId.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  if (!path.isAbsolute(cleanId)) {
    return true;
  }
  return cleanId.startsWith(path.resolve(projectRoot) + path.sep);
}

export function isNonMaterializedRetainedModuleId(moduleId: string) {
  const cleanId = stripQuery(moduleId);
  return /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss)$/u.test(cleanId);
}

export function classifyModuleId(moduleId: string, fallback = "app") {
  const cleanId = stripQuery(moduleId).replace(/\\/g, "/");
  const nodeModulesIndex = cleanId.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) {
    return fallback;
  }

  const packagePath = cleanId.slice(nodeModulesIndex + "/node_modules/".length);
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || fallback;
}

export function stripQuery(id: string) {
  return id.replace(/[?#].*$/u, "");
}

export function toMaterializedRelativePath(
  projectRoot: string,
  moduleId: string,
) {
  const cleanId = stripQuery(moduleId);
  const extension = path.extname(cleanId).replace(/^\./u, "");
  const queryHash =
    cleanId === moduleId
      ? ""
      : `__${hashText(toCanonicalModuleId(projectRoot, moduleId)).slice(0, 8)}`;

  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return path.posix.join(
      "__virtual__",
      `${sanitizeSegment(cleanId)}${queryHash}.js`,
    );
  }

  if (path.isAbsolute(cleanId) && cleanId.startsWith(projectRoot)) {
    const relative = path.relative(projectRoot, cleanId).replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`;
    }
    return `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`;
  }

  const nodeModulesIndex = cleanId.lastIndexOf(
    `${path.sep}node_modules${path.sep}`,
  );
  if (nodeModulesIndex >= 0) {
    const relative = cleanId
      .slice(nodeModulesIndex + `${path.sep}node_modules${path.sep}`.length)
      .replace(/\\/g, "/");
    if (extension === "js" || extension === "mjs" || extension === "cjs") {
      return path.posix.join(
        "__deps__",
        `${relative.replace(/\.[^/.]+$/u, "")}${queryHash}.js`,
      );
    }
    return path.posix.join(
      "__deps__",
      `${relative.replace(/\.[^/.]+$/u, "")}__${extension || "module"}${queryHash}.js`,
    );
  }

  return path.posix.join(
    "__modules__",
    `${sanitizeSegment(cleanId)}${queryHash}.js`,
  );
}

/**
 * Canonical, project-relative identity for a module id. Query-variant hash
 * suffixes in materialized file names must not encode the absolute project
 * location: those names flow into runtime module ids, chunk content, and the
 * manifest, so hashing the raw absolute id makes output bytes and chunk names
 * differ when the same project is built from two directories.
 */
export function toCanonicalModuleId(projectRoot: string, moduleId: string) {
  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return moduleId;
  }
  const cleanId = stripQuery(moduleId);
  const query = moduleId.slice(cleanId.length);
  if (path.isAbsolute(cleanId) && cleanId.startsWith(projectRoot)) {
    return `${path.relative(projectRoot, cleanId).replace(/\\/g, "/")}${query}`;
  }
  const nodeModulesIndex = cleanId.lastIndexOf(
    `${path.sep}node_modules${path.sep}`,
  );
  if (nodeModulesIndex >= 0) {
    const relative = cleanId
      .slice(nodeModulesIndex + `${path.sep}node_modules${path.sep}`.length)
      .replace(/\\/g, "/");
    return `node_modules/${relative}${query}`;
  }
  // Outside the project root and not under node_modules: no stable relative
  // form exists, so the absolute id is the identity.
  return moduleId;
}

export function toRelativeImportSpecifier(fromFile: string, toFile: string) {
  const relativePath = path.relative(path.dirname(fromFile), toFile);
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function isSupportedExternalSpecifier(specifier: string) {
  return specifier.startsWith("node:");
}

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

function sanitizeSegment(value: string) {
  return value.replace(/[^\w./-]+/gu, "-").replace(/^-+/u, "");
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

function analyzeModuleCode(id: string, code: string): CapturedModuleAnalysis {
  const sourceFile = ts.createSourceFile(
    id,
    code,
    ts.ScriptTarget.Latest,
    true,
    resolveScriptKind(id),
  );
  const importSpecifiers = new Set<string>();
  const dynamicImportSpecifiers = new Set<string>();
  const bridgeSpecifiers = new Set<string>();
  let isForwardingOnly = true;
  let hasExtendingClass = false;
  let needsClosureCompatibility = false;
  let needsTypeScriptCompatibility = false;

  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) {
      continue;
    }

    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      importSpecifiers.add(specifier);
      if (statement.importClause) {
        bridgeSpecifiers.add(specifier);
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      importSpecifiers.add(statement.moduleSpecifier.text);
      continue;
    }

    if (isEmptyExportStatement(statement)) {
      continue;
    }

    isForwardingOnly = false;
  }

  const visit = (node: ts.Node) => {
    const firstArgument = ts.isCallExpression(node)
      ? node.arguments[0]
      : undefined;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      firstArgument !== undefined &&
      ts.isStringLiteralLike(firstArgument)
    ) {
      const specifier = firstArgument.text;
      importSpecifiers.add(specifier);
      dynamicImportSpecifiers.add(specifier);
      bridgeSpecifiers.add(specifier);
    }

    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      )
    ) {
      hasExtendingClass = true;
    }

    if (ts.isPrivateIdentifier(node) || isClassStaticBlockNode(node)) {
      needsClosureCompatibility = true;
    }

    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      node.expression.kind === ts.SyntaxKind.SuperKeyword
    ) {
      needsTypeScriptCompatibility = true;
    } else if (ts.isMetaProperty(node)) {
      if (
        node.keywordToken === ts.SyntaxKind.NewKeyword &&
        node.name.escapedText === "target"
      ) {
        needsTypeScriptCompatibility = true;
      }
    } else if (
      (ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isComputedPropertyName(node.name)
    ) {
      needsTypeScriptCompatibility = true;
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    bridgeSpecifiers: [...bridgeSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    dynamicImportSpecifiers: [...dynamicImportSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    importSpecifiers: [...importSpecifiers].sort((left, right) =>
      left.localeCompare(right),
    ),
    isEffectivelyEmpty: sourceFile.statements.every(
      isEffectivelyEmptyStatement,
    ),
    hasExtendingClass,
    isForwardingOnly,
    needsClosureCompatibilityDownlevel: needsClosureCompatibility,
    needsTypeScriptCompatibilityDownlevel: needsTypeScriptCompatibility,
  };
}

function isClassStaticBlockNode(node: ts.Node) {
  return node.kind === ts.SyntaxKind.ClassStaticBlockDeclaration;
}

async function loadViteEsbuildTransform() {
  if (!cachedViteEsbuildTransform) {
    cachedViteEsbuildTransform = import("vite").then(
      (module) => module.transformWithEsbuild,
    );
  }
  return cachedViteEsbuildTransform;
}
