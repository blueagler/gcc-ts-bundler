import fs from "fs/promises";
import path from "path";

import { ensureParentDirectory } from "../../../shared/files";
import { rewriteGccExports } from "../../../native/load";
import type { prepareClosureJobs } from "../../../native/load";
import { readCachedText } from "./io";
import {
  stripBundlerRuntimeOutputFile,
  wrapBundlerRuntimeOutputFile,
} from "./runtime";

/**
 * Post-Closure rewriting is a hazard, not a feature: after ADVANCED the
 * compiler has erased the provenance that would make a rewrite decidable. Every
 * transform that needed that provenance now runs before Closure, in the native
 * emit stage, where the information still exists:
 *
 * - lowering-helper pooling is content-addressed at emit (`emit_helpers.rs`)
 *   instead of fingerprint-matched in optimizer output;
 * - decorator-metadata property keys are preserved through the extern channel
 *   instead of respelled from the property-renaming report;
 * - the bundler-runtime root alias is emitted canonically instead of being
 *   collapsed with `String.replaceAll` over minified JavaScript.
 *
 * What remains here is delivery-shape work that genuinely can only happen on
 * final output: converting Closure's export bag to ESM, wrapping script-mode
 * chunks, and repointing sibling imports at published file names. Each rule
 * carries a match count and fails the build when its input says the rule should
 * have fired and it did not.
 */

class PostprocessRuleReport {
  readonly #failures: string[] = [];

  assertAllRulesFired() {
    if (this.#failures.length === 0) {
      return;
    }
    throw new Error(
      `Closure postprocessing failed closed:\n${this.#failures.map((failure) => `  - ${failure}`).join("\n")}`,
    );
  }

  expectMatch(rule: string, outputPath: string, matched: number) {
    if (matched > 0) {
      return;
    }
    this.fail(
      `${rule} found its trigger in ${path.basename(outputPath)} but rewrote nothing`,
    );
  }

  fail(message: string) {
    this.#failures.push(message);
  }
}

function resolveBaseSpecifierRewrite({
  chunkOutputType,
  prepared,
}: {
  chunkOutputType: "esm" | "script";
  prepared: ReturnType<typeof prepareClosureJobs>;
}): { from: string; to: string } | null {
  if (chunkOutputType !== "esm" || !prepared.bundlerRuntimeBaseInputPath) {
    return null;
  }
  const internalName = path.basename(prepared.bundlerRuntimeBaseInputPath);
  const baseAction = prepared.postprocessActions.find(
    (action) => action.inputPath === prepared.bundlerRuntimeBaseInputPath,
  );
  if (!baseAction) {
    return null;
  }
  const publishedName = path.basename(baseAction.outputPath);
  if (publishedName === internalName) {
    return null;
  }
  return { from: `"./${internalName}"`, to: `"./${publishedName}"` };
}

function resolveOffModeSpecifierRewrites(
  current: ReturnType<typeof prepareClosureJobs>["postprocessActions"][number],
  actions: ReturnType<typeof prepareClosureJobs>["postprocessActions"],
) {
  return actions.flatMap((target) => {
    if (target.inputPath === current.inputPath) return [];
    const from = `./${path.basename(target.inputPath)}`;
    let to = path
      .relative(path.dirname(current.outputPath), target.outputPath)
      .replaceAll(path.sep, "/");
    if (!to.startsWith(".")) to = `./${to}`;
    return from === to ? [] : [{ from, to }];
  });
}

