import fs from "node:fs/promises";

import { isString, isUnknownArray, parseJson } from "../../shared/validation";
import type {
  GccRuntimeManifest,
  MaterializedGraph,
  ViteCssOwnership,
} from "../internal-types";
import { buildRuntimeModuleIdMap } from "../chunk-modules";
import { joinPublicPath, stripPublicPathPrefix } from "../output";
import {
  extractRuntimeInitManifest,
  replaceRuntimeInitManifest,
  type RuntimeManifestValue,
} from "../../build/closure/runtime-manifest/init";
import { parseGccRuntimeManifest } from "../../build/closure/runtime-manifest/parse";
import { isRuntimeModuleSourceMap } from "../naming/runtime";
import { normalizePathForLookup } from "./ownership";

export async function augmentCompiledViteCss(input: {
  baseChunkFilePath: string;
  manifestFilePath: string;
  materialized: MaterializedGraph;
  ownership: ViteCssOwnership;
  runtimeModuleSourceMapFilePath: string;
}) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const runtimeModuleSourceMap = parseJson(
    await fs.readFile(input.runtimeModuleSourceMapFilePath, "utf8"),
    isRuntimeModuleSourceMap,
    input.runtimeModuleSourceMapFilePath,
  );
  const runtimeCssByChunkId = collectRuntimeChunkCss({
    htmlLinkedCss: input.ownership.htmlLinkedCss,
    manifest,
    materialized: input.materialized,
    moduleCssById: input.ownership.moduleCssById,
    runtimeModuleSourceMap,
  });

  let manifestChanged = false;
  for (const [chunkId, chunk] of Object.entries(manifest.chunks)) {
    const relativeCss = runtimeCssByChunkId.get(chunkId) ?? [];
    const publicCss = relativeCss.map((fileName) =>
      joinPublicPath(manifest.publicPath, fileName),
    );
    if (!arraysEqual(chunk.css ?? [], publicCss)) {
      chunk.css = publicCss;
      manifestChanged = true;
    }
  }

  if (manifestChanged) {
    await fs.writeFile(
      input.manifestFilePath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }

  const baseChunkSource = await fs.readFile(input.baseChunkFilePath, "utf8");
  const needsRuntimeCssRows = [...runtimeCssByChunkId.values()].some(
    (cssFiles) => cssFiles.length > 0,
  );
  let runtimeManifest: RuntimeManifestValue;
  try {
    runtimeManifest = applyRuntimeCssRows({
      baseChunkSource,
      manifest,
      runtimeCssByChunkId,
    });
  } catch (error) {
    // Eager-only ESM graphs deliberately have no browser runtime manifest.
    // Their CSS is already linked from HTML, so there is no source payload to
    // patch. A non-empty runtime CSS row without the runtime remains a hard
    // error rather than silently dropping lazy stylesheet ownership.
    if (!needsRuntimeCssRows) {
      return;
    }
    throw error;
  }
  const patchedSource = replaceRuntimeInitManifest(
    baseChunkSource,
    runtimeManifest,
  );
  if (patchedSource !== baseChunkSource) {
    await fs.writeFile(input.baseChunkFilePath, patchedSource, "utf8");
  }
}

function collectRuntimeChunkCss(input: {
  htmlLinkedCss: Set<string>;
  manifest: GccRuntimeManifest;
  materialized: MaterializedGraph;
  moduleCssById: Map<string, string[]>;
  runtimeModuleSourceMap: Record<string, string>;
}) {
  const runtimeModuleIdToOriginalIds = buildRuntimeModuleIdMap({
    materialized: input.materialized,
    runtimeModuleSourceMap: input.runtimeModuleSourceMap,
  });
  const normalizedPathCache = new Map<string, string>();
  const moduleCssByRuntimeModuleId = new Map<string, string[]>();
  for (const [runtimeModuleId, originalIds] of runtimeModuleIdToOriginalIds) {
    const cssFiles = new Set<string>();
    for (const originalId of originalIds) {
      const ownedCssFiles = input.moduleCssById.get(
        normalizePathForLookup(originalId, normalizedPathCache),
      );
      if (!ownedCssFiles) {
        continue;
      }
      for (const cssFile of ownedCssFiles) {
        cssFiles.add(cssFile);
      }
    }
    if (cssFiles.size === 0) {
      continue;
    }
    moduleCssByRuntimeModuleId.set(runtimeModuleId, [...cssFiles].sort());
  }

  const runtimeCssByChunkId = new Map<string, string[]>();
  for (const [chunkId, chunk] of Object.entries(input.manifest.chunks)) {
    const cssFiles = new Set<string>();
    for (const runtimeModuleId of chunk.modules) {
      const moduleCss = moduleCssByRuntimeModuleId.get(runtimeModuleId);
      if (!moduleCss) {
        continue;
      }
      for (const cssFile of moduleCss) {
        cssFiles.add(cssFile);
      }
    }

    if (chunkId === input.manifest.baseChunk) {
      for (const htmlLinkedCssFile of input.htmlLinkedCss) {
        cssFiles.delete(htmlLinkedCssFile);
      }
    }

    runtimeCssByChunkId.set(chunkId, [...cssFiles].sort());
  }

  return runtimeCssByChunkId;
}

function applyRuntimeCssRows(input: {
  baseChunkSource: string;
  manifest: GccRuntimeManifest;
  runtimeCssByChunkId: Map<string, string[]>;
}): RuntimeManifestValue {
  const runtimeInitCall = extractRuntimeInitManifest(input.baseChunkSource);
  if (!isUnknownArray(runtimeInitCall.manifest)) {
    throw new Error(
      "gccTsBundler() could not read runtime metadata from the base chunk.",
    );
  }

  const runtimeChunkEntries = runtimeInitCall.manifest[1];
  if (!isUnknownArray(runtimeChunkEntries)) {
    throw new Error(
      "gccTsBundler() could not read runtime chunk metadata from the base chunk.",
    );
  }

  const chunkIdByRelativeUrl = new Map<string, string>();
  for (const [chunkId, chunk] of Object.entries(input.manifest.chunks)) {
    chunkIdByRelativeUrl.set(
      stripPublicPathPrefix(chunk.url, input.manifest.publicPath),
      chunkId,
    );
  }

  runtimeChunkEntries.forEach((entry) => {
    if (!isUnknownArray(entry)) {
      return;
    }
    const rawRelativeUrl = isString(entry[1])
      ? entry[1]
      : String(entry[1] ?? "");
    // The esm loader manifest stores `./name.js` import specifiers; the
    // script loader stores bare names. Match both.
    const relativeUrl = rawRelativeUrl.startsWith("./")
      ? rawRelativeUrl.slice(2)
      : rawRelativeUrl;
    const chunkId =
      relativeUrl.length === 0
        ? input.manifest.baseChunk
        : chunkIdByRelativeUrl.get(relativeUrl);
    if (!chunkId) {
      throw new Error(
        `gccTsBundler() could not match runtime chunk ${relativeUrl} back to the manifest.`,
      );
    }
    entry[2] =
      chunkId === input.manifest.baseChunk
        ? []
        : (input.runtimeCssByChunkId.get(chunkId) ?? []);
  });

  return runtimeInitCall.manifest;
}

function arraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
