import ts from "@typescript/typescript6";
import { isString } from "../shared/validation";

import { readAssetText } from "./output";
import {
  classifyModuleId,
  getCapturedModuleAnalysis,
  isNonMaterializedAssetModuleId,
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "./capture";
import { bypassDroppedReexports } from "./dropped-reexports";
import {
  pruneShakenReexports,
  restoreCapturedModuleCode,
} from "./shaken-exports";
import type {
  CapturedModule,
  OutputBundle,
  OutputChunk,
  PluginContext,
  ViteBuildMetrics,
} from "./internal-types";

export function resolveEntryModuleIds(
  bundle: OutputBundle,
  chunks: OutputChunk[],
) {
  const htmlEntryModuleIds = resolveHtmlEntryModuleIds(bundle, chunks);
  if (htmlEntryModuleIds.length > 0) {
    return htmlEntryModuleIds;
  }

  return chunks
    .filter(hasFacadeModuleId)
    .filter((chunk) => chunk.isEntry)
    .map((chunk) => chunk.facadeModuleId);
}

export function resolveHtmlEntryModuleIds(
  bundle: OutputBundle,
  chunks: OutputChunk[],
) {
  const chunkByFileName = new Map(
    chunks.map((chunk) => [chunk.fileName, chunk]),
  );
  const moduleIds = new Set<string>();

  for (const asset of Object.values(bundle)) {
    if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) {
      continue;
    }
    const html = readAssetText(asset);
    const entryScripts = [
      ...html.matchAll(
        /<script\b[^>]*type=(["'])module\1[^>]*src=(["'])([^"']+)\2[^>]*><\/script>/giu,
      ),
    ];
    for (const match of entryScripts) {
      const sourcePath = match[3];
      if (sourcePath === undefined) {
        continue;
      }
      const chunk = [...chunkByFileName.entries()].find(([fileName]) =>
        sourcePath.endsWith(fileName),
      )?.[1];
      if (chunk?.facadeModuleId) {
        moduleIds.add(chunk.facadeModuleId);
      }
    }
  }

  return [...moduleIds].sort((left, right) => left.localeCompare(right));
}

export function resolveRetainedModuleIds(
  chunks: OutputChunk[],
  entryModuleIds: string[],
) {
  const moduleIds = new Set<string>(entryModuleIds);
  for (const chunk of chunks) {
    for (const moduleId of Object.keys(chunk.modules)) {
      moduleIds.add(moduleId);
    }
  }
  return [...moduleIds].sort((left, right) => left.localeCompare(right));
}