function countOccurrences(haystack: string, needle: string) {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export async function runClosurePostprocess({
  chunkMode,
  chunkOutputType,
  prepared,
}: {
  chunkMode: string;
  chunkOutputType: "esm" | "script";
  prepared: ReturnType<typeof prepareClosureJobs>;
}) {
  // Standalone publishing renames the base chunk from its internal Closure
  // chunk id (`cXXXXXXXX.js`) to the entry name (`main.js`), so esm sibling
  // chunks importing `./cXXXXXXXX.js` must have that specifier rewritten.
  // The Vite path renames everything again later and accepts both spellings.
  const baseSpecifierRewrite = resolveBaseSpecifierRewrite({
    chunkOutputType,
    prepared,
  });
  const report = new PostprocessRuleReport();
  const inputContents = new Map<string, Promise<string>>();

  const exportRewriteReports = await Promise.all(
    prepared.postprocessActions.map(async (action) => {
      await ensureParentDirectory(action.outputPath);
      // ES_MODULES output has no $gcc namespace and cannot be wrapped:
      // `import`/`export` are top-level-only, and Closure ignores
      // --isolation_mode for chunk output.
      const wrapBundlerRuntimeOutput =
        chunkMode !== "off" && chunkOutputType !== "esm";
      const rewritesExports = action.kind.startsWith("rewrite-gcc-exports");
      const stripsBundlerRuntime = action.kind === "strip-bundler-runtime";
      if (
        !rewritesExports &&
        !stripsBundlerRuntime &&
        !wrapBundlerRuntimeOutput &&
        !baseSpecifierRewrite
      ) {
        await fs.copyFile(action.inputPath, action.outputPath);
        return null;
      }

      let contents = await readCachedText(action.inputPath, inputContents);
      let exportRewriteReport: {
        gccReferenceCount: number;
        matchedBootstrapCount: number;
        matchedExportAssignmentCount: number;
        outputPath: string;
        rewrittenExportCount: number;
      } | null = null;
      if (rewritesExports) {
        const rewritten = rewriteGccExports(contents);
        exportRewriteReport = { ...rewritten, outputPath: action.outputPath };
        const accountedReferences =
          rewritten.matchedBootstrapCount +
          rewritten.matchedExportAssignmentCount;
        if (rewritten.gccReferenceCount !== accountedReferences) {
          report.fail(
            `gcc-exports found ${rewritten.gccReferenceCount - accountedReferences} unsupported structural GCC reference(s) in ${path.basename(action.outputPath)}`,
          );
        }
        contents = rewritten.code;
      }
      if (chunkMode === "off") {
        for (const rewrite of resolveOffModeSpecifierRewrites(
          action,
          prepared.postprocessActions,
        )) {
          for (const quote of ['"', "'"]) {
            const from = `${quote}${rewrite.from}${quote}`;
            const to = `${quote}${rewrite.to}${quote}`;
            const expected = countOccurrences(contents, from);
            contents = contents.replaceAll(from, to);
            if (expected > 0) {
              report.expectMatch(
                "off-mode-chunk-specifier",
                action.outputPath,
                countOccurrences(contents, to),
              );
            }
          }
        }
      }
      if (stripsBundlerRuntime) {
        contents = stripBundlerRuntimeOutputFile(contents);
      }
      if (wrapBundlerRuntimeOutput) {
        contents = wrapBundlerRuntimeOutputFile(contents);
      }
      if (
        baseSpecifierRewrite &&
        action.inputPath !== prepared.bundlerRuntimeBaseInputPath
      ) {
        const expected = countOccurrences(contents, baseSpecifierRewrite.from);
        contents = contents.replaceAll(
          baseSpecifierRewrite.from,
          baseSpecifierRewrite.to,
        );
        if (expected > 0) {
          report.expectMatch(
            "base-chunk-specifier",
            action.outputPath,
            countOccurrences(contents, baseSpecifierRewrite.to),
          );
        }
      }
      await fs.writeFile(action.outputPath, contents);
      return exportRewriteReport;
    }),
  );

  const structurallyTriggered = exportRewriteReports.filter(
    (item) => item && item.gccReferenceCount > 0,
  );
  const rewrittenExportCount = exportRewriteReports.reduce(
    (count, item) => count + (item?.rewrittenExportCount ?? 0),
    0,
  );
  const firstTriggered = structurallyTriggered[0];
  if (firstTriggered) {
    report.expectMatch(
      "gcc-exports",
      firstTriggered.outputPath,
      rewrittenExportCount,
    );
  }
  report.assertAllRulesFired();
}
