import fs from "fs";
import path from "path";

import { publishFilesToDirectory } from "../internal/files";
import { publishedOutputsMatch } from "../internal/file-state";

export async function publishOutputs(outputFiles: string[], outDir: string) {
  if (await publishedOutputsMatch(outputFiles, outDir)) {
    return;
  }

  await publishFilesToDirectory(outputFiles, outDir, "copy");
}

export function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function toPublishedOutputPaths(
  publishedOutputs: Array<{ name: string }>,
  outDir: string,
) {
  return publishedOutputs.map(({ name }) => path.join(outDir, name));
}

export function createBuildDiagnostic(error: unknown) {
  return {
    category: 1,
    code: 0,
    messageText:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Build failed.",
  };
}

export async function removeProjectCacheDir(projectCacheDir: string) {
  await fs.promises.rm(projectCacheDir, { force: true, recursive: true });
}