export function resolveDynamicRootModuleIds(chunks: OutputChunk[]) {
  return [
    ...new Set(
      chunks
        .filter(hasFacadeModuleId)
        .filter((chunk) => chunk.isDynamicEntry)
        .map((chunk) => chunk.facadeModuleId),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

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
 * The captured modules the compiler will read, with every re-export nobody
 * demands already shaken out of them.
 *
 * Rollup shook those re-exports before it chunked, so keeping them would leave
 * our module graph a strict superset of the one Rollup split. Shaking makes the
 * walk's own demand chains and the materialized text the same statement set,
 * and shrinks the retained graph in turn, so the two run to a joint fixpoint.
 */
export async function resolveRetainedCapturedModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    metrics: ViteBuildMetrics | undefined;
    projectRoot: string;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: string[];
    unshakenModuleIds: readonly string[];
  },
) {
  restoreCapturedModuleCode(input.capturedModules);
  const retainedModuleIds = new Set(input.retainedModuleIds);
  for (;;) {
    const walked = await walkRetainedCapturedModuleIds.call(this, input);
    // Re-point bindings first, then walk again: shaking a name out of a module
    // is only sound against a demand map read from the text as it stands now.
    const bypassedModuleCount = await bypassDroppedReexports.call(this, {
      capturedModules: input.capturedModules,
      materializedModuleIds: walked.materializedModuleIds,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      retainedModuleIds,
    });
    if (bypassedModuleCount > 0) {
      continue;
    }
    const prunedModuleCount = pruneShakenReexports({
      capturedModules: input.capturedModules,
      demand: walked.demand,
      moduleIds: walked.materializedModuleIds,
      projectRoot: input.projectRoot,
    });
    if (prunedModuleCount === 0) {
      return {
        materializedModuleIds: [...walked.materializedModuleIds].sort(
          (left, right) => left.localeCompare(right),
        ),
        missingModuleIds: [...walked.missingModuleIds].sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    }
  }
}

async function walkRetainedCapturedModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    metrics: ViteBuildMetrics | undefined;
    projectRoot: string;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: string[];
    unshakenModuleIds: readonly string[];
  },
) {
  const retainedModuleIds = new Set(input.retainedModuleIds);
  const materializedModuleIds = new Set<string>();
  const missingModuleIds = new Set<string>();
  const pendingModuleIds: string[] = [];
  let demand: Map<string, ExportDemand> | undefined;

  for (const moduleId of input.retainedModuleIds) {
    if (input.capturedModules.has(moduleId)) {
      materializedModuleIds.add(moduleId);
      pendingModuleIds.push(moduleId);
      continue;
    }

    if (isNonMaterializedAssetModuleId(moduleId)) {
      continue;
    }

    missingModuleIds.add(moduleId);
  }

  for (;;) {
    while (pendingModuleIds.length > 0) {
      const moduleId = pendingModuleIds.pop();
      if (!moduleId) {
        continue;
      }

      const bridgeModuleIds = await collectBridgeModuleIds.call(this, {
        analysisMode: "raw",
        analysisModules: input.capturedModules,
        capturedModules: input.capturedModules,
        importerId: moduleId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
        retainedModuleIds,
      });
      for (const bridgeModuleId of bridgeModuleIds) {
        if (materializedModuleIds.has(bridgeModuleId)) {
          continue;
        }
        materializedModuleIds.add(bridgeModuleId);
        pendingModuleIds.push(bridgeModuleId);
      }
    }

    demand = await collectExportDemand.call(this, {
      capturedModules: input.capturedModules,
      materializedModuleIds,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      unshakenModuleIds: input.unshakenModuleIds,
    });
    const demandedModuleIds = [...demand.keys()].filter(
      (moduleId) =>
        !materializedModuleIds.has(moduleId) &&
        !isNonMaterializedAssetModuleId(moduleId),
    );
    if (demandedModuleIds.length === 0) {
      break;
    }
    for (const moduleId of demandedModuleIds) {
      materializedModuleIds.add(moduleId);
      pendingModuleIds.push(moduleId);
    }
  }

  return {
    demand: demand ?? new Map<string, ExportDemand>(),
    materializedModuleIds,
    missingModuleIds,
  };
}

export async function resolveNormalizedBridgeModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    metrics: ViteBuildMetrics | undefined;
    normalizedCapturedModules: Map<string, CapturedModule>;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: string[];
  },
) {
  const retainedModuleIds = new Set(input.retainedModuleIds);
  const additionalModuleIds = new Set<string>();
  const pendingModuleIds = [...input.retainedModuleIds];

  while (pendingModuleIds.length > 0) {
    const moduleId = pendingModuleIds.pop();
    if (!moduleId) {
      continue;
    }

    if (!input.normalizedCapturedModules.has(moduleId)) {
      continue;
    }

    const bridgeModuleIds = await collectBridgeModuleIds.call(this, {
      analysisMode: "normalized",
      analysisModules: input.normalizedCapturedModules,
      capturedModules: input.capturedModules,
      importerId: moduleId,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      retainedModuleIds,
    });
    for (const bridgeModuleId of bridgeModuleIds) {
      if (
        retainedModuleIds.has(bridgeModuleId) ||
        additionalModuleIds.has(bridgeModuleId)
      ) {
        continue;
      }
      additionalModuleIds.add(bridgeModuleId);
      pendingModuleIds.push(bridgeModuleId);
    }
  }

  return [...additionalModuleIds].sort((left, right) =>
    left.localeCompare(right),
  );
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
async function collectExportDemand(
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

export function summarizeModuleIdsByPackage(moduleIds: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const moduleId of moduleIds) {
    const bucket = classifyModuleId(moduleId);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) =>
      right[1] === left[1]
        ? left[0].localeCompare(right[0])
        : right[1] - left[1],
    )
    .map(([bucket, count]) => `${bucket}:${count}`)
    .join(", ");
}

