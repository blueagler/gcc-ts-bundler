import fs from "fs/promises";

import { minifyJavaScript } from "../../native/load";

const JAVASCRIPT_OUTPUT = /\.[cm]?js$/u;

/**
 * Applies the final OXC pass only after all output-shape rewrites are complete.
 * Preserved modules are excluded because their contract is byte-for-byte source
 * preservation apart from their dedicated native ESM emission transform.
 */
export async function finalizeJavaScriptOutputs(input: {
  excludedOutputFiles?: readonly string[];
  outputFiles: readonly string[];
}) {
  const excluded = new Set(input.excludedOutputFiles);
  await Promise.all(
    input.outputFiles
      .filter(
        (filePath) =>
          JAVASCRIPT_OUTPUT.test(filePath) && !excluded.has(filePath),
      )
      .map(async (filePath) => {
        const source = await fs.readFile(filePath, "utf8");
        await fs.writeFile(
          filePath,
          minifyJavaScript(filePath, source),
          "utf8",
        );
      }),
  );
}
