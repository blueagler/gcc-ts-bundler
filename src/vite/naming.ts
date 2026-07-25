import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists } from "../cache/store";
import { firstOrUndefined } from "../internal/arrays";
import { isRecordOf, isString } from "../internal/validation";
import type {
  GccRuntimeManifest,
  MaterializedGraph,
  NormalizedOutputOptions,
  OutputChunk,
  PreRenderedChunk,
} from "./internal-types";
import { joinPublicPath } from "./output";
import {
  extractRuntimeInitManifest,
  parseGccRuntimeManifest,
  replaceRuntimeInitManifest,
} from "./runtime-manifest";

type RenderableChunkInfo = PreRenderedChunk;

interface BaseOutputSeed {
  info: RenderableChunkInfo;
  preferredName: string | null;
}

export interface RenamedNonBaseOutputs {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  emittedOutputFiles: string[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
}

export async function renameCompiledNonBaseJsOutputs(input: {
  baseChunkName: string;
  dynamicRootModuleIds: string[];
  jsChunks: OutputChunk[];
  manifestFilePath: string;
  materialized: MaterializedGraph;
  outDir: string;
  outputFiles: string[];
  outputOptions: NormalizedOutputOptions;
  publicPath: string;
  runtimeModuleSourceMapFilePath: string;
}) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const baseChunkId = manifest.baseChunk;
  const baseChunk = manifest.chunks[baseChunkId];
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not find the base runtime chunk.");
  }

  const runtimeModuleSourceMap = await readJsonIfExists(
    input.runtimeModuleSourceMapFilePath,
    isRuntimeModuleSourceMap,
  );
  const chunkModuleIds = buildChunkModuleIdLookup({
    jsChunks: input.jsChunks,
    manifest,
    materialized: input.materialized,
    runtimeModuleSourceMap: runtimeModuleSourceMap ?? {},
  });
  const dynamicRootModuleIds = new Set(input.dynamicRootModuleIds);
  const renameMap = new Map<string, string>();
  const reservedNames = new Set<string>([
    stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
  ]);
  const outputFilesByRelativePath = new Map(
    input.outputFiles.map((filePath) => [
      path.relative(input.outDir, filePath).replace(/\\/g, "/"),
      filePath,
    ]),
  );

  const nonBaseChunks = Object.entries(manifest.chunks)
    .filter(([chunkId]) => chunkId !== baseChunkId)
    .map(([chunkId, chunk]) => ({
      chunk,
      chunkId,
      oldFileName: stripPublicPathPrefix(chunk.url, manifest.publicPath),
      sourceModuleIds: chunkModuleIds.get(chunkId) ?? new Set<string>(),
    }))
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));

  for (const chunk of nonBaseChunks) {
    const currentFilePath = outputFilesByRelativePath.get(chunk.oldFileName);
    if (!currentFilePath) {
      throw new Error(
        `gccTsBundler() could not locate compiled chunk ${chunk.oldFileName}.`,
      );
    }
    const sourceText = await fs.readFile(currentFilePath, "utf8");
    const preferredSeed = findPreferredRollupChunkSeed({
      chunkModuleIds: chunk.sourceModuleIds,
      dynamicRootModuleIds,
      jsChunks: input.jsChunks,
    });
    const renderableInfo =
      preferredSeed?.info ??
      createFallbackChunkInfo({
        chunkId: chunk.chunkId,
        dynamicRootModuleIds,
        moduleIds: chunk.sourceModuleIds,
      });
    const renderedFileName = ensureUniqueJsFileName(
      preferredSeed?.preferredName ??
        renderPatternFileName(
          input.outputOptions.chunkFileNames,
          renderableInfo,
          sourceText,
          input.outputOptions.format,
        ),
      sourceText,
      reservedNames,
    );
    reservedNames.add(renderedFileName);
    renameMap.set(chunk.oldFileName, renderedFileName);
  }

  if (renameMap.size > 0) {
    const baseChunkFilePath = path.join(
      input.outDir,
      stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
    );
    const baseChunkSource = await fs.readFile(baseChunkFilePath, "utf8");
    const patchedBaseChunk = patchRuntimeChunkUrls(baseChunkSource, renameMap);
    await fs.writeFile(baseChunkFilePath, patchedBaseChunk, "utf8");
  }

  for (const [chunkId, chunk] of Object.entries(manifest.chunks)) {
    if (chunkId === baseChunkId) {
      continue;
    }
    const oldFileName = stripPublicPathPrefix(chunk.url, manifest.publicPath);
    const renamedFileName = renameMap.get(oldFileName);
    if (renamedFileName) {
      chunk.url = joinPublicPath(input.publicPath, renamedFileName);
    }
  }
  await writeManifest(input.manifestFilePath, manifest);

  const renamedOutputFiles = mapOutputFiles(
    input.outputFiles,
    input.outDir,
    renameMap,
  );
  await applyFileRenames(input.outDir, renameMap);

  return {
    baseChunkFilePath: path.join(
      input.outDir,
      stripPublicPathPrefix(baseChunk.url, manifest.publicPath),
    ),
    baseSeed: deriveBaseOutputSeed({
      baseChunkName: input.baseChunkName,
      entryModuleIds: [...(chunkModuleIds.get(baseChunkId)?.values() ?? [])],
      jsChunks: input.jsChunks,
    }),
    emittedOutputFiles: renamedOutputFiles,
    manifest,
    manifestFilePath: input.manifestFilePath,
  } satisfies RenamedNonBaseOutputs;
}

