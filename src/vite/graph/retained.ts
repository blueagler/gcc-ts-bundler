import {
  classifyModuleId,
  getCapturedModuleAnalysis,
  isNonMaterializedAssetModuleId,
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "../capture";
import { bypassDroppedReexports } from "../dropped-reexports";
import { collectExportDemand } from "./demand";
import type { ExportDemand } from "./demand";
import {
  pruneShakenReexports,
  restoreCapturedModuleCode,
} from "../shaken-exports";
import type {
  CapturedModule,
  OutputChunk,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

export function resolveRetainedModuleIds(
  chunks: OutputChunk[],
  entryModuleIds: string[],
) {
  const moduleIds = new Set<string>(entryModuleIds);
  for (const chunk of chunks) {
    for (const moduleId of Object.keys(chunk.modules)) {
      // Rolldown's public RUNTIME_MODULE_ID identifies linker-generated helpers,
      // not a load/transform module. We rebuild interop from the captured ESM/CJS
      // inputs with native emit and dependency prebundling, not Rolldown's output.
      // Exclude only this chunk-membership evidence: an explicit entry or import
      // still needs a real capture and must fail closed if it is missing.
      if (moduleId !== "\0rolldown/runtime.js") {
        moduleIds.add(moduleId);
      }
    }
  }
  return [...moduleIds].sort((left, right) => left.localeCompare(right));
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
      metrics: input.metrics,
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
