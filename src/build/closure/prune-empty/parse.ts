import fs from "fs/promises";
import path from "path";

import { extractRuntimeInitManifest } from "../runtime-manifest/init";

/**
 * `[baseChunkIndex, chunkRows, moduleToChunk, publicPath]`. A chunk row is
 * `[dependencyIndices, url, cssHrefs]`, or `0` once pruned.
 */
type RuntimeChunkRow = [number[], string, string[]];
type RuntimeInitManifest = [number, (RuntimeChunkRow | 0)[], number[], string];

export function findRuntimeBaseChunk(sources: Map<string, string>) {
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

export async function pruneChunkMapFile(
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
