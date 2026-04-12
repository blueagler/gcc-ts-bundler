import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";

import type {
  GccRuntimeManifest,
  MaterializedGraph,
  ViteCssOwnership,
} from "./internal-types";
import { joinPublicPath, readAssetText } from "./output";

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
        .map(
          ([moduleId, cssFiles]) =>
            [moduleId, [...cssFiles].sort()] as [string, string[]],
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

export async function augmentCompiledViteCss(input: {
  baseChunkFilePath: string;
  manifestFilePath: string;
  materialized: MaterializedGraph;
  ownership: ViteCssOwnership;
  runtimeModuleSourceMapFilePath: string;
}) {
  const manifest = JSON.parse(
    await fs.readFile(input.manifestFilePath, "utf8"),
  ) as GccRuntimeManifest;
  const runtimeModuleSourceMap = JSON.parse(
    await fs.readFile(input.runtimeModuleSourceMapFilePath, "utf8"),
  ) as Record<string, string>;
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
  const cssByChunkIndex = buildRuntimeCssIndexPatch({
    baseChunkSource,
    manifest,
    runtimeCssByChunkId,
  });
  if (!cssByChunkIndex.some((cssFiles) => cssFiles.length > 0)) {
    return;
  }

  const runtimeInitCall = extractRuntimeInitCall(baseChunkSource);
  const patchedSource =
    baseChunkSource.slice(0, runtimeInitCall.insertIndex) +
    renderRuntimeCssPatch(cssByChunkIndex) +
    baseChunkSource.slice(runtimeInitCall.insertIndex);
  await fs.writeFile(input.baseChunkFilePath, patchedSource, "utf8");
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
    const cssFiles = input.moduleCssById.get(
      normalizePathForLookup(module.id, normalizedPathCache),
    );
    if (!cssFiles || cssFiles.length === 0) {
      continue;
    }
    moduleCssByMaterializedFilePath.set(
      normalizePathForLookup(module.filePath, normalizedPathCache),
      cssFiles,
    );
    moduleCssByRelativePath.set(
      normalizePathForLookup(module.relativePath, normalizedPathCache),
      cssFiles,
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

function buildRuntimeCssIndexPatch(input: {
  baseChunkSource: string;
  manifest: GccRuntimeManifest;
  runtimeCssByChunkId: Map<string, string[]>;
}) {
  const runtimeInitCall = extractRuntimeInitCall(input.baseChunkSource);
  const runtimeChunkEntries = runtimeInitCall.manifest[1];
  if (!Array.isArray(runtimeChunkEntries)) {
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

  const cssByChunkIndex = Array.from(
    { length: runtimeChunkEntries.length },
    () => [] as string[],
  );
  runtimeChunkEntries.forEach((entry, index) => {
    if (!Array.isArray(entry)) {
      return;
    }
    const relativeUrl =
      typeof entry[1] === "string" ? entry[1] : String(entry[1] ?? "");
    const chunkId =
      relativeUrl.length === 0
        ? input.manifest.baseChunk
        : chunkIdByRelativeUrl.get(relativeUrl);
    if (!chunkId) {
      throw new Error(
        `gccTsBundler() could not match runtime chunk ${relativeUrl} back to the manifest.`,
      );
    }
    cssByChunkIndex[index] = input.runtimeCssByChunkId.get(chunkId) ?? [];
  });

  return cssByChunkIndex;
}

function renderRuntimeCssPatch(cssByChunkIndex: string[][]) {
  return `;(function(r){if(!r||!r.k)return;var a=${JSON.stringify(cssByChunkIndex)};for(var i=0;i<a.length;i+=1){var b=a[i];if(!b||b.length===0)continue;var c=r.k[i];if(!c)continue;var d=c[2];if(!d||d.length===0){c[2]=b.slice();continue;}for(var e=0;e<b.length;e+=1)d.indexOf(b[e])<0&&d.push(b[e]);}})(globalThis.__g);`;
}

function extractRuntimeInitCall(sourceText: string) {
  const runtimeMarkerIndex = sourceText.indexOf("__g");
  if (runtimeMarkerIndex < 0) {
    throw new Error("gccTsBundler() could not find the runtime global marker.");
  }

  const applyIndex = sourceText.indexOf(".a(", runtimeMarkerIndex);
  if (applyIndex < 0) {
    throw new Error(
      "gccTsBundler() could not find the runtime manifest init call.",
    );
  }

  const openParenIndex = sourceText.indexOf("(", applyIndex);
  const arrayStartIndex = sourceText.indexOf("[", openParenIndex);
  if (openParenIndex < 0 || arrayStartIndex < 0) {
    throw new Error(
      "gccTsBundler() could not find the runtime manifest payload in the base chunk.",
    );
  }

  const arrayEndIndex = findMatchingDelimiter(
    sourceText,
    arrayStartIndex,
    "[",
    "]",
  );
  const manifestText = sourceText.slice(arrayStartIndex, arrayEndIndex + 1);
  const manifest = Function(`return (${manifestText});`)();
  const closeParenIndex = findMatchingParen(sourceText, openParenIndex);
  let insertIndex = closeParenIndex + 1;
  if (sourceText[insertIndex] === ";") {
    insertIndex += 1;
  }

  return {
    insertIndex,
    manifest,
  };
}

function findMatchingParen(sourceText: string, openParenIndex: number) {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let index = openParenIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character as '"' | "'" | "`";
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error("gccTsBundler() could not parse the runtime manifest call.");
}

function findMatchingDelimiter(
  sourceText: string,
  openIndex: number,
  openCharacter: string,
  closeCharacter: string,
) {
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let index = openIndex; index < sourceText.length; index += 1) {
    const character = sourceText[index];
    if (inString) {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      inString = character as '"' | "'" | "`";
      continue;
    }
    if (character === openCharacter) {
      depth += 1;
      continue;
    }
    if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  throw new Error(
    "gccTsBundler() could not parse the runtime manifest payload.",
  );
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
  const metadata = (
    chunk as OutputChunk & {
      viteMetadata?: { importedCss?: Set<string> };
    }
  ).viteMetadata;
  return [...(metadata?.importedCss ?? new Set<string>())];
}

function stripPublicPathPrefix(url: string, publicPath: string) {
  if (publicPath === "./") {
    return url.startsWith("./") ? url.slice(2) : url;
  }
  if (url.startsWith(publicPath)) {
    return url.slice(publicPath.length);
  }
  return url.replace(/^\/+/u, "");
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