async function collectBridgeModuleIds(
  this: PluginContext,
  input: {
    analysisMode: "raw" | "normalized";
    analysisModules: Map<string, CapturedModule>;
    capturedModules: Map<string, CapturedModule>;
    importerId: string;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: Set<string>;
  },
) {
  const record = input.analysisModules.get(input.importerId);
  if (!record) {
    return new Set<string>();
  }

  const bridgeModuleIds = new Set<string>();
  const analysis = getCapturedModuleAnalysis(
    record,
    input.metrics,
    input.analysisMode,
  );
  const bridgeSpecifiers = new Set(analysis.bridgeSpecifiers);
  for (const specifier of analysis.importSpecifiers) {
    if (isBarePackageSpecifier(specifier)) {
      bridgeSpecifiers.add(specifier);
    }
  }
  if (
    record.renderedLength === undefined &&
    analysis.isForwardingOnly &&
    classifyModuleId(record.id) !== "app"
  ) {
    for (const specifier of analysis.importSpecifiers) {
      bridgeSpecifiers.add(specifier);
    }
  }
  // Capture records every source-level `import()` argument, including ones in
  // branches the build later proves dead: `if (import.meta.env.DEV) import(x)`
  // folds to `false` in a production build and the call is eliminated. Such an
  // edge either resolves to nothing or resolves to a module Vite never
  // captured, and in both cases Vite emits no chunk for it, so the built graph
  // cannot reach that module no matter what this plugin does. Dropping the edge
  // matches Vite's own decision instead of papering over a gap. A missing
  // *static* edge stays fatal: a reachable static import is always captured, so
  // its absence is a genuine routing gap.
  const dynamicImportSpecifiers = new Set(analysis.dynamicImportSpecifiers);
  await Promise.all(
    [...bridgeSpecifiers].map(async (specifier) => {
      const resolved = await resolveCapturedSpecifier.call(this, {
        importerId: input.importerId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
        specifier,
      });
      if (!resolved || resolved.external) {
        if (isBarePackageSpecifier(specifier)) {
          if (dynamicImportSpecifiers.has(specifier)) {
            if (input.metrics) {
              input.metrics.deadDynamicEdgeDropCount += 1;
            }
            return;
          }
          throw new Error(
            `gccTsBundler() could not route package edge ${JSON.stringify(specifier)} from ${input.importerId}: Vite did not resolve it to a captured module.`,
          );
        }
        return;
      }
      if (
        input.retainedModuleIds.has(resolved.id) ||
        isNonMaterializedAssetModuleId(resolved.id)
      ) {
        return;
      }
      if (!input.capturedModules.has(resolved.id)) {
        if (isBarePackageSpecifier(specifier)) {
          if (dynamicImportSpecifiers.has(specifier)) {
            if (input.metrics) {
              input.metrics.deadDynamicEdgeDropCount += 1;
            }
            return;
          }
          throw new Error(
            `gccTsBundler() could not route package edge ${input.importerId} -> ${JSON.stringify(specifier)} -> ${resolved.id}: the resolved module was not captured by Vite.`,
          );
        }
        return;
      }
      bridgeModuleIds.add(resolved.id);
    }),
  );
  return bridgeModuleIds;
}

function isBarePackageSpecifier(specifier: string) {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("~") &&
    !specifier.includes(":")
  );
}

function hasFacadeModuleId(
  chunk: OutputChunk,
): chunk is OutputChunk & { facadeModuleId: string } {
  return isString(chunk.facadeModuleId);
}
