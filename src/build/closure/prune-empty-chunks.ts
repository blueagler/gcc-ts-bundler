import fs from "fs/promises";
import path from "path";

import { logInternalDetail } from "../../shared/timing";
import {
  extractRuntimeInitManifest,
  replaceRuntimeInitManifest,
} from "../../vite/runtime-manifest";
import type { ChunkPlanChunk } from "../types";

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

  const sources = new Map<string, string>();
  for (const filePath of jsOutputs) {
    sources.set(filePath, await fs.readFile(filePath, "utf8"));
  }

  const base = findRuntimeBaseChunk(sources);
  if (!base) {
    return [...input.outputFiles];
  }
  const { baseFilePath, manifest } = base;
  const [baseIndex, chunkRows, moduleChunks] = manifest;

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

  const prunedIndices = new Set<number>();
  for (const [index, filePath] of fileByChunkIndex) {
    const plan = input.chunkPlan[index];
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
  if (prunedIndices.size === 0) {
    return [...input.outputFiles];
  }

  const survivorOf = (index: number): number => {
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
  };

  const prunedFileNames = new Set<string>();
  for (const index of prunedIndices) {
    const filePath = fileByChunkIndex.get(index);
    if (filePath) {
      prunedFileNames.add(path.basename(filePath));
    }
    chunkRows[index] = 0;
  }
  for (const row of chunkRows) {
    if (typeof row === "number") {
      continue;
    }
    row[0] = row[0].filter((dependency) => !prunedIndices.has(dependency));
  }
  for (const [moduleIndex, chunkIndex] of moduleChunks.entries()) {
    if (prunedIndices.has(chunkIndex)) {
      moduleChunks[moduleIndex] = survivorOf(chunkIndex);
    }
  }

  sources.set(
    baseFilePath,
    replaceRuntimeInitManifest(sources.get(baseFilePath) ?? "", manifest),
  );
  for (const [filePath, sourceText] of sources) {
    const stripped = stripImportsOf(sourceText, prunedFileNames);
    if (stripped !== sourceText) {
      sources.set(filePath, stripped);
    }
  }

  const survivingOutputs: string[] = [];
  for (const filePath of input.outputFiles) {
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

  if (input.manifestFilePath) {
    await pruneChunkMapFile(input.manifestFilePath, prunedFileNames);
  }
  logInternalDetail(
    "closure:pruned-empty-chunks",
    [...prunedFileNames].sort().join(",") || "none",
  );
  return survivingOutputs;
}

/**
 * `[baseChunkIndex, chunkRows, moduleToChunk, publicPath]`. A chunk row is
 * `[dependencyIndices, url, cssHrefs]`, or `0` once pruned.
 */
type RuntimeChunkRow = [number[], string, string[]];
type RuntimeInitManifest = [number, (RuntimeChunkRow | 0)[], number[], string];

function findRuntimeBaseChunk(sources: Map<string, string>) {
  for (const [filePath, sourceText] of sources) {
    let candidate: unknown;
    try {
      candidate = extractRuntimeInitManifest(sourceText).manifest;
    } catch {
      continue;
    }
    const manifest = toRuntimeInitManifest(candidate);
    if (manifest) {
      return { baseFilePath: filePath, manifest };
    }
  }
  return null;
}

function toRuntimeInitManifest(value: unknown): RuntimeInitManifest | null {
  if (!Array.isArray(value) || value.length < 4) {
    return null;
  }
  const entries: unknown[] = value;
  const baseIndex: unknown = entries[0];
  const rows: unknown = entries[1];
  const moduleChunks: unknown = entries[2];
  const publicPath: unknown = entries[3];
  if (
    typeof baseIndex !== "number" ||
    typeof publicPath !== "string" ||
    !isUnknownArray(rows) ||
    !isUnknownArray(moduleChunks) ||
    !moduleChunks.every((entry) => typeof entry === "number")
  ) {
    return null;
  }
  const moduleChunkIndices: number[] = moduleChunks.filter(
    (entry): entry is number => typeof entry === "number",
  );
  const chunkRows: (RuntimeChunkRow | 0)[] = [];
  for (const row of rows) {
    if (row === 0) {
      chunkRows.push(0);
      continue;
    }
    if (!isUnknownArray(row) || row.length < 3) {
      return null;
    }
    const dependencies: unknown = row[0];
    const url: unknown = row[1];
    const css: unknown = row[2];
    if (
      !isUnknownArray(dependencies) ||
      !dependencies.every((entry) => typeof entry === "number") ||
      typeof url !== "string" ||
      !isUnknownArray(css) ||
      !css.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    chunkRows.push([
      dependencies.filter(
        (entry): entry is number => typeof entry === "number",
      ),
      url,
      css.filter((entry): entry is string => typeof entry === "string"),
    ]);
  }
  return [baseIndex, chunkRows, moduleChunkIndices, publicPath];
}

/** Whitespace, stray semicolons, and the scaffolding every chunk carries. */
const SCAFFOLDING_PATTERNS = [
  /^[\s;]+/u,
  // Side-effect or named ES import of a sibling chunk.
  /^import\s*(?:[\w$*{}\s,]*\s+from\s*)?(["'])(?:\\.|(?!\1)[^\\])*\1\s*;?/u,
  // The per-chunk runtime alias line, in either output shape.
  /^var\s+[A-Za-z_$][\w$]*\s*=\s*globalThis(?:\.[\w$]+|\[(["'])(?:\\.|(?!\1)[^\\])*\1\])[^;]*;/u,
  // The chunk's own `l(<index>)` completion call, after property renaming.
  /^(?:globalThis|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\(\s*\d+\s*\)\s*;?/u,
];

const IIFE_HEAD = /^!?\(?function\s*\([^)]*\)\s*\{/u;
const IIFE_TAIL = /\}\s*\)?\s*(?:\(\s*\)|\.call\s*\([^)]*\))\s*;?\s*$/u;

/**
 * True when the chunk body is only scaffolding. Fail-closed: anything the
 * whitelist does not recognise keeps the chunk.
 */
export function isScaffoldingOnly(sourceText: string) {
  let rest = sourceText;
  for (;;) {
    const before = rest;
    rest = rest.trim();
    const head = IIFE_HEAD.exec(rest);
    const tail = IIFE_TAIL.exec(rest);
    if (head && tail && tail.index >= head[0].length) {
      rest = rest.slice(head[0].length, tail.index);
    } else {
      for (const pattern of SCAFFOLDING_PATTERNS) {
        const match = pattern.exec(rest);
        if (match && match[0].length > 0) {
          rest = rest.slice(match[0].length);
          break;
        }
      }
    }
    if (rest === before) {
      return rest.length === 0;
    }
  }
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

async function pruneChunkMapFile(
  manifestFilePath: string,
  prunedFileNames: Set<string>,
) {
  let text: string;
  try {
    text = await fs.readFile(manifestFilePath, "utf8");
  } catch {
    return;
  }
  const manifest: unknown = JSON.parse(text);
  const typed = toChunkMap(manifest);
  if (!typed) {
    return;
  }
  const prunedIds = Object.entries(typed.chunks)
    .filter(([, chunk]) => prunedFileNames.has(path.posix.basename(chunk.url)))
    .map(([chunkId]) => chunkId);
  if (prunedIds.length === 0) {
    return;
  }
  const prunedIdSet = new Set(prunedIds);
  for (const chunkId of prunedIds) {
    delete typed.chunks[chunkId];
  }
  for (const chunk of Object.values(typed.chunks)) {
    chunk.deps = chunk.deps.filter(
      (dependency) => !prunedIdSet.has(dependency),
    );
  }
  for (const [moduleId, chunkId] of Object.entries(typed.modules)) {
    if (prunedIdSet.has(chunkId)) {
      typed.modules[moduleId] = typed.baseChunk;
    }
  }
  await fs.writeFile(
    manifestFilePath,
    `${JSON.stringify(typed, null, 2)}\n`,
    "utf8",
  );
}

interface ChunkMapFile {
  baseChunk: string;
  chunks: Record<string, { deps: string[]; url: string }>;
  modules: Record<string, string>;
}

function toChunkMap(value: unknown): ChunkMapFile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...value };
  const baseChunk: unknown = record["baseChunk"];
  const chunks: unknown = record["chunks"];
  const modules: unknown = record["modules"];
  if (
    typeof baseChunk !== "string" ||
    !isUnknownRecord(chunks) ||
    !isUnknownRecord(modules)
  ) {
    return null;
  }
  const parsedChunks: ChunkMapFile["chunks"] = {};
  for (const [chunkId, chunk] of Object.entries(chunks)) {
    if (!isUnknownRecord(chunk)) {
      return null;
    }
    const chunkRecord: Record<string, unknown> = chunk;
    const deps: unknown = chunkRecord["deps"];
    const url: unknown = chunkRecord["url"];
    if (
      !isUnknownArray(deps) ||
      !deps.every((entry) => typeof entry === "string") ||
      typeof url !== "string"
    ) {
      return null;
    }
    // Spread the original: the chunk-map row also carries `css` and `modules`,
    // and the plugin re-validates the file after this rewrite.
    parsedChunks[chunkId] = {
      ...chunkRecord,
      deps: deps.filter((entry): entry is string => typeof entry === "string"),
      url,
    };
  }
  const parsedModules: Record<string, string> = {};
  for (const [moduleId, chunkId] of Object.entries(modules)) {
    if (typeof chunkId !== "string") {
      return null;
    }
    parsedModules[moduleId] = chunkId;
  }
  return { ...record, baseChunk, chunks: parsedChunks, modules: parsedModules };
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
