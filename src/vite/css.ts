import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  isRecord,
  isRecordOf,
  isString,
  isUnknownArray,
  parseJson,
} from "../shared/validation";
import type {
  GccRuntimeManifest,
  MaterializedGraph,
  OutputAsset,
  OutputBundle,
  OutputChunk,
  ViteCssOwnership,
} from "./internal-types";
import { joinPublicPath, readAssetText, stripPublicPathPrefix } from "./output";
import {
  extractRuntimeInitManifest,
  parseGccRuntimeManifest,
  replaceRuntimeInitManifest,
} from "./runtime-manifest";

export function analyzeViteCssOwnership(
  bundle: OutputBundle,
): ViteCssOwnership {
  const chunks = Object.values(bundle).filter(
    (item): item is OutputChunk => item.type === "chunk",
  );
  const chunkByFileName = new Map(
    chunks.map((chunk) => [chunk.fileName, chunk]),
  );
  const htmlLinkedCss = collectHtmlLinkedCss(bundle);
  const moduleCss = new Map<string, Set<string>>();
  const transitiveCssMemo = new Map<string, Set<string>>();
  const normalizedModuleIdCache = new Map<string, string>();

  const getTransitiveCss = (fileName: string, seen = new Set<string>()) => {
    const cached = transitiveCssMemo.get(fileName);
    if (cached) {
      return cached;
    }

    const chunk = chunkByFileName.get(fileName);
    if (!chunk || seen.has(fileName)) {
      return new Set<string>();
    }

    seen.add(fileName);
    const css = new Set<string>(getImportedCss(chunk));
    for (const importedFile of chunk.imports) {
      const importedCss = getTransitiveCss(importedFile, seen);
      for (const cssFile of importedCss) {
        css.add(cssFile);
      }
    }
    transitiveCssMemo.set(fileName, css);
    seen.delete(fileName);
    return css;
  };

  for (const chunk of chunks) {
    const allCss = new Set<string>(getImportedCss(chunk));
    const staticChildCss = new Set<string>();
    for (const importedFile of chunk.imports) {
      const importedCss = getTransitiveCss(importedFile);
      for (const cssFile of importedCss) {
        staticChildCss.add(cssFile);
      }
    }

    const ownCss = [...allCss].filter(
      (cssFile) => !staticChildCss.has(cssFile),
    );
    if (ownCss.length === 0) {
      continue;
    }

    for (const moduleId of Object.keys(chunk.modules)) {
      const normalizedModuleId = normalizePathForLookup(
        moduleId,
        normalizedModuleIdCache,
      );
      const existing = moduleCss.get(normalizedModuleId) ?? new Set<string>();
      for (const cssFile of ownCss) {
        existing.add(cssFile);
      }
      moduleCss.set(normalizedModuleId, existing);
    }
  }

  return {
    enabled: true,
    htmlLinkedCss,
    moduleCssById: new Map<string, string[]>(
      [...moduleCss.entries()]
        .map(([moduleId, cssFiles]): [string, string[]] => [
          moduleId,
          [...cssFiles].sort(),
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

/**
 * Whether the compiled runtime will ever need its `<link>` loader.
 *
 * Runs before the compile, because the runtime preamble is Closure *input* and
 * the CSS rows are only written afterwards. A CSS file already linked from the
 * HTML is subtracted: `collectRuntimeChunkCss` drops those from the base
 * chunk, and for any other chunk the row would only re-request a stylesheet
 * the document already has. Fail-closed: anything left means the loader ships.
 */
export function ownershipNeedsCssRuntime(ownership: ViteCssOwnership) {
  if (!ownership.enabled) {
    return false;
  }
  for (const cssFiles of ownership.moduleCssById.values()) {
    for (const cssFile of cssFiles) {
      if (!ownership.htmlLinkedCss.has(cssFile)) {
        return true;
      }
    }
  }
  return false;
}

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
  const runtimeManifest = applyRuntimeCssRows({
    baseChunkSource,
    manifest,
    runtimeCssByChunkId,
  });
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
  const moduleCssByMaterializedFilePath = new Map<string, string[]>();
  const moduleCssByRelativePath = new Map<string, string[]>();
  const normalizedPathCache = new Map<string, string>();
  for (const module of input.materialized.modules) {
    const cssFiles = new Set<string>();
    for (const sourceModuleId of module.sourceModuleIds) {
      const ownedCssFiles = input.moduleCssById.get(
        normalizePathForLookup(sourceModuleId, normalizedPathCache),
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
    const sortedCssFiles = [...cssFiles].sort();
    moduleCssByMaterializedFilePath.set(
      normalizePathForLookup(module.filePath, normalizedPathCache),
      sortedCssFiles,
    );
    moduleCssByRelativePath.set(
      normalizePathForLookup(module.relativePath, normalizedPathCache),
      sortedCssFiles,
    );
  }

  const moduleCssByRuntimeModuleId = new Map<string, string[]>();
  for (const [runtimeModuleId, sourceFilePath] of Object.entries(
    input.runtimeModuleSourceMap,
  )) {
    const normalizedSourceFilePath = normalizePathForLookup(
      sourceFilePath,
      normalizedPathCache,
    );
    const cssFiles =
      moduleCssByMaterializedFilePath.get(normalizedSourceFilePath) ??
      findCssByRelativePathSuffix(
        normalizedSourceFilePath,
        moduleCssByRelativePath,
      );
    if (!cssFiles || cssFiles.length === 0) {
      continue;
    }
    moduleCssByRuntimeModuleId.set(runtimeModuleId, cssFiles);
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
}) {
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
    const rawRelativeUrl =
      typeof entry[1] === "string" ? entry[1] : String(entry[1] ?? "");
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

function collectHtmlLinkedCss(bundle: OutputBundle) {
  const cssAssets = Object.values(bundle).filter(
    (asset): asset is OutputAsset =>
      asset.type === "asset" && asset.fileName.endsWith(".css"),
  );
  const linkedCss = new Set<string>();

  for (const asset of Object.values(bundle)) {
    if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) {
      continue;
    }
    const html = readAssetText(asset);
    const matches = [
      ...html.matchAll(
        /<link\b[^>]*rel=(["'])stylesheet\1[^>]*href=(["'])([^"']+)\2[^>]*\/?>/giu,
      ),
    ];
    for (const match of matches) {
      const href = match[3];
      if (href === undefined) {
        continue;
      }
      const cssAsset = cssAssets.find((candidate) =>
        href.endsWith(candidate.fileName),
      );
      if (cssAsset) {
        linkedCss.add(cssAsset.fileName);
      }
    }
  }

  return linkedCss;
}

function isRuntimeModuleSourceMap(
  value: unknown,
): value is Record<string, string> {
  return isRecordOf(value, isString);
}

function getImportedCss(chunk: OutputChunk) {
  if (!("viteMetadata" in chunk) || !isRecord(chunk.viteMetadata)) {
    return [];
  }
  const importedCss = chunk.viteMetadata.importedCss;
  if (!(importedCss instanceof Set)) {
    return [];
  }
  return [...importedCss].filter(
    (fileName): fileName is string => typeof fileName === "string",
  );
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

function findCssByRelativePathSuffix(
  sourceFilePath: string,
  moduleCssByRelativePath: Map<string, string[]>,
) {
  for (const [relativePath, cssFiles] of moduleCssByRelativePath.entries()) {
    if (
      sourceFilePath === relativePath ||
      sourceFilePath.endsWith(`/${relativePath}`)
    ) {
      return cssFiles;
    }
  }
  return undefined;
}

function normalizePathForLookup(id: string, cache: Map<string, string>) {
  const cached = cache.get(id);
  if (cached) {
    return cached;
  }

  const cleanId = id.replace(/[?#].*$/u, "");
  let normalized = cleanId;
  if (path.isAbsolute(cleanId)) {
    try {
      normalized = syncFs.realpathSync.native(cleanId);
    } catch {
      normalized = cleanId;
    }
  }

  const lookupPath = normalized.replace(/\\/gu, "/");
  cache.set(id, lookupPath);
  return lookupPath;
}
