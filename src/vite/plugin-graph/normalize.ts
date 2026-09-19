import ts from "@typescript/typescript6";

import { hashContent } from "../../shared/hash";
import { applyTextEdits, type TextEdit } from "../../shared/text-edits";
import { getCapturedSourceFile } from "../capture-analysis";

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
      input.buildMetrics,
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
  metrics: ViteBuildMetrics,
): ViteAssetPlaceholder[] {
  const canonicalByCurrent: Record<string, string> = {};
  const assetDigestByReferenceId: Record<string, string> = {};
  const fileReferences: ViteAssetPlaceholder[] = [];

  for (const record of capturedModules.values()) {
    fileReferences.push(
      ...canonicalizeFileUrlReferences.call(this, record, bundle, metrics),
    );
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
    return fileReferences;
  }

  for (const record of capturedModules.values()) {
    rewriteAssetPlaceholderTokens(record, replacements);
  }

  return [
    ...fileReferences,
    ...replacements.map(([current, canonical]) => ({ canonical, current })),
  ].sort((left, right) => left.canonical.localeCompare(right.canonical));
}

function canonicalizeFileUrlReferences(
  this: PluginContext,
  record: CapturedModule,
  bundle: OutputBundle,
  metrics: ViteBuildMetrics,
): ViteAssetPlaceholder[] {
  if (!record.code.includes("import.meta")) return [];
  const sourceFile = getCapturedSourceFile(record, record.code, metrics);
  const placeholders: ViteAssetPlaceholder[] = [];
  const edits: TextEdit[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      const match = /^(ROLLDOWN|ROLLUP)_FILE_URL_(.*)$/u.exec(node.name.text);
      if (match?.[2]) {
        // Rolldown's file_url parser uses the fixed 22-character base64url
        // reference width, not an underscore delimiter within the reference.
        // The Rollup-compatible prefix never carries separate URL metadata.
        const reference = match[2];
        const hasUrlId = match[1] === "ROLLDOWN" && reference[22] === "_";
        const referenceId = hasUrlId ? reference.slice(0, 22) : reference;
        const urlId = hasUrlId ? reference.slice(23) || undefined : undefined;
        const fileName = this.getFileName(referenceId);
        const output = bundle[fileName];
        if (!output) {
          this.error(
            `gccTsBundler() could not identify emitted file ${referenceId}.`,
          );
        }
        const content = output.type === "asset" ? output.source : output.code;
        // The host's reference/url ids belong to this output. Only the asset
        // content and reference kind enter compiler input; resolveFileUrl reads
        // the current host metadata again after chunk placement is known.
        const canonical = `__GCC_VITE_FILE_URL__${hashContent(
          `${fileName}\0${String(content)}\0${urlId === undefined ? "asset" : "url"}`,
        )}__`;
        placeholders.push({
          canonical,
          current: node.getText(sourceFile),
          fileReference: { moduleId: record.id, referenceId, urlId },
        });
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: JSON.stringify(canonical),
        });
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (edits.length > 0) {
    record.code = applyTextEdits(record.code, edits);
    record.normalizedCode = record.code;
  }
  return placeholders;
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
