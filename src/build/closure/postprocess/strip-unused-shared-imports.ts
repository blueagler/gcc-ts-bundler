import fs from "fs/promises";
import { runWithConcurrency } from "../../../shared/concurrency";

const UNUSED_SHARED_IMPORT =
  /\bimport\s*(["'])(?:[^"']*\/)?shared(?:\d+)?\.js\1;?/gu;

export async function stripUnusedSharedChunkImports(
  outputFiles: readonly string[],
) {
  await runWithConcurrency(outputFiles, 16, async (outputFile) => {
    if (!/\.[cm]?js$/u.test(outputFile)) {
      return;
    }
    const source = await fs.readFile(outputFile, "utf8");
    const stripped = source.replace(UNUSED_SHARED_IMPORT, "");
    if (stripped !== source) {
      await fs.writeFile(outputFile, stripped);
    }
  });
}
