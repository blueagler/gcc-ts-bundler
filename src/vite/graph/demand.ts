import ts from "@typescript/typescript6";

import {
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "../capture";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

/**
 * The export names some importer still asks a module for.
 *
 * `all` means a namespace import, a dynamic import, a `require`, or an entry
 * point: the whole surface is live and nothing about it can be shaken.
 */
export interface ExportDemand {
  all: boolean;
  names: Set<string>;
}

/**
 * Which export names each module still has to provide, as a fixpoint over the
 * re-export chains.
 *
 * A named import demands names; a namespace import, a dynamic import, a
 * `require` and an entry point demand everything, because none of them names
 * what it reads. `export ... from` forwards the demand it received, which is
 * what walks the demand through a chain of barrels down to the module that
 * declares the value.
 */
export async function collectExportDemand(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    materializedModuleIds: Set<string>;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    unshakenModuleIds: readonly string[];
  },
) {
  type Demand = ExportDemand;
  const demands = new Map<string, Demand>();
  const pending: string[] = [];
  const addDemand = (
    moduleId: string,
    all: boolean,
    names: Iterable<string>,
  ) => {
    const demand = demands.get(moduleId) ?? { all: false, names: new Set() };
    const previousSize = demand.names.size;
    const previousAll = demand.all;
    demand.all ||= all;
    for (const name of names) demand.names.add(name);
    demands.set(moduleId, demand);
    if (demand.all !== previousAll || demand.names.size !== previousSize) {
      pending.push(moduleId);
    }
  };
  const resolve = async (specifier: string, importerId: string) => {
    const resolved = await resolveCapturedSpecifier.call(this, {
      importerId,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      specifier,
    });
    return resolved &&
      !resolved.external &&
      input.capturedModules.has(resolved.id)
      ? resolved.id
      : null;
  };

  for (const moduleId of input.unshakenModuleIds) {
    addDemand(moduleId, true, []);
  }
  for (const importerId of input.materializedModuleIds) {
    const record = input.capturedModules.get(importerId);
    if (!record) continue;
    const sourceFile = ts.createSourceFile(
      importerId,
      record.code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const opaqueSpecifiers = new Set<string>();
    const visitOpaqueImports = (node: ts.Node) => {
      const firstArgument = ts.isCallExpression(node)
        ? node.arguments[0]
        : undefined;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        firstArgument !== undefined &&
        ts.isStringLiteralLike(firstArgument)
      ) {
        opaqueSpecifiers.add(firstArgument.text);
      }
      ts.forEachChild(node, visitOpaqueImports);
    };
    visitOpaqueImports(sourceFile);
    for (const specifier of opaqueSpecifiers) {
      const targetId = await resolve(specifier, importerId);
      if (targetId) addDemand(targetId, true, []);
    }

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        statement.importClause?.isTypeOnly ||
        !statement.importClause ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        continue;
      }
      const targetId = await resolve(
        statement.moduleSpecifier.text,
        importerId,
      );
      if (!targetId) continue;
      const names = new Set<string>();
      if (statement.importClause.name) names.add("default");
      const bindings = statement.importClause.namedBindings;
      const all = !!bindings && ts.isNamespaceImport(bindings);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) {
            names.add((element.propertyName ?? element.name).text);
          }
        }
      }
      addDemand(targetId, all, names);
    }
  }

  while (pending.length > 0) {
    const moduleId = pending.pop();
    if (!moduleId) continue;
    const demand = demands.get(moduleId);
    const record = input.capturedModules.get(moduleId);
    if (!demand || !record) continue;
    const sourceFile = ts.createSourceFile(
      moduleId,
      record.code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    // Vite rewrites `export { a } from "m"` into an import plus a local
    // `export { a }`, so a demand chain that only reads the first form stops
    // at the first barrel Vite touched.
    const importBindings = new Map<
      string,
      { imported: string; specifier: string }
    >();
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause ||
        statement.importClause.isTypeOnly ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name) {
        importBindings.set(statement.importClause.name.text, {
          imported: "default",
          specifier,
        });
      }
      const namedBindings = statement.importClause.namedBindings;
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if (!element.isTypeOnly) {
            importBindings.set(element.name.text, {
              imported: (element.propertyName ?? element.name).text,
              specifier,
            });
          }
        }
      }
    }

    for (const statement of sourceFile.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          if (!demand.all && !demand.names.has(element.name.text)) continue;
          const forwarded = importBindings.get(
            (element.propertyName ?? element.name).text,
          );
          if (!forwarded) continue;
          const forwardedId = await resolve(forwarded.specifier, moduleId);
          if (forwardedId) {
            addDemand(forwardedId, false, [forwarded.imported]);
          }
        }
        continue;
      }
      if (
        !ts.isExportDeclaration(statement) ||
        statement.isTypeOnly ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        continue;
      }
      const targetId = await resolve(statement.moduleSpecifier.text, moduleId);
      if (!targetId) continue;
      let targetAll = false;
      const targetNames = new Set<string>();
      if (!statement.exportClause) {
        targetAll = demand.all;
        for (const name of demand.names) {
          if (name !== "default") targetNames.add(name);
        }
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        if (demand.all || demand.names.has(statement.exportClause.name.text)) {
          targetAll = true;
        }
      } else {
        for (const element of statement.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const exportedName = element.name.text;
          if (demand.all || demand.names.has(exportedName)) {
            targetNames.add((element.propertyName ?? element.name).text);
          }
        }
      }
      if (!targetAll && targetNames.size === 0) continue;
      addDemand(targetId, targetAll, targetNames);
    }
  }
  return demands;
}
