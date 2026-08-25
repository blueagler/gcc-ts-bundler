import syncFs from "node:fs";
import path from "node:path";

import { isRecord, isString } from "../../shared/validation";
import type {
  OutputAsset,
  OutputBundle,
  OutputChunk,
  ViteCssOwnership,
} from "../internal-types";
import { readAssetText } from "../output";

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

function getImportedCss(chunk: OutputChunk) {
  if (!("viteMetadata" in chunk) || !isRecord(chunk.viteMetadata)) {
    return [];
  }
  const importedCss = chunk.viteMetadata.importedCss;
  if (!(importedCss instanceof Set)) {
    return [];
  }
  return [...importedCss].filter(isString);
}

export function normalizePathForLookup(id: string, cache: Map<string, string>) {
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
