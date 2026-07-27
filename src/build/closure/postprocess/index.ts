import fs from "fs/promises";
import path from "path";

import { ensureParentDirectory } from "../../../shared/files";
import {
  rewriteDecoratorMetadata,
  rewriteGccExports,
} from "../../../native/load";
import type { prepareClosureJobs } from "../../../native/load";
import { applyEs5HelperRewrite, createEs5HelperRewriteContext } from "./es5";
import { readCachedText, readPropertyRenamingReport } from "./io";
import {
  canonicalizeBundlerRuntimeRootAccess,
  findBundlerRuntimeFinalizeAlias,
  injectBundlerRuntimeEs5HelperBag,
  wrapBundlerRuntimeOutputFile,
} from "./runtime";

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

export async function runClosurePostprocess({
  chunkMode,
  chunkOutputType,
  languageOut,
  prepared,
}: {
  chunkMode: string;
  chunkOutputType: "esm" | "script";
  languageOut: string;
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

  const propertyRenamingReports = new Map<string, Promise<string>>();
  const es5Rewrite = createEs5HelperRewriteContext({
    bundlerRuntimeBaseInputPath: prepared.bundlerRuntimeBaseInputPath,
    chunkMode,
    languageOut,
  });
  const inputContents = new Map<string, Promise<string>>();
  const inputPaths = [
    ...new Set(prepared.postprocessActions.map((action) => action.inputPath)),
  ];

  await Promise.all(
    inputPaths.map(async (inputPath) => {
      if (!es5Rewrite.requiresInputRead()) {
        return;
      }
      const originalContents = await readCachedText(inputPath, inputContents);
      applyEs5HelperRewrite(inputPath, originalContents, es5Rewrite);
    }),
  );

  await Promise.all(
    prepared.postprocessActions.map(async (action) => {
      await ensureParentDirectory(action.outputPath);
      // ES_MODULES output has no $gcc namespace to canonicalize and cannot be
      // wrapped: `import`/`export` are top-level-only, and Closure ignores
      // --isolation_mode for chunk output. Decorator-metadata rewriting and
      // the ES5 helper bag stay on in both modes.
      const wrapBundlerRuntimeOutput =
        chunkMode === "bundler-runtime" && chunkOutputType !== "esm";
      const reportText = action.propertyRenamingReportPath
        ? await readPropertyRenamingReport(
            action.propertyRenamingReportPath,
            propertyRenamingReports,
          )
        : "";
      const hasNoRewriteActions =
        action.kind === "copy" &&
        !reportText &&
        !es5Rewrite.requiresInputRead() &&
        !wrapBundlerRuntimeOutput &&
        !baseSpecifierRewrite;
      if (hasNoRewriteActions) {
        await fs.copyFile(action.inputPath, action.outputPath);
        return;
      }

      const originalContents = await readCachedText(
        action.inputPath,
        inputContents,
      );
      let contents = applyEs5HelperRewrite(
        action.inputPath,
        originalContents,
        es5Rewrite,
      );
      if (
        action.kind === "rewrite-gcc-exports" ||
        action.kind === "rewrite-gcc-exports-and-decorator-metadata"
      ) {
        contents = rewriteGccExports(contents);
      }
      if (
        reportText &&
        (action.kind === "rewrite-decorator-metadata" ||
          action.kind === "rewrite-gcc-exports-and-decorator-metadata")
      ) {
        contents = rewriteDecoratorMetadata(contents, reportText);
      }
      if (action.inputPath === prepared.bundlerRuntimeBaseInputPath) {
        const runtimeAlias = findBundlerRuntimeFinalizeAlias(contents);
        contents = injectBundlerRuntimeEs5HelperBag(
          contents,
          es5Rewrite.renderHelperBag(runtimeAlias),
        );
      }
      if (chunkOutputType !== "esm") {
        contents = canonicalizeBundlerRuntimeRootAccess(contents);
      }
      if (wrapBundlerRuntimeOutput) {
        contents = wrapBundlerRuntimeOutputFile(contents);
      }
      if (
        baseSpecifierRewrite &&
        action.inputPath !== prepared.bundlerRuntimeBaseInputPath
      ) {
        contents = contents.replaceAll(
          baseSpecifierRewrite.from,
          baseSpecifierRewrite.to,
        );
      }
      await fs.writeFile(action.outputPath, contents);
    }),
  );
}
