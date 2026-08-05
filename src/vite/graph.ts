import ts from "@typescript/typescript6";

import { readAssetText } from "./output";
import {
  classifyModuleId,
  getCapturedModuleAnalysis,
  isNonMaterializedAssetModuleId,
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "./capture";
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

export async function resolveRetainedCapturedModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: string[];
  },
) {
  const retainedModuleIds = new Set(input.retainedModuleIds);
  const materializedModuleIds = new Set<string>();
  const missingModuleIds = new Set<string>();
  const pendingModuleIds: string[] = [];

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

    const demandedReexportModuleIds =
      await collectDemandedReexportModuleIds.call(this, {
        capturedModules: input.capturedModules,
        materializedModuleIds,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
      });
    if (demandedReexportModuleIds.size === 0) {
      break;
    }
    for (const moduleId of demandedReexportModuleIds) {
      materializedModuleIds.add(moduleId);
      pendingModuleIds.push(moduleId);
    }
  }

  return {
    materializedModuleIds: [...materializedModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    missingModuleIds: [...missingModuleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
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

async function collectDemandedReexportModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    materializedModuleIds: Set<string>;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
  },
) {
  type Demand = { all: boolean; names: Set<string> };
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

  const additions = new Set<string>();
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
    for (const statement of sourceFile.statements) {
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
      if (!input.materializedModuleIds.has(targetId)) additions.add(targetId);
      addDemand(targetId, targetAll, targetNames);
    }
  }
  return additions;
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
  if (
    record.renderedLength === undefined &&
    analysis.isForwardingOnly &&
    classifyModuleId(record.id) !== "app"
  ) {
    for (const specifier of analysis.importSpecifiers) {
      bridgeSpecifiers.add(specifier);
    }
  }
  await Promise.all(
    [...bridgeSpecifiers].map(async (specifier) => {
      const resolved = await resolveCapturedSpecifier.call(this, {
        importerId: input.importerId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
        specifier,
      });
      if (
        !resolved ||
        resolved.external ||
        input.retainedModuleIds.has(resolved.id) ||
        !input.capturedModules.has(resolved.id) ||
        isNonMaterializedAssetModuleId(resolved.id)
      ) {
        return;
      }
      bridgeModuleIds.add(resolved.id);
    }),
  );
  return bridgeModuleIds;
}

function hasFacadeModuleId(
  chunk: OutputChunk,
): chunk is OutputChunk & { facadeModuleId: string } {
  return typeof chunk.facadeModuleId === "string";
}
