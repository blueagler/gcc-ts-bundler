import fs from "fs/promises";

import { minifyJavaScript } from "../../native/load";
import { runWithConcurrency } from "../../shared/concurrency";

export const JAVASCRIPT_OUTPUT_FILE = /\.[cm]?js$/u;

/**
 * Applies the final OXC pass to one already-rewritten output text. Callers that
 * compose several output-shape rewrites in memory use this directly so the pass
 * still observes fully rewritten text without a separate read-modify-write.
 * Non-JavaScript outputs pass through untouched.
 */
export function minifyFinalJavaScriptText(filePath: string, source: string) {
  return JAVASCRIPT_OUTPUT_FILE.test(filePath)
    ? minifyJavaScript(filePath, source)
    : source;
}

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
  await runWithConcurrency(
    input.outputFiles.filter(
      (filePath) =>
        JAVASCRIPT_OUTPUT_FILE.test(filePath) && !excluded.has(filePath),
    ),
    16,
    async (filePath) => {
      const source = await fs.readFile(filePath, "utf8");
      await fs.writeFile(
        filePath,
        minifyFinalJavaScriptText(filePath, source),
        "utf8",
      );
    },
  );
}
