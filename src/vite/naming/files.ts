import fs from "node:fs/promises";
import path from "node:path";

import type { GccRuntimeManifest } from "../internal-types";

export function mapOutputFiles(
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

export async function applyFileRenames(
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

export async function writeManifest(
  filePath: string,
  manifest: GccRuntimeManifest,
) {
  await fs.writeFile(
    filePath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
