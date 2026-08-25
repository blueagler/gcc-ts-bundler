import fs from "fs/promises";

const UNUSED_SHARED_IMPORT =
  /\bimport\s*(["'])(?:[^"']*\/)?shared(?:\d+)?\.js\1;?/gu;

export async function stripUnusedSharedChunkImports(
  outputFiles: readonly string[],
) {
  await Promise.all(
    outputFiles.map(async (outputFile) => {
      if (!/\.[cm]?js$/u.test(outputFile)) {
        return;
      }
      const source = await fs.readFile(outputFile, "utf8");
      const stripped = source.replace(UNUSED_SHARED_IMPORT, "");
      if (stripped !== source) {
        await fs.writeFile(outputFile, stripped);
      }
    }),
  );
}
