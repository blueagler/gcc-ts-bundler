import fs from "fs/promises";
import path from "path";

import { ensureParentDirectory } from "../../../shared/files";
import { runWithConcurrency } from "../../../shared/concurrency";
import type { PreservedModule } from "../../types";
import { emitPreservedModule } from "../../../native/load";

export async function emitPreservedModuleFiles(input: {
  modules: PreservedModule[];
  outDir: string;
}) {
  const resolvedOutDir = path.resolve(input.outDir);
  return runWithConcurrency(input.modules, 16, async (module) => {
    const outputPath = path.resolve(input.outDir, module.outputRelativePath);
    if (!outputPath.startsWith(`${resolvedOutDir}${path.sep}`)) {
      throw new Error(
        `Preserved module output escapes the build directory: ${module.outputRelativePath}`,
      );
    }
    await ensureParentDirectory(outputPath);
    const source = await fs.readFile(module.filePath, "utf8");
    await fs.writeFile(
      outputPath,
      emitPreservedModule(module.filePath, source),
      "utf8",
    );
    return outputPath;
  });
}
