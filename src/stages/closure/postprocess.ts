import fs from "fs/promises";

import { ensureParentDirectory } from "../../internal/files";
import { rewriteDecoratorMetadata, rewriteGccExports } from "../../native/load";
import type { prepareClosureJobs } from "../../native/load";
import {
  applyEs5HelperRewrite,
  createEs5HelperRewriteContext,
} from "./postprocess/es5";
import { readCachedText, readPropertyRenamingReport } from "./postprocess/io";
import {
  canonicalizeBundlerRuntimeRootAccess,
  findBundlerRuntimeFinalizeAlias,
  injectBundlerRuntimeEs5HelperBag,
  wrapBundlerRuntimeOutputFile,
} from "./postprocess/runtime";

export async function runClosurePostprocess({
  chunkMode,
  languageOut,
  prepared,
}: {
  chunkMode: string;
  languageOut: string;
  prepared: ReturnType<typeof prepareClosureJobs>;
}) {
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
      const wrapBundlerRuntimeOutput = chunkMode === "bundler-runtime";
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
        !wrapBundlerRuntimeOutput;
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
      contents = canonicalizeBundlerRuntimeRootAccess(contents);
      if (wrapBundlerRuntimeOutput) {
        contents = wrapBundlerRuntimeOutputFile(contents);
      }
      await fs.writeFile(action.outputPath, contents);
    }),
  );
}
