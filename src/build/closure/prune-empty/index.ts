import fs from "fs/promises";
import path from "path";

import { logInternalDetail } from "../../../shared/timing";
import { replaceRuntimeInitManifest } from "../runtime-manifest/init";
import type { ChunkPlanChunk } from "../../types";
import { isScaffoldingOnly } from "./is-scaffolding-only";
import { findRuntimeBaseChunk, pruneChunkMapFile } from "./parse";

/** `[dependencyIndices, url, cssHrefs]`, or `0` once pruned. */
type RuntimeChunkRow = [number[], string, string[]];
type ChunkRows = (RuntimeChunkRow | 0)[];

/**
 * Post-Closure pruning of chunks that survive the plan but carry no code.
 *
 * The planner creates a shared chunk whenever two lazy roots reach the same
 * module, and a vendor chunk on request. Closure's cross-chunk code motion can
 * then hoist every module out of one of those chunks into the base, leaving an
 * output file that is nothing but scaffolding: the generated `import` edges
 * and the loader's own "this chunk finished" call. The Svelte + Vite example
 * shipped exactly that - a 49-byte `shared-*.js` whose only reason to exist
 * was a manifest row, statically imported by all five lazy panels, so every
 * panel load paid an extra serialized request for nothing.
 *
 * Only chunks that are not dynamic-import roots are eligible: a lazy chunk is
 * the thing `import()` resolves to, and an empty one still has to resolve.
 *
 * The row is emptied rather than spliced out. Chunk ids are dense array
 * indices baked into every surviving chunk's completion call and into the
 * module-to-chunk table, so renumbering would mean rewriting minified call
 * sites; a falsy row costs one byte and keeps `if(!b)throw` as the loud
 * failure mode if anything ever looks the pruned id up again.
 */
export async function pruneEmptyChunks(input: {
  chunkPlan: readonly ChunkPlanChunk[];
  manifestFilePath: string | null;
  outputFiles: readonly string[];
}): Promise<string[]> {
  const jsOutputs = input.outputFiles.filter((filePath) =>
    filePath.endsWith(".js"),
  );
  if (jsOutputs.length < 2) {
    return [...input.outputFiles];
  }

  const sources = await readJsSources(jsOutputs);
  const base = findRuntimeBaseChunk(sources);
  if (!base) {
    return [...input.outputFiles];
  }
  const { baseFilePath, manifest } = base;
  const [baseIndex, chunkRows, moduleChunks] = manifest;

  const fileByChunkIndex = indexFilesByChunk(chunkRows, baseIndex, jsOutputs);
  const prunedIndices = collectPrunedIndices(
    input.chunkPlan,
    fileByChunkIndex,
    sources,
  );
  if (prunedIndices.size === 0) {
    return [...input.outputFiles];
  }

  const prunedFileNames = emptyPrunedRows(
    chunkRows,
    fileByChunkIndex,
    prunedIndices,
  );
  rewireChunkGraph(chunkRows, moduleChunks, prunedIndices, baseIndex);

  sources.set(
    baseFilePath,
    replaceRuntimeInitManifest(sources.get(baseFilePath) ?? "", manifest),
  );
  stripPrunedImportsFromSources(sources, prunedFileNames);

  const survivingOutputs = await writeSurvivingOutputs(
    input.outputFiles,
    jsOutputs,
    prunedFileNames,
    sources,
  );

  if (input.manifestFilePath) {
    await pruneChunkMapFile(input.manifestFilePath, prunedFileNames);
  }
  logInternalDetail(
    "closure:pruned-empty-chunks",
    [...prunedFileNames].sort().join(",") || "none",
  );
  return survivingOutputs;
}

async function readJsSources(
  jsOutputs: readonly string[],
): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for (const filePath of jsOutputs) {
    sources.set(filePath, await fs.readFile(filePath, "utf8"));
  }
  return sources;
}

function indexFilesByChunk(
  chunkRows: ChunkRows,
  baseIndex: number,
  jsOutputs: readonly string[],
): Map<number, string> {
  const fileByChunkIndex = new Map<number, string>();
  for (const [index, row] of chunkRows.entries()) {
    if (index === baseIndex || typeof row === "number") {
      continue;
    }
    const url = row[1];
    if (!url) {
      continue;
    }
    const fileName = path.posix.basename(url);
    const filePath = jsOutputs.find(
      (candidate) => path.basename(candidate) === fileName,
    );
    if (filePath) {
      fileByChunkIndex.set(index, filePath);
    }
  }
  return fileByChunkIndex;
}

