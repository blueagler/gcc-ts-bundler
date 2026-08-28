import fs from "fs/promises";
import path from "path";

import { logInternalDetail } from "../../../shared/timing";
import { replaceRuntimeInitManifest } from "../runtime-manifest/init";
import type { ChunkPlanChunk } from "../../types";
import { isScaffoldingOnly } from "./is-scaffolding-only";
import { findRuntimeBaseChunk, pruneChunkMapFile } from "./parse";
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
