import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readJsonIfExists } from "../shared/cache-store";
import { firstOrUndefined } from "../shared/arrays";
import { isRecordOf, isString } from "../shared/validation";
import type {
  GccRuntimeManifest,
  MaterializedGraph,
  NormalizedOutputOptions,
  OutputChunk,
  PreRenderedChunk,
  ViteChunkOutputType,
} from "./internal-types";
import { joinPublicPath, stripPublicPathPrefix } from "./output";
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

/**
 * A non-base chunk whose final name has been deferred to the finalize pass.
 * Under ES module output every chunk name is embedded in its siblings, so
 * names cannot be assigned until every chunk's final bytes exist (see
 * `finalizeEsmChunkNames`).
 */
interface DeferredChunkSeed {
  chunkId: string;
  info: RenderableChunkInfo;
  preferredName: string | null;
}

export interface RenamedNonBaseOutputs {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifest: GccRuntimeManifest;
  manifestFilePath: string;
}

export async function renameCompiledNonBaseJsOutputs(input: {
  baseChunkName: string;
  chunkOutputType: ViteChunkOutputType;
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
  const deferNaming = input.chunkOutputType === "esm";
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
  const deferredChunkSeeds: DeferredChunkSeed[] = [];
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
    if (deferNaming) {
      deferredChunkSeeds.push({
        chunkId: chunk.chunkId,
        info: renderableInfo,
        preferredName: preferredSeed?.preferredName ?? null,
      });
      continue;
    }
    const contentHash = hashText(sourceText);
    const renderedFileName = ensureUniqueJsFileName(
      preferredSeed?.preferredName ??
        renderPatternFileName(
          input.outputOptions.chunkFileNames,
          renderableInfo,
          contentHash,
          input.outputOptions.format,
        ),
      contentHash,
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
    deferredChunkSeeds,
    emittedOutputFiles: renamedOutputFiles,
    manifest,
    manifestFilePath: input.manifestFilePath,
  } satisfies RenamedNonBaseOutputs;
}

export async function finalizeBaseJsOutputName(input: {
  baseChunkFilePath: string;
  baseSeed: BaseOutputSeed;
  chunkOutputType: ViteChunkOutputType;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifestFilePath: string;
  outputOptions: NormalizedOutputOptions;
  outDir: string;
  publicPath: string;
}) {
  if (input.chunkOutputType === "esm") {
    return finalizeEsmChunkNames(input);
  }
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
  const contentHash = hashText(sourceText);
  const finalBaseFileName = ensureUniqueJsFileName(
    input.baseSeed.preferredName ??
      renderPatternFileName(
        input.outputOptions.entryFileNames,
        input.baseSeed.info,
        contentHash,
        input.outputOptions.format,
      ),
    contentHash,
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

/**
 * ES module output embeds chunk file names in two directions at once: every
 * lazy chunk carries `import ... from "./<base>.js"`, and the base chunk
 * carries the lazy chunk names in the runtime manifest. Hashing either side
 * changes the other, so content hashes cannot be taken over the shipped bytes.
 *
 * This is Rollup's placeholder scheme: every chunk reference is replaced with
 * a stable token, each chunk is hashed over that tokenised text, and a chunk's
 * final hash additionally folds in the tokenised hashes of every chunk it can
 * reach. Cycles are fine because the folded-in hashes are themselves
 * cycle-free, and a change anywhere in a chunk's reference closure still
 * changes its name.
 */
async function finalizeEsmChunkNames(input: {
  baseSeed: BaseOutputSeed;
  deferredChunkSeeds: DeferredChunkSeed[];
  emittedOutputFiles: string[];
  manifestFilePath: string;
  outDir: string;
  outputOptions: NormalizedOutputOptions;
  publicPath: string;
}) {
  const manifest = parseGccRuntimeManifest(
    await fs.readFile(input.manifestFilePath, "utf8"),
    input.manifestFilePath,
  );
  const baseChunkId = manifest.baseChunk;
  const chunks = Object.entries(manifest.chunks)
    .map(([chunkId, chunk]) => {
      const oldFileName = stripPublicPathPrefix(chunk.url, manifest.publicPath);
      return {
        // Closure names its outputs after the chunk id and the base chunk is
        // renamed on the way out of the compiler, so sibling chunks can still
        // import it under `./<chunkId>.js`. Both spellings resolve here.
        aliases: [...new Set([oldFileName, `${chunkId}.js`])],
        chunkId,
        chunk,
        oldFileName,
      };
    })
    .sort((left, right) => left.chunkId.localeCompare(right.chunkId));
  const baseChunk = chunks.find((chunk) => chunk.chunkId === baseChunkId);
  if (!baseChunk) {
    throw new Error("gccTsBundler() could not resolve the base runtime chunk.");
  }

  const tokenByChunkId = new Map(
    chunks.map((chunk, index) => [chunk.chunkId, chunkNameToken(index)]),
  );
  const tokenisedByChunkId = new Map<string, string>();
  const referencesByChunkId = new Map<string, Set<string>>();
  for (const chunk of chunks) {
    const sourceText = await fs.readFile(
      path.join(input.outDir, chunk.oldFileName),
      "utf8",
    );
    const references = new Set<string>();
    let tokenised = sourceText;
    for (const other of chunks) {
      const token = tokenByChunkId.get(other.chunkId) ?? "";
      for (const alias of other.aliases) {
        const replaced = replaceChunkSpecifier(tokenised, alias, token);
        if (replaced !== tokenised) {
          references.add(other.chunkId);
          tokenised = replaced;
        }
      }
    }
    tokenisedByChunkId.set(chunk.chunkId, tokenised);
    referencesByChunkId.set(chunk.chunkId, references);
  }

  const finalHashByChunkId = new Map(
    chunks.map((chunk) => [
      chunk.chunkId,
      hashText(
        [
          tokenisedByChunkId.get(chunk.chunkId) ?? "",
          ...[
            ...collectReferenceClosure(chunk.chunkId, referencesByChunkId),
          ].map((referencedId) =>
            hashText(tokenisedByChunkId.get(referencedId) ?? ""),
          ),
        ].join("\u0000"),
      ),
    ]),
  );

  const seedByChunkId = new Map(
    input.deferredChunkSeeds.map((seed) => [seed.chunkId, seed]),
  );
  const reservedNames = new Set<string>();
  const renameMap = new Map<string, string>();
  // The base chunk is named first so that its entryFileNames pattern wins any
  // collision against a lazy chunk that renders to the same name.
  for (const chunk of [
    baseChunk,
    ...chunks.filter((candidate) => candidate.chunkId !== baseChunkId),
  ]) {
    const isBase = chunk.chunkId === baseChunkId;
    const seed = seedByChunkId.get(chunk.chunkId);
    const chunkHash = finalHashByChunkId.get(chunk.chunkId) ?? "";
    const info =
      (isBase ? input.baseSeed.info : seed?.info) ??
      createFallbackChunkInfo({
        chunkId: chunk.chunkId,
        dynamicRootModuleIds: new Set<string>(),
        moduleIds: new Set<string>(),
      });
    const preferredName = isBase
      ? input.baseSeed.preferredName
      : (seed?.preferredName ?? null);
    const renderedFileName = ensureUniqueJsFileName(
      preferredName ??
        renderPatternFileName(
          isBase
            ? input.outputOptions.entryFileNames
            : input.outputOptions.chunkFileNames,
          info,
          chunkHash,
          input.outputOptions.format,
        ),
      chunkHash,
      reservedNames,
    );
    reservedNames.add(renderedFileName);
    renameMap.set(chunk.oldFileName, renderedFileName);
  }

  for (const chunk of chunks) {
    let contents = tokenisedByChunkId.get(chunk.chunkId) ?? "";
    const importerDir = path.posix.dirname(
      renameMap.get(chunk.oldFileName) ?? chunk.oldFileName,
    );
    for (const other of chunks) {
      // Specifiers are resolved against the importing module, so a chunk that
      // moved into `assets/` must reference its sibling as `./sibling.js`, not
      // `./assets/sibling.js`. The `./` prefix Closure emitted stays in the
      // text, so only the path after it is substituted.
      const target = renameMap.get(other.oldFileName) ?? other.oldFileName;
      contents = contents
        .split(tokenByChunkId.get(other.chunkId) ?? "")
        .join(path.posix.relative(importerDir, target) || target);
    }
    await fs.writeFile(
      path.join(input.outDir, chunk.oldFileName),
      contents,
      "utf8",
    );
    const renamedFileName = renameMap.get(chunk.oldFileName);
    if (renamedFileName) {
      chunk.chunk.url = joinPublicPath(input.publicPath, renamedFileName);
    }
  }
  await writeManifest(input.manifestFilePath, manifest);

  const emittedOutputFiles = mapOutputFiles(
    input.emittedOutputFiles,
    input.outDir,
    renameMap,
  );
  await applyFileRenames(input.outDir, renameMap);

  return {
    baseScriptFileName:
      renameMap.get(baseChunk.oldFileName) ?? baseChunk.oldFileName,
    emittedOutputFiles,
  };
}

/**
 * A token that cannot occur in compiled JavaScript, so tokenised text never
 * collides with real source.
 */
function chunkNameToken(index: number) {
  return `\u0000gcc-chunk-${index}\u0000`;
}

/**
 * Replaces `"./name.js"` / `"name.js"` (either quote style) with `"./token"` /
 * `"token"`. Matching only complete quoted strings keeps the substitution away
 * from arbitrary application text that happens to contain a chunk file name.
 */
function replaceChunkSpecifier(
  sourceText: string,
  fileName: string,
  replacement: string,
) {
  const pattern = new RegExp(`(["'])(\\./)?${escapeRegExp(fileName)}\\1`, "gu");
  return sourceText.replace(
    pattern,
    (_match: string, quote: string, prefix: string | undefined) =>
      `${quote}${prefix ?? ""}${replacement}${quote}`,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function collectReferenceClosure(
  chunkId: string,
  referencesByChunkId: Map<string, Set<string>>,
) {
  const closure = new Set<string>();
  const queue = [...(referencesByChunkId.get(chunkId) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined || next === chunkId || closure.has(next)) {
      continue;
    }
    closure.add(next);
    queue.push(...(referencesByChunkId.get(next) ?? []));
  }
  return [...closure].sort((left, right) => left.localeCompare(right));
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

  const entryFacadeModuleId = input.entryModuleIds[0];
  return {
    info: {
      ...(entryFacadeModuleId === undefined
        ? {}
        : { facadeModuleId: entryFacadeModuleId }),
      exports: [],
      isDynamicEntry: false,
      isEntry: true,
      moduleIds: [...input.entryModuleIds].sort((left, right) =>
        left.localeCompare(right),
      ),
      name: sanitizeName(input.baseChunkName),
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
    ...(dynamicRoot === undefined ? {} : { facadeModuleId: dynamicRoot }),
    exports: [],
    isDynamicEntry: Boolean(dynamicRoot),
    isEntry: false,
    moduleIds: [...input.moduleIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    name,
  };
}

function toRenderableChunkInfo(chunk: OutputChunk): RenderableChunkInfo {
  return {
    ...(chunk.facadeModuleId === undefined || chunk.facadeModuleId === null
      ? {}
      : { facadeModuleId: chunk.facadeModuleId }),
    exports: [...chunk.exports],
    isDynamicEntry: chunk.isDynamicEntry,
    isEntry: chunk.isEntry,
    moduleIds: Object.keys(chunk.modules).sort((left, right) =>
      left.localeCompare(right),
    ),
    name: sanitizeName(chunk.name),
  };
}

function renderPatternFileName(
  pattern:
    | NormalizedOutputOptions["chunkFileNames"]
    | NormalizedOutputOptions["entryFileNames"],
  chunkInfo: RenderableChunkInfo,
  contentHash: string,
  format: NormalizedOutputOptions["format"],
) {
  const rendered = typeof pattern === "function" ? pattern(chunkInfo) : pattern;
  return normalizeOutputFileName(
    rendered.replace(/\[(name|format|ext|extname|hash(?::\d+)?)\]/gu, (token) =>
      renderTokenReplacement(token, chunkInfo, contentHash, format),
    ),
  );
}

function renderTokenReplacement(
  token: string,
  chunkInfo: RenderableChunkInfo,
  contentHash: string,
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
    return contentHash.slice(0, hashLength);
  }
  return token;
}

function hashText(sourceText: string) {
  return createHash("sha256").update(sourceText).digest("base64url");
}

function ensureUniqueJsFileName(
  fileName: string,
  contentHash: string,
  reservedNames: Set<string>,
) {
  const normalized = normalizeOutputFileName(fileName);
  if (!reservedNames.has(normalized)) {
    return normalized;
  }

  const { dir, ext, name } = path.posix.parse(normalized);
  const suffix = contentHash.slice(0, 8);
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
