import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";
import type { ResolvedConfig } from "vite";
import type { PluginContext } from "rollup";

import {
  getCapturedModuleAnalysis,
  isAuthoredModuleId,
  isNonMaterializedRetainedModuleId,
  isSupportedExternalSpecifier,
  resolveCapturedSpecifier,
  stripQuery,
  toMaterializedRelativePath,
  toRelativeImportSpecifier,
  type CapturedModuleResolutionCache,
} from "./capture";
import type {
  CapturedModule,
  CapturedRuntimeModule,
  MaterializedGraph,
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
    metrics?: ViteBuildMetrics;
    moduleIds: string[];
    resolutionCache: CapturedModuleResolutionCache;
    srcDir: string;
  },
): Promise<MaterializedGraph> {
  if (input.entryModuleIds.length === 0) {
    this.error("gccTsBundler() could not determine a Vite entry facade.");
  }

  await fs.mkdir(input.srcDir, { recursive: true });
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
  for (const moduleId of materializedModuleIds) {
    const relativePath = toMaterializedRelativePath(
      input.config.root,
      moduleId,
    );
    const filePath = path.join(input.srcDir, relativePath);
    filePathByModuleId.set(moduleId, filePath);
    modules.push({
      filePath,
      id: moduleId,
      relativePath,
      sourceModuleIds: [moduleId],
    });
    if (isAuthoredModuleId(moduleId, input.config.root)) {
      authoredFiles.push(filePath);
    }
  }

  await Promise.all(
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
        filePathByModuleId,
        importerId: moduleId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
      });
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, rewritten, "utf8");
    }),
  );

  const entryFiles = input.entryModuleIds.map((moduleId) => {
    const filePath = filePathByModuleId.get(moduleId);
    if (!filePath) {
      this.error(`Missing captured entry module ${moduleId}.`);
    }
    return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
  });

  return {
    authoredFiles: authoredFiles.sort((left, right) =>
      left.localeCompare(right),
    ),
    entries: entryFiles,
    modules,
    prunedEmptyModuleIds: [...prunedEmptyModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    retainedEmptyModuleIds: retainedEmptyModuleIds.sort((left, right) =>
      left.localeCompare(right),
    ),
    runtimeEntries: materializedModuleIds
      .map((moduleId) => {
        const filePath = filePathByModuleId.get(moduleId);
        if (!filePath) {
          this.error(`Missing captured runtime module ${moduleId}.`);
        }
        return `./${path.relative(input.srcDir, filePath).replace(/\\/g, "/")}`;
      })
      .sort((left, right) => left.localeCompare(right)),
    srcDir: input.srcDir,
  };
}

async function rewriteModuleImports(
  this: PluginContext,
  input: {
    code: string;
    filePathByModuleId: Map<string, string>;
    importerId: string;
    metrics?: ViteBuildMetrics;
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
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      pendingEdits.push(addSpecifierEdit(node.moduleSpecifier, node));
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      pendingEdits.push(addSpecifierEdit(node.arguments[0], node));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  await Promise.all(pendingEdits);

  if (edits.length === 0) {
    return input.code;
  }

  let rewritten = input.code;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten =
      rewritten.slice(0, edit.start) + edit.text + rewritten.slice(edit.end);
  }
  return rewritten;
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
  if (!ts.isImportDeclaration(node) || node.importClause) {
    return false;
  }
  return isNonMaterializedRetainedModuleId(resolvedId);
}
