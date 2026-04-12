import type { OutputBundle, OutputChunk, PluginContext } from "rollup";

import {
  classifyModuleId,
  getCapturedModuleAnalysis,
  isNonMaterializedRetainedModuleId,
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "./capture";
import type { CapturedModule, ViteBuildMetrics } from "./internal-types";

export function resolveEntryModuleIds(
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
      const chunk = [...chunkByFileName.entries()].find(([fileName]) =>
        sourcePath.endsWith(fileName),
      )?.[1];
      if (chunk?.facadeModuleId) {
        moduleIds.add(chunk.facadeModuleId);
      }
    }
  }

  if (moduleIds.size > 0) {
    return [...moduleIds];
  }

  return chunks
    .filter((chunk) => chunk.isEntry && chunk.facadeModuleId)
    .map((chunk) => chunk.facadeModuleId as string);
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
        .filter((chunk) => chunk.isDynamicEntry && chunk.facadeModuleId)
        .map((chunk) => chunk.facadeModuleId as string),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

export async function resolveRetainedCapturedModuleIds(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    metrics?: ViteBuildMetrics;
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

    if (isNonMaterializedRetainedModuleId(moduleId)) {
      continue;
    }

    missingModuleIds.add(moduleId);
  }

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
    metrics?: ViteBuildMetrics;
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
    metrics?: ViteBuildMetrics;
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
  await Promise.all(
    analysis.bridgeSpecifiers.map(async (specifier) => {
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
        isNonMaterializedRetainedModuleId(resolved.id)
      ) {
        return;
      }
      bridgeModuleIds.add(resolved.id);
    }),
  );
  return bridgeModuleIds;
}

function readAssetText(asset: { source: string | Uint8Array }) {
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf8");
}