export async function finalizeBaseJsOutputName(input: {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  emittedOutputFiles: string[];
  manifestFilePath: string;
  outputOptions: NormalizedOutputOptions;
  outDir: string;
  publicPath: string;
}) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const baseChunk = manifest.chunks[manifest.baseChunk];
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not resolve the base runtime chunk.");
  }
  const sourceText = await fs.readFile(input.baseChunkFilePath, "utf8");
  const currentBaseFileName = stripPublicPathPrefix(
    baseChunk.url,
    manifest.publicPath,
  );
  const reservedNames = new Set(
    Object.values(manifest.chunks)
      .filter((chunk) => chunk !== baseChunk)
      .map((chunk) => stripPublicPathPrefix(chunk.url, manifest.publicPath)),
  );
  const finalBaseFileName = ensureUniqueJsFileName(
    input.baseSeed.preferredName ??
      renderPatternFileName(
        input.outputOptions.entryFileNames,
        input.baseSeed.info,
        sourceText,
        input.outputOptions.format,
      ),
    sourceText,
    reservedNames,
  );
  if (finalBaseFileName === currentBaseFileName) {
    return {
      baseScriptFileName: finalBaseFileName,
      emittedOutputFiles: input.emittedOutputFiles,
    };
  }

  const renameMap = new Map([[currentBaseFileName, finalBaseFileName]]);
  await applyFileRenames(input.outDir, renameMap);
  baseChunk.url = joinPublicPath(input.publicPath, finalBaseFileName);
  await writeManifest(input.manifestFilePath, manifest);

  return {
    baseScriptFileName: finalBaseFileName,
    emittedOutputFiles: mapOutputFiles(
      input.emittedOutputFiles,
      input.outDir,
      renameMap,
    ),
  };
}

