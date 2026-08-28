import path from "node:path";

import type { Plugin } from "esbuild";

import { closureCompilerCapabilities } from "../../../native/load";
import { syncDirectoryEntries } from "../../../shared/files";
import { hashContent } from "../../../shared/hash";
import { createBarrelFlattener } from "../barrels";
import {
  canonicalizeDuplicateLazyEntryOutputs,
  collectCollapsibleBundleEntryOutputs,
} from "../entry-outputs";
import { loadEsbuildModule } from "../esbuild";
import {
  groupBundleRequests,
  renderBundleEntrySource,
  resolveEntryOutputsByRequest,
  sanitizeEntryName,
  sanitizeRegionKey,
} from "../regions";
import type {
  RegionBundleRequest,
  WrittenRegionBundleRequest,
} from "../regions";
import {
  DEP_BUNDLE_INPUT_DIR,
  DEP_BUNDLE_OUTPUT_DIR,
  EAGER_REGION_LABEL,
  toPathIndependentKey,
} from "../shared";
import type { DependencyBundleSet, PrebundleContext } from "../types";
import {
  createMaterializedDependencyResolverPlugin,
  createSourceBoundaryPlugin,
  rewriteAuthoredBoundarySpecifiers,
} from "./plugins";

/** Write region entries, bundle them with esbuild, and stage the outputs. */
export async function buildDependencyBundles(
  context: PrebundleContext,
  bundleRequests: Map<string, RegionBundleRequest>,
  preservedRequestKeys: Set<string>,
  sourceBoundaryFiles: Set<string>,
): Promise<DependencyBundleSet | null> {
  const { materialized, runtimeSrcDir } = context;
  const { groupedRequests, requestGroupKeyByTarget } = groupBundleRequests([
    ...bundleRequests.values(),
  ]);

  const inputDir = path.join(materialized.srcDir, DEP_BUNDLE_INPUT_DIR);
  const outputDir = path.join(runtimeSrcDir, DEP_BUNDLE_OUTPUT_DIR);
  const barrelFlattener = createBarrelFlattener({
    moduleFilePaths: new Set(context.moduleByFilePath.keys()),
  });

  const writtenRequests: WrittenRegionBundleRequest[] = [];
  const inputEntries: Array<{ content: string; relativePath: string }> = [];
  for (const groupedRequest of groupedRequests) {
    const regionDir = path.join(
      inputDir,
      sanitizeRegionKey(
        groupedRequest.requests[0]?.regionKey ?? EAGER_REGION_LABEL,
      ),
    );
    // Hash a srcDir-relative form of the request key: the absolute
    // materialized path must not decide the bundle's output file name, or
    // the same project built from two directories gets different dep-bundle
    // names (and with them different runtime module ids and chunk hashes).
    const fileName = `${sanitizeEntryName(groupedRequest)}-${hashContent(
      toPathIndependentKey(groupedRequest.requestKey, materialized.srcDir),
    ).slice(0, 8)}.js`;
    const entryPoint = path.join(regionDir, fileName);
    const renderedEntry = await renderBundleEntrySource({
      entryPoint,
      requests: groupedRequest.requests,
      resolveDeepExport: (targetFilePath, exportName) =>
        process.env["GCC_DISABLE_BARRELS"] === "1"
          ? Promise.resolve(null)
          : barrelFlattener.resolveDeepExport(targetFilePath, exportName),
    });
    inputEntries.push({
      content: renderedEntry,
      relativePath: path.relative(inputDir, entryPoint).replace(/\\/g, "/"),
    });
    writtenRequests.push({
      entryPoint,
      ...groupedRequest,
    });
  }
  await syncDirectoryEntries(inputDir, inputEntries);

  const esbuildBuild = (await loadEsbuildModule()).build;
  const entryPoints = writtenRequests.map((request) =>
    path.relative(materialized.srcDir, request.entryPoint).replace(/\\/g, "/"),
  );
  const bundleResult = await esbuildBuild({
    absWorkingDir: materialized.srcDir,
    bundle: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[dir]/[name]",
    // Dependencies with dev/prod CJS wrappers (react, react-dom) branch on
    // process.env.NODE_ENV before requiring per-mode files; only the branch
    // Rollup retained is materialized, so the other require target must be
    // eliminated as dead code here rather than resolved.
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env["NODE_ENV"] ?? "production",
      ),
    },
    entryPoints,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    // Without syntax folding, a define-dead branch keeps its text
    // (`if (false) warn(...)`) while tree shaking still drops the declaration
    // it references, which reaches Closure as an undeclared variable. Folding
    // removes the branch instead. Identifiers and whitespace are untouched.
    minifySyntax: true,
    plugins: [
      createSourceBoundaryPlugin(sourceBoundaryFiles, materialized.srcDir),
      createMaterializedDependencyResolverPlugin(
        materialized.dependencySourceFileByMaterializedFile,
        sourceBoundaryFiles,
        materialized.srcDir,
      ),
    ].filter((plugin): plugin is Plugin => plugin !== undefined),
    outdir: DEP_BUNDLE_OUTPUT_DIR,
    outbase: DEP_BUNDLE_INPUT_DIR,
    platform: "browser",
    splitting: true,
    // The pinned Closure syntax table owns this target. Lowering here (instead
    // of per captured module) keeps one shared set of esbuild helpers across
    // all dependency bundles.
    target: closureCompilerCapabilities().prebundleTarget,
    treeShaking: true,
    write: false,
  });
  const bundleOutputRoot = path.join(
    materialized.srcDir,
    DEP_BUNDLE_OUTPUT_DIR,
  );
  await syncDirectoryEntries(
    outputDir,
    (bundleResult.outputFiles ?? [])
      .filter((outputFile) => outputFile.path.endsWith(".js"))
      .map((outputFile) => ({
        content: rewriteAuthoredBoundarySpecifiers({
          bundleOutputRoot,
          outputDir,
          outputFilePath: outputFile.path,
          runtimeSrcDir,
          text: new TextDecoder().decode(outputFile.contents),
        }),
        relativePath: path
          .relative(bundleOutputRoot, outputFile.path)
          .replace(/\\/g, "/"),
      })),
    {
      preserve(relativePath) {
        return relativePath.startsWith("shared/");
      },
    },
  );

  const entryOutputByRequestKey = resolveEntryOutputsByRequest({
    bundleSrcDir: materialized.srcDir,
    metafile: bundleResult.metafile,
    outputSrcDir: runtimeSrcDir,
    writtenRequests,
  });
  if (entryOutputByRequestKey.size === 0) {
    return null;
  }

  const canonicalizedEntryOutputs = await canonicalizeDuplicateLazyEntryOutputs(
    {
      entryOutputByRequestKey,
      outputDir,
      outputSrcDir: runtimeSrcDir,
      writtenRequests,
    },
  );

  const preservedEntryOutputPaths = new Set(
    [...preservedRequestKeys]
      .map((requestKey) =>
        canonicalizedEntryOutputs.outputByRequestKey.get(requestKey),
      )
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  const collapsedEntryOutputByPath = await collectCollapsibleBundleEntryOutputs(
    [...new Set(canonicalizedEntryOutputs.outputByRequestKey.values())].filter(
      (filePath) => !preservedEntryOutputPaths.has(filePath),
    ),
  );

  return {
    canonicalizedEntryOutputs,
    collapsedEntryOutputByPath,
    metafile: bundleResult.metafile,
    requestGroupKeyByTarget,
    writtenRequests,
  };
}