function collectPrunedIndices(
  chunkPlan: readonly ChunkPlanChunk[],
  fileByChunkIndex: ReadonlyMap<number, string>,
  sources: ReadonlyMap<string, string>,
): Set<number> {
  const prunedIndices = new Set<number>();
  for (const [index, filePath] of fileByChunkIndex) {
    const plan = chunkPlan[index];
    // Never a dynamic root: `import()` has to resolve to that chunk even when
    // Closure emptied it.
    if (
      !plan ||
      plan.kind === "lazy" ||
      (plan.lazyModuleIds ?? []).length > 0
    ) {
      continue;
    }
    if (isScaffoldingOnly(sources.get(filePath) ?? "")) {
      prunedIndices.add(index);
    }
  }
  return prunedIndices;
}

function emptyPrunedRows(
  chunkRows: ChunkRows,
  fileByChunkIndex: ReadonlyMap<number, string>,
  prunedIndices: ReadonlySet<number>,
): Set<string> {
  const prunedFileNames = new Set<string>();
  for (const index of prunedIndices) {
    const filePath = fileByChunkIndex.get(index);
    if (filePath) {
      prunedFileNames.add(path.basename(filePath));
    }
    chunkRows[index] = 0;
  }
  return prunedFileNames;
}

function rewireChunkGraph(
  chunkRows: ChunkRows,
  moduleChunks: number[],
  prunedIndices: ReadonlySet<number>,
  baseIndex: number,
): void {
  for (const row of chunkRows) {
    if (typeof row === "number") {
      continue;
    }
    row[0] = row[0].filter((dependency) => !prunedIndices.has(dependency));
  }
  for (const [moduleIndex, chunkIndex] of moduleChunks.entries()) {
    if (prunedIndices.has(chunkIndex)) {
      moduleChunks[moduleIndex] = survivorOf(
        chunkIndex,
        chunkRows,
        prunedIndices,
        baseIndex,
      );
    }
  }
}

/**
 * Walk pruned-chunk dependency edges until a surviving chunk (or the base).
 * Called after pruned rows are emptied to `0`, so a pruned current always
 * falls through to `baseIndex` unless a cycle is detected first.
 */
function survivorOf(
  index: number,
  chunkRows: ChunkRows,
  prunedIndices: ReadonlySet<number>,
  baseIndex: number,
): number {
  const seen = new Set<number>();
  let current = index;
  while (prunedIndices.has(current) && !seen.has(current)) {
    seen.add(current);
    const row = chunkRows[current];
    const deps = row === undefined || typeof row === "number" ? [] : row[0];
    const next = deps.find((dependency) => !prunedIndices.has(dependency));
    current = next ?? baseIndex;
  }
  return prunedIndices.has(current) ? baseIndex : current;
}

function stripPrunedImportsFromSources(
  sources: Map<string, string>,
  prunedFileNames: Set<string>,
): void {
  for (const [filePath, sourceText] of sources) {
    const stripped = stripImportsOf(sourceText, prunedFileNames);
    if (stripped !== sourceText) {
      sources.set(filePath, stripped);
    }
  }
}

async function writeSurvivingOutputs(
  outputFiles: readonly string[],
  jsOutputs: readonly string[],
  prunedFileNames: ReadonlySet<string>,
  sources: ReadonlyMap<string, string>,
): Promise<string[]> {
  const survivingOutputs: string[] = [];
  for (const filePath of outputFiles) {
    if (
      jsOutputs.includes(filePath) &&
      prunedFileNames.has(path.basename(filePath))
    ) {
      await fs.rm(filePath, { force: true });
      continue;
    }
    survivingOutputs.push(filePath);
    const sourceText = sources.get(filePath);
    if (sourceText !== undefined) {
      await fs.writeFile(filePath, sourceText, "utf8");
    }
  }
  return survivingOutputs;
}

function stripImportsOf(sourceText: string, prunedFileNames: Set<string>) {
  let next = sourceText;
  for (const fileName of prunedFileNames) {
    const pattern = new RegExp(
      `import\\s*(["'])[^"']*${escapeRegex(fileName)}\\1\\s*;?`,
      "gu",
    );
    next = next.replace(pattern, "");
  }
  return next;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