function deriveBaseOutputSeed(input: {
  baseChunkName: string;
  entryModuleIds: string[];
  jsChunks: OutputChunk[];
}): BaseOutputSeed {
  const entryChunks = input.jsChunks.filter((chunk) => chunk.isEntry);
  const onlyEntryChunk = firstOrUndefined(entryChunks);
  if (entryChunks.length === 1 && onlyEntryChunk !== undefined) {
    return {
      info: toRenderableChunkInfo(onlyEntryChunk),
      preferredName: null,
    };
  }

  return {
    info: {
      exports: [],
      facadeModuleId: input.entryModuleIds[0] ?? null,
      isDynamicEntry: false,
      isEntry: true,
      isImplicitEntry: false,
      moduleIds: [...input.entryModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
      name: sanitizeName(input.baseChunkName),
      type: "chunk",
    },
    preferredName: null,
  };
}

function findPreferredRollupChunkSeed(input: {
  chunkModuleIds: Set<string>;
  dynamicRootModuleIds: Set<string>;
  jsChunks: OutputChunk[];
}) {
  const dynamicMatch = input.jsChunks.find(
    (chunk) =>
      chunk.isDynamicEntry &&
      chunk.facadeModuleId &&
      input.chunkModuleIds.has(chunk.facadeModuleId),
  );
  if (dynamicMatch) {
    return {
      info: toRenderableChunkInfo(dynamicMatch),
      preferredName: null,
    };
  }

  const candidates = input.jsChunks
    .map((chunk) => ({
      chunk,
      overlap: countOverlap(
        input.chunkModuleIds,
        new Set(Object.keys(chunk.modules)),
      ),
    }))
    .filter(({ chunk, overlap }) => !chunk.isEntry && overlap > 0)
    .sort((left, right) => {
      if (right.overlap !== left.overlap) {
        return right.overlap - left.overlap;
      }
      if (left.chunk.isDynamicEntry !== right.chunk.isDynamicEntry) {
        return left.chunk.isDynamicEntry ? -1 : 1;
      }
      return left.chunk.name.localeCompare(right.chunk.name);
    });
  const candidate = candidates[0]?.chunk;
  if (!candidate) {
    return null;
  }

  return {
    info: toRenderableChunkInfo(candidate),
    preferredName: null,
  };
}

function createFallbackChunkInfo(input: {
  chunkId: string;
  dynamicRootModuleIds: Set<string>;
  moduleIds: Set<string>;
}): RenderableChunkInfo {
  const dynamicRoot = [...input.moduleIds]
    .filter((moduleId) => input.dynamicRootModuleIds.has(moduleId))
    .sort((left, right) => left.localeCompare(right))[0];
  const name = dynamicRoot
    ? sanitizeName(path.basename(dynamicRoot).replace(/\.[^/.]+$/u, ""))
    : sanitizeName(`shared-${input.chunkId.slice(0, 8)}`);
  return {
    exports: [],
    facadeModuleId: dynamicRoot ?? null,
    isDynamicEntry: Boolean(dynamicRoot),
    isEntry: false,
    isImplicitEntry: false,
    moduleIds: [...input.moduleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    name,
    type: "chunk",
  };
}

function toRenderableChunkInfo(chunk: OutputChunk): RenderableChunkInfo {
  return {
    exports: [...chunk.exports],
    facadeModuleId: chunk.facadeModuleId ?? null,
    isDynamicEntry: chunk.isDynamicEntry,
    isEntry: chunk.isEntry,
    isImplicitEntry: chunk.isImplicitEntry,
    moduleIds: Object.keys(chunk.modules).sort((left, right) =>
      left.localeCompare(right),
    ),
    name: sanitizeName(chunk.name),
    type: "chunk",
  };
}

function renderPatternFileName(
  pattern:
    | NormalizedOutputOptions["chunkFileNames"]
    | NormalizedOutputOptions["entryFileNames"],
  chunkInfo: RenderableChunkInfo,
  sourceText: string,
  format: NormalizedOutputOptions["format"],
) {
  const rendered = typeof pattern === "function" ? pattern(chunkInfo) : pattern;
  return normalizeOutputFileName(
    rendered.replace(/\[(name|format|ext|extname|hash(?::\d+)?)\]/gu, (token) =>
      renderTokenReplacement(token, chunkInfo, sourceText, format),
    ),
  );
}

function renderTokenReplacement(
  token: string,
  chunkInfo: RenderableChunkInfo,
  sourceText: string,
  format: NormalizedOutputOptions["format"],
) {
  if (token === "[name]") {
    return chunkInfo.name;
  }
  if (token === "[format]") {
    return String(format ?? "es");
  }
  if (token === "[ext]") {
    return "js";
  }
  if (token === "[extname]") {
    return ".js";
  }
  const hashMatch = token.match(/^\[hash(?::(\d+))?\]$/u);
  if (hashMatch) {
    const hashLength = Number(hashMatch[1] ?? "8");
    return hashText(sourceText).slice(0, hashLength);
  }
  return token;
}

function hashText(sourceText: string) {
  return createHash("sha256").update(sourceText).digest("base64url");
}

function ensureUniqueJsFileName(
  fileName: string,
  sourceText: string,
  reservedNames: Set<string>,
) {
  const normalized = normalizeOutputFileName(fileName);
  if (!reservedNames.has(normalized)) {
    return normalized;
  }

  const { dir, ext, name } = path.posix.parse(normalized);
  const suffix = hashText(sourceText).slice(0, 8);
  const deduped = normalizeOutputFileName(
    path.posix.join(dir, `${name}-${suffix}${ext || ".js"}`),
  );
  if (reservedNames.has(deduped)) {
    throw new Error(
      `gccTsBundler() could not assign a unique output file name for ${normalized}.`,
    );
  }
  return deduped;
}

function normalizeOutputFileName(fileName: string) {
  return fileName.replace(/\\/g, "/").replace(/^\/+/u, "");
}

function patchRuntimeChunkUrls(
  sourceText: string,
  renameMap: Map<string, string>,
) {
  const runtimeInit = extractRuntimeInitManifest(sourceText);
  const manifest = runtimeInit.manifest;
  if (!Array.isArray(manifest) || !Array.isArray(manifest[1])) {
    throw new Error(
      "gccTsBundler() could not read runtime chunk metadata from the base chunk.",
    );
  }
  for (const entry of manifest[1]) {
    if (!Array.isArray(entry)) {
      continue;
    }
    const relativeUrl = typeof entry[1] === "string" ? entry[1] : "";
    if (!relativeUrl) {
      continue;
    }
    const renamed = renameMap.get(relativeUrl);
    if (renamed) {
      entry[1] = renamed;
    }
  }
  return replaceRuntimeInitManifest(sourceText, manifest);
}

function buildChunkModuleIdLookup(input: {
  jsChunks: OutputChunk[];
  manifest: GccRuntimeManifest;
  materialized: MaterializedGraph;
  runtimeModuleSourceMap: Record<string, string>;
}) {
  const normalizedMaterializedByFilePath = new Map<string, string[]>();
  const normalizedMaterializedByRelativePath = new Map<string, string[]>();
  for (const module of input.materialized.modules) {
    normalizedMaterializedByFilePath.set(normalizePath(module.filePath), [
      ...module.sourceModuleIds,
    ]);
    normalizedMaterializedByRelativePath.set(
      normalizePath(module.relativePath),
      [...module.sourceModuleIds],
    );
  }

  const runtimeModuleIdToOriginalIds = new Map<string, string[]>();
  for (const [runtimeModuleId, sourceFilePath] of Object.entries(
    input.runtimeModuleSourceMap,
  )) {
    const normalizedSourceFilePath = normalizePath(sourceFilePath);
    const matchedOriginalIds =
      normalizedMaterializedByFilePath.get(normalizedSourceFilePath) ??
      findModuleIdByRelativeSuffix(
        normalizedSourceFilePath,
        normalizedMaterializedByRelativePath,
      );
    if (matchedOriginalIds) {
      runtimeModuleIdToOriginalIds.set(runtimeModuleId, [
        ...matchedOriginalIds,
      ]);
    }
  }

  const chunkModuleIds = new Map<string, Set<string>>();
  for (const [chunkId, chunk] of Object.entries(input.manifest.chunks)) {
    const moduleIds = new Set<string>();
    for (const runtimeModuleId of chunk.modules) {
      const originalIds = runtimeModuleIdToOriginalIds.get(runtimeModuleId);
      if (!originalIds) {
        continue;
      }
      for (const originalId of originalIds) {
        moduleIds.add(originalId);
      }
    }
    chunkModuleIds.set(chunkId, moduleIds);
  }

  const entryChunk = input.jsChunks.find((chunk) => chunk.isEntry);
  if (entryChunk && chunkModuleIds.get(input.manifest.baseChunk)?.size === 0) {
    chunkModuleIds.set(
      input.manifest.baseChunk,
      new Set(Object.keys(entryChunk.modules)),
    );
  }

  return chunkModuleIds;
}

function findModuleIdByRelativeSuffix(
  sourceFilePath: string,
  moduleIdByRelativePath: Map<string, string[]>,
) {
  for (const [relativePath, moduleIds] of moduleIdByRelativePath.entries()) {
    if (
      sourceFilePath === relativePath ||
      sourceFilePath.endsWith(`/${relativePath}`)
    ) {
      return moduleIds;
    }
  }
  return undefined;
}

function countOverlap(left: Set<string>, right: Set<string>) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }
  return count;
}

