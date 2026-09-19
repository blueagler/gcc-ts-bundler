import path from "node:path";

import ts from "@typescript/typescript6";
import type { ResolvedConfig } from "vite";
import type { TransformOptions } from "rolldown/utils";

import { syncDirectoryEntries } from "../../shared/files";
import { applyTextEdits } from "../../shared/text-edits";
import { createDefineApplier } from "../defines";
import {
  annotateAliasedStaticClassMemberWrites,
  isNonMaterializedAssetModuleId,
  isSupportedExternalSpecifier,
  resolveCapturedSpecifier,
  stripQuery,
  toRelativeImportSpecifier,
} from "../capture";
import type { CapturedModuleResolutionCache } from "../capture";
import { getCapturedSourceFile } from "../capture-analysis";
import {
  resolveRuntimeResolutionIdentity,
  runtimeResolutionKey,
} from "../type-metadata/provenance";
import type { RuntimeResolutionIdentity } from "../type-metadata/types";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

export async function writeMaterializedModuleCopies(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    config: ResolvedConfig;
    filePathByModuleId: Map<string, string>;
    materializedModuleIds: string[];
    metrics?: ViteBuildMetrics | undefined;
    nativeDefines: TransformOptions["define"];
    resolutionCache: CapturedModuleResolutionCache;
    srcDir: string;
  },
): Promise<RuntimeResolutionIdentity[]> {
  const applyDefines = createDefineApplier(input.nativeDefines);
  const runtimeResolutionByKey = new Map<string, RuntimeResolutionIdentity>();
  const materializedEntries = await Promise.all(
    input.materializedModuleIds.map(async (moduleId) => {
      const record = input.capturedModules.get(moduleId);
      if (!record) {
        this.error(
          `gccTsBundler() could not capture transformed code for ${moduleId}.`,
        );
      }

      const outputPath = input.filePathByModuleId.get(moduleId);
      if (!outputPath) {
        this.error(`Missing materialized output path for ${moduleId}.`);
      }

      const rewritten = await rewriteModuleImports.call(this, {
        conditions: [
          "browser",
          "import",
          ...(input.config.resolve?.conditions ?? []),
        ],
        filePathByModuleId: input.filePathByModuleId,
        record,
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
        content: annotateAliasedStaticClassMemberWrites(
          record,
          applyDefines
            ? await applyDefines(
                rewritten.code,
                moduleId,
                record.format === "cjs" ? "cjs" : "esm",
              )
            : rewritten.code,
          input.metrics,
        ),
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
  return [...runtimeResolutionByKey.values()];
}

async function rewriteModuleImports(
  this: PluginContext,
  input: {
    conditions: string[];
    filePathByModuleId: Map<string, string>;
    record: CapturedModule;
    metrics?: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
  },
) {
  const { code, id: importerId } = input.record;
  const sourceFile = getCapturedSourceFile(input.record, code, input.metrics);
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const runtimeResolutions = new Map<string, RuntimeResolutionIdentity>();
  const pendingEdits: Promise<void>[] = [];

  const addSpecifierEdit = async (
    literal: ts.StringLiteralLike,
    node: ts.ImportDeclaration | ts.ExportDeclaration | ts.CallExpression,
  ) => {
    const specifier = literal.text;
    const resolved = await resolveCapturedSpecifier.call(this, {
      importerId,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      specifier,
    });
    if (resolved && !resolved.external) {
      const runtimeResolution = await resolveRuntimeResolutionIdentity({
        conditions: input.conditions,
        importerModuleId: importerId,
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
        `gccTsBundler() could not materialize ${specifier} imported from ${importerId}. ` +
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
      // A dynamic import Vite never captured cannot be reached from the built graph: Vite emitted
      // no chunk for it, so the same call is equally unreachable in a stock Vite build. This is the
      // shape a dev-only guard leaves behind — `if (import.meta.env.DEV) import("devtool")`, whose
      // branch is already constant-folded dead by the time the module is materialized. Resolving it
      // to an empty module reuses the non-materialized asset replacement above instead of failing a
      // build Vite itself accepted. A *static* import that is missing stays fatal below, because a
      // reachable static import is always captured.
      if (ts.isCallExpression(node)) {
        edits.push({
          end: node.getEnd(),
          start: node.getStart(sourceFile),
          text: "Promise.resolve({})",
        });
        return;
      }
      this.error(
        `gccTsBundler() resolved ${specifier} from ${importerId} to ${resolved.id}, ` +
          "but that transformed module was not captured in the final Vite JS graph.",
      );
    }

    const importerFile = input.filePathByModuleId.get(importerId);
    if (!importerFile) {
      this.error(`Missing importer file path for ${importerId}.`);
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
    code: edits.length === 0 ? code : applyTextEdits(code, edits),
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
