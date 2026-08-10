import path from "node:path";

import ts from "@typescript/typescript6";
import type { ResolvedConfig } from "vite";

import { syncDirectoryEntries } from "../shared/files";
import { applyTextEdits } from "../shared/text-edits";
import { createDefineApplier } from "./defines";
import {
  getCapturedModuleAnalysis,
  isAuthoredModuleId,
  isNonMaterializedAssetModuleId,
  isSupportedExternalSpecifier,
  resolveCapturedSpecifier,
  stripQuery,
  toMaterializedRelativePath,
  toRelativeImportSpecifier,
  type CapturedModuleResolutionCache,
} from "./capture";
import {
  resolveRuntimeResolutionIdentity,
  runtimeResolutionKey,
} from "./type-metadata/resolution-provenance";
import type { RuntimeResolutionIdentity } from "./type-metadata/types";
import type {
  CapturedModule,
  CapturedRuntimeModule,
  MaterializedGraph,
  PluginContext,
  ViteBuildMetrics,
} from "./internal-types";

export async function materializeCapturedGraph(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    cssModuleIdsWithOwnership?: Iterable<string>;
    config: ResolvedConfig;
    dynamicRootModuleIds: string[];
    entryModuleIds: string[];
    metrics?: ViteBuildMetrics | undefined;
    moduleIds: string[];
    resolutionCache: CapturedModuleResolutionCache;
    srcDir: string;
  },
): Promise<MaterializedGraph> {
  if (input.entryModuleIds.length === 0) {
    this.error("gccTsBundler() could not determine a Vite entry facade.");
  }
  const entryModuleIds = new Set(input.entryModuleIds);
  const dynamicRootModuleIds = new Set(input.dynamicRootModuleIds);
  const cssOwnedModuleIds = new Set(input.cssModuleIdsWithOwnership ?? []);
  const retainedEmptyModuleIds: string[] = [];
  const prunedEmptyModuleIds = new Set<string>();

  for (const moduleId of input.moduleIds) {
    const record = input.capturedModules.get(moduleId);
    if (!record) {
      this.error(
        `gccTsBundler() could not capture transformed code for ${moduleId}.`,
      );
    }

    if (!getCapturedModuleAnalysis(record, input.metrics).isEffectivelyEmpty) {
      continue;
    }
    retainedEmptyModuleIds.push(moduleId);

    if (
      entryModuleIds.has(moduleId) ||
      dynamicRootModuleIds.has(moduleId) ||
      cssOwnedModuleIds.has(moduleId)
    ) {
      continue;
    }
    prunedEmptyModuleIds.add(moduleId);
  }

  const materializedModuleIds = input.moduleIds.filter(
    (moduleId) => !prunedEmptyModuleIds.has(moduleId),
  );
  const filePathByModuleId = new Map<string, string>();
  const modules: CapturedRuntimeModule[] = [];
  const authoredFiles: string[] = [];
  const dependencySourceFileByMaterializedFile: Record<string, string> = {};
  const runtimeResolutionByKey = new Map<string, RuntimeResolutionIdentity>();
  for (const moduleId of materializedModuleIds) {
    const relativePath = toMaterializedRelativePath(
      input.config.root,
      moduleId,
    );
    const filePath = path.join(input.srcDir, relativePath);
    filePathByModuleId.set(moduleId, filePath);
    const record = input.capturedModules.get(moduleId);
    modules.push({
      ...(record?.normalizedAnalysis?.commonJsNamedExports.length
        ? {
            commonJsNamedExports:
              record.normalizedAnalysis.commonJsNamedExports,
          }
        : {}),
      filePath,
      format: record?.format ?? record?.rawAnalysis?.moduleFormat ?? "unknown",
      id: moduleId,
      relativePath,
      ...(record?.renderedLength === undefined
        ? {}
        : { renderedLength: record.renderedLength }),
      sourceModuleIds: [moduleId],
    });
    if (isAuthoredModuleId(moduleId, input.config.root)) {
      authoredFiles.push(filePath);
    } else {
      const sourceFile = stripQuery(moduleId);
      if (path.isAbsolute(sourceFile)) {
        dependencySourceFileByMaterializedFile[path.normalize(filePath)] =
          path.normalize(sourceFile);
      }
    }
  }

  const applyDefines = createDefineApplier(
    input.config.define,
    input.config.env,
  );
  const materializedEntries = await Promise.all(
    materializedModuleIds.map(async (moduleId) => {
      const record = input.capturedModules.get(moduleId);
      if (!record) {
        this.error(
          `gccTsBundler() could not capture transformed code for ${moduleId}.`,
        );
      }

      const outputPath = filePathByModuleId.get(moduleId);
      if (!outputPath) {
        this.error(`Missing materialized output path for ${moduleId}.`);
      }

      const rewritten = await rewriteModuleImports.call(this, {
        code: record.code,
        conditions: [
          "browser",
          "import",
          ...(input.config.resolve?.conditions ?? []),
        ],
        filePathByModuleId,
        importerId: moduleId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
      });
      for (const resolution of rewritten.runtimeResolutions) {
        runtimeResolutionByKey.set(
          runtimeResolutionKey(resolution),
          resolution,
        );
      }
      return {
        content: applyDefines
          ? await applyDefines(
              rewritten.code,
              record.format === "cjs" ? "cjs" : "esm",
            )
          : rewritten.code,
        relativePath: path
          .relative(input.srcDir, outputPath)
          .replace(/\\/g, "/"),
      };
    }),
  );
  for (const dependencyRoot of ["node_modules", "__deps__"]) {
    if (
      materializedEntries.some((entry) =>
        entry.relativePath.startsWith(`${dependencyRoot}/`),
      )
    ) {
      // The nearest real package.json above materialized dependency copies is
      // usually the app's `"type": "module"`. Keep copied CJS wrappers on
      // extension-based semantics before esbuild prebundles them.
      materializedEntries.push({
        content: '{ "type": "commonjs" }\n',
        relativePath: `${dependencyRoot}/package.json`,
      });
    }
  }
  await syncDirectoryEntries(input.srcDir, materializedEntries, {
    preserve(relativePath) {
      return (
        relativePath.startsWith("__dep-bundle-inputs/") ||
        relativePath.startsWith("__dep-bundles/")
      );
    },
  });

  const materializedSpecifier = (moduleId: string, role: string) => {
    const filePath = filePathByModuleId.get(moduleId);
    if (!filePath) {
      this.error(`Missing captured ${role} module ${moduleId}.`);
    }
    return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
  };
  const entryFiles = input.entryModuleIds.map((moduleId) =>
    materializedSpecifier(moduleId, "entry"),
  );

  return {
    authoredFiles: authoredFiles.sort((left, right) =>
      left.localeCompare(right),
    ),
    dependencySourceFileByMaterializedFile,
    entries: entryFiles,
    modules,
    prunedEmptyModuleIds: [...prunedEmptyModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    retainedEmptyModuleIds: retainedEmptyModuleIds.sort((left, right) =>
      left.localeCompare(right),
    ),
    runtimeEntries: materializedModuleIds
      .map((moduleId) => materializedSpecifier(moduleId, "runtime"))
      .sort((left, right) => left.localeCompare(right)),
    runtimeResolutions: [...runtimeResolutionByKey.values()].sort(
      (left, right) =>
        runtimeResolutionKey(left).localeCompare(runtimeResolutionKey(right)),
    ),
    srcDir: input.srcDir,
  };
}

async function rewriteModuleImports(
  this: PluginContext,
  input: {
    code: string;
    conditions: string[];
    filePathByModuleId: Map<string, string>;
    importerId: string;
    metrics?: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
  },
) {
  const sourceFile = ts.createSourceFile(
    input.importerId,
    input.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const runtimeResolutions = new Map<string, RuntimeResolutionIdentity>();
  const pendingEdits: Promise<void>[] = [];

  const addSpecifierEdit = async (
    literal: ts.StringLiteralLike,
    node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
  ) => {
    const specifier = literal.text;
    const resolved = await resolveCapturedSpecifier.call(this, {
      importerId: input.importerId,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      specifier,
    });
    if (resolved && !resolved.external) {
      const runtimeResolution = await resolveRuntimeResolutionIdentity({
        conditions: input.conditions,
        importerModuleId: input.importerId,
        resolvedModuleId: resolved.id,
        specifier,
      });
      if (runtimeResolution) {
        runtimeResolutions.set(
          runtimeResolutionKey(runtimeResolution),
          runtimeResolution,
        );
      }
    }
    if (!resolved || resolved.external) {
      if (isSupportedExternalSpecifier(specifier)) {
        return;
      }
      this.error(
        `gccTsBundler() could not materialize ${specifier} imported from ${input.importerId}. ` +
          "Ensure Vite/plugins lower the resource to a JS module before gccTsBundler() runs.",
      );
    }

    const targetFile = input.filePathByModuleId.get(resolved.id);
    if (!targetFile) {
      const assetReplacement = getNonMaterializedAssetReplacement(node);
      if (
        isNonMaterializedAssetModuleId(resolved.id) &&
        assetReplacement !== undefined
      ) {
        edits.push({
          end: node.getEnd(),
          start: node.getStart(sourceFile),
          text: assetReplacement,
        });
        return;
      }
      if (shouldOmitPrunedImport(node, resolved.id)) {
        edits.push({
          end: node.getEnd(),
          start: node.getStart(sourceFile),
          text: "",
        });
        return;
      }
      this.error(
        `gccTsBundler() resolved ${specifier} from ${input.importerId} to ${resolved.id}, ` +
          "but that transformed module was not captured in the final Vite JS graph.",
      );
    }

    const importerFile = input.filePathByModuleId.get(input.importerId);
    if (!importerFile) {
      this.error(`Missing importer file path for ${input.importerId}.`);
    }

    edits.push({
      end: literal.getEnd() - 1,
      start: literal.getStart() + 1,
      text: toRelativeImportSpecifier(importerFile, targetFile),
    });
  };

  const visit = (node: ts.Node) => {
    const firstArgument = ts.isCallExpression(node)
      ? node.arguments[0]
      : undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pendingEdits.push(addSpecifierEdit(node.moduleSpecifier, node));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      firstArgument !== undefined &&
      ts.isStringLiteralLike(firstArgument)
    ) {
      pendingEdits.push(addSpecifierEdit(firstArgument, node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  await Promise.all(pendingEdits);

  return {
    code: edits.length === 0 ? input.code : applyTextEdits(input.code, edits),
    runtimeResolutions: [...runtimeResolutions.values()],
  };
}

function getNonMaterializedAssetReplacement(
  node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
) {
  if (ts.isCallExpression(node)) {
    return "Promise.resolve({})";
  }
  if (!ts.isImportDeclaration(node)) {
    return undefined;
  }
  if (!node.importClause) {
    return "";
  }
  const bindings = node.importClause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    return `const ${bindings.name.text} = {};`;
  }
  return undefined;
}

function shouldOmitPrunedImport(
  node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
  resolvedId: string,
) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const cleanId = stripQuery(resolvedId);
    if (/\.(?:[cm]?[jt]sx?|mjs|cjs|svelte|vue)$/u.test(cleanId)) {
      return true;
    }
  }
  return false;
}