function mapOutputFiles(
  outputFiles: string[],
  outDir: string,
  renameMap: Map<string, string>,
) {
  return outputFiles.map((filePath) => {
    const relativePath = path.relative(outDir, filePath).replace(/\\/g, "/");
    const renamedRelativePath = renameMap.get(relativePath);
    return renamedRelativePath
      ? path.join(outDir, renamedRelativePath)
      : filePath;
  });
}

async function applyFileRenames(
  outDir: string,
  renameMap: Map<string, string>,
) {
  for (const [oldRelativePath, newRelativePath] of renameMap.entries()) {
    if (oldRelativePath === newRelativePath) {
      continue;
    }
    const oldFilePath = path.join(outDir, oldRelativePath);
    const newFilePath = path.join(outDir, newRelativePath);
    await fs.mkdir(path.dirname(newFilePath), { recursive: true });
    await fs.rename(oldFilePath, newFilePath);
  }
}

function sanitizeName(value: string) {
  return value.replace(/[^\w-]/gu, "-").replace(/^-+|-+$/gu, "") || "chunk";
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

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function isRuntimeModuleSourceMap(
  value: unknown,
): value is Record<string, string> {
  return isRecordOf(value, isString);
}

async function writeManifest(filePath: string, manifest: GccRuntimeManifest) {
  await fs.writeFile(
    filePath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
