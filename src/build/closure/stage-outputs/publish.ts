import fs from "fs/promises";
import path from "path";

import { ensureDirectory, ensureParentDirectory } from "../../../shared/files";
import type { BuildEntry, ChunkPlanChunk } from "../../types";
import { prepareClosureJobs } from "../../../native/load";

export function remapOffModeEntryOutputs(input: {
  chunkPlan: ChunkPlanChunk[];
  entryFiles: BuildEntry[];
  outDir: string;
  prepared: ReturnType<typeof prepareClosureJobs>;
}) {
  if (input.chunkPlan.length !== input.prepared.postprocessActions.length) {
    throw new Error(
      "Off-mode output mapping could not align Closure chunks with output actions.",
    );
  }
  const declaredOutputs = new Set(
    input.entryFiles.map((entry) => entry.outputName),
  );
  for (const [index, chunk] of input.chunkPlan.entries()) {
    if (!chunk.outputName) continue;
    const action = input.prepared.postprocessActions[index];
    if (!declaredOutputs.has(chunk.outputName) || !action) {
      throw new Error(
        `Off-mode output mapping could not resolve entry owner for chunk ${chunk.name}.`,
      );
    }
    action.outputPath = path.join(input.outDir, chunk.outputName);
  }
  input.prepared.publishedOutputs = input.prepared.postprocessActions.map(
    (action) => action.outputPath,
  );
}

export async function prependEntryShebangs(input: {
  chunkPlan: ChunkPlanChunk[];
  entryShebangs: Array<{ shebang: string; sourcePath: string }>;
  postprocessActions: ReturnType<
    typeof prepareClosureJobs
  >["postprocessActions"];
}) {
  for (const entry of input.entryShebangs) {
    const normalizedSource = normalizeFilePath(entry.sourcePath);
    const chunkIndex = input.chunkPlan.findIndex((chunk) =>
      [...chunk.files, ...(chunk.entryFiles ?? [])].some((filePath) =>
        normalizedSource.endsWith(`/${normalizeFilePath(filePath)}`),
      ),
    );
    const outputPath = input.postprocessActions[chunkIndex]?.outputPath;
    if (!outputPath) {
      throw new Error(
        `Could not assign shebang entry ${entry.sourcePath} to output.`,
      );
    }
    const source = await fs.readFile(outputPath, "utf8");
    if (!source.startsWith(`${entry.shebang}\n`)) {
      await fs.writeFile(outputPath, `${entry.shebang}\n${source}`, "utf8");
    }
  }
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//u, "");
}

export async function prepareClosureStageDirectories({
  finalCacheDir,
  outDir,
}: {
  finalCacheDir: string;
  outDir: string;
}) {
  await fs.rm(finalCacheDir, { force: true, recursive: true });
  await ensureDirectory(finalCacheDir);

  const rawDir = path.join(finalCacheDir, "raw");
  const cacheOutputDir = path.join(finalCacheDir, "outputs");
  await ensureDirectory(rawDir);
  await ensureDirectory(cacheOutputDir);
  await fs.rm(outDir, { force: true, recursive: true });
  await ensureDirectory(outDir);

  return { cacheOutputDir, rawDir };
}

export async function writeGeneratedAssets(
  assets: ReturnType<typeof prepareClosureJobs>["generatedAssets"],
) {
  await Promise.all(
    assets.map(async (asset) => {
      await ensureParentDirectory(asset.path);
      await fs.writeFile(asset.path, asset.text, "utf-8");
    }),
  );
}

export async function publishPreparedClosureOutputs(
  outputFiles: string[],
  outDir: string,
  cacheOutputDir: string,
) {
  await Promise.all(
    outputFiles.map(async (outputFile) => {
      const relativePath = path.relative(outDir, outputFile);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        throw new Error(`Published output escaped outDir: ${outputFile}`);
      }
      const cacheFile = path.join(cacheOutputDir, relativePath);
      await ensureParentDirectory(cacheFile);
      await fs.copyFile(outputFile, cacheFile);
    }),
  );
}
