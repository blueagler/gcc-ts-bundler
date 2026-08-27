import { hashContent } from "../../shared/hash";

import { normalizeRetainedCapturedModules } from "../capture";
import type { CapturedModuleResolutionCache } from "../capture";
import { resolveNormalizedBridgeModuleIds } from "../graph";
import type {
  CapturedModule,
  OutputBundle,
  PluginContext,
  ViteAssetPlaceholder,
  ViteBuildMetrics,
} from "../internal-types";
import { measureAsync } from "../plugin-compile";
import type { ViteTimingTotals } from "./index";

export async function normalizeCapturedGraph(
  this: PluginContext,
  input: {
    bundle: OutputBundle;
    buildMetrics: ViteBuildMetrics;
    capturedModules: Map<string, CapturedModule>;
    initialModuleIds: string[];
    resolutionCache: CapturedModuleResolutionCache;
    timingTotals: ViteTimingTotals;
  },
) {
  return measureAsync(input.timingTotals, "normalizeRetainedMs", async () => {
    let moduleIds = [...input.initialModuleIds];
    const normalizedCapturedModules = await normalizeRetainedCapturedModules({
      capturedModules: input.capturedModules,
      metrics: input.buildMetrics,
      moduleIds,
    });

    for (;;) {
      const bridgeModuleIds = await resolveNormalizedBridgeModuleIds.call(
        this,
        {
          capturedModules: input.capturedModules,
          metrics: input.buildMetrics,
          normalizedCapturedModules,
          resolutionCache: input.resolutionCache,
          retainedModuleIds: moduleIds,
        },
      );
      if (bridgeModuleIds.length === 0) {
        break;
      }
      const bridgeModules = await normalizeRetainedCapturedModules({
        capturedModules: input.capturedModules,
        metrics: input.buildMetrics,
        moduleIds: bridgeModuleIds,
      });
      for (const [moduleId, record] of bridgeModules) {
        normalizedCapturedModules.set(moduleId, record);
      }
      moduleIds = [...new Set([...moduleIds, ...bridgeModuleIds])].sort(
        (left, right) => left.localeCompare(right),
      );
    }

    input.buildMetrics.normalizedRetainedModuleCount =
      normalizedCapturedModules.size;
    const assetPlaceholders = canonicalizeViteAssetPlaceholders.call(
      this,
      normalizedCapturedModules,
      input.bundle,
    );
    return {
      assetPlaceholders,
      capturedModules: normalizedCapturedModules,
      moduleIds,
    };
  });
}

const VITE_ASSET_PLACEHOLDER = /__VITE_ASSET__([\w$]+)__(?:\$_(.*?)__)?/gu;

function canonicalizeViteAssetPlaceholders(
  this: PluginContext,
  capturedModules: Map<string, CapturedModule>,
  bundle: OutputBundle,
): ViteAssetPlaceholder[] {
  const canonicalByCurrent: Record<string, string> = {};
  const assetDigestByReferenceId: Record<string, string> = {};

  for (const record of capturedModules.values()) {
    for (const match of record.code.matchAll(VITE_ASSET_PLACEHOLDER)) {
      collectCanonicalAssetToken.call(
        this,
        match,
        bundle,
        canonicalByCurrent,
        assetDigestByReferenceId,
      );
    }
  }

  const replacements = Object.entries(canonicalByCurrent);
  if (replacements.length === 0) {
    return [];
  }

  for (const record of capturedModules.values()) {
    rewriteAssetPlaceholderTokens(record, replacements);
  }

  return replacements
    .map(([current, canonical]) => ({ canonical, current }))
    .sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function collectCanonicalAssetToken(
  this: PluginContext,
  match: RegExpExecArray,
  bundle: OutputBundle,
  canonicalByCurrent: Record<string, string>,
  assetDigestByReferenceId: Record<string, string>,
) {
  const current = match[0];
  const referenceId = match[1];
  if (!referenceId || current in canonicalByCurrent) {
    return;
  }
  const fileName = this.getFileName(referenceId);
  const output = bundle[fileName];
  if (!output || output.type !== "asset") {
    this.error(
      `gccTsBundler() could not identify Vite asset reference ${referenceId}.`,
    );
  }
  let assetDigest = assetDigestByReferenceId[referenceId];
  if (!assetDigest) {
    assetDigest = hashContent(`${fileName}\0${String(output.source)}`);
    assetDigestByReferenceId[referenceId] = assetDigest;
  }
  canonicalByCurrent[current] = `__GCC_VITE_ASSET__${hashContent(
    `${assetDigest}\0${match[2] ?? ""}`,
  )}__`;
}

function rewriteAssetPlaceholderTokens(
  record: CapturedModule,
  replacements: Array<[string, string]>,
) {
  let code = record.code;
  for (const [current, canonical] of replacements) {
    code = code.replaceAll(current, canonical);
  }
  if (code !== record.code) {
    record.code = code;
    record.normalizedCode = code;
  }
}
