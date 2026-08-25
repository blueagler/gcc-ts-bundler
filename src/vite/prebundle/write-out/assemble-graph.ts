import fs from "node:fs/promises";
import path from "node:path";

import { writeJson } from "../../../shared/cache-store";
import { syncDirectoryEntries } from "../../../shared/files";
import type { MaterializedGraph } from "../../internal-types";
import { withOneToOneTypeProvenance } from "../../type-metadata";
import {
  collectBundledModules,
  collectExportFacadesByOutputPath,
} from "./collect-bundled-modules";
import { rewriteDirectDependencyModules } from "../entry-outputs";
import { remapRuntimeModuleToSrcDir } from "./remap-runtime-module";
import { DEP_BUNDLE_OUTPUT_DIR, hashText, normalizePath } from "../shared";
import type { DependencyBundleSet, PrebundleContext } from "../types";

const MATERIALIZED_DEPENDENCY_BUNDLE_MARKER =
  ".gcc-ts-bundler-materialized-dependency-bundles.json";

interface MaterializedDependencyBundleMarker {
  files: Array<{ path: string; sha256: string }>;
  kind: "gcc-ts-bundler-materialized-dependency-bundles";
  version: 1;
}

async function writeMaterializedDependencyBundleMarker(input: {
  bundleDir: string;
  files: string[];
}) {
  const files = await Promise.all(
    [...new Set(input.files)]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        path: path.relative(input.bundleDir, filePath).replace(/\\/g, "/"),
        sha256: hashText(await fs.readFile(filePath, "utf8")),
      })),
  );
  await writeJson(
    path.join(input.bundleDir, MATERIALIZED_DEPENDENCY_BUNDLE_MARKER),
    {
      files,
      kind: "gcc-ts-bundler-materialized-dependency-bundles",
      version: 1,
    } satisfies MaterializedDependencyBundleMarker,
  );
}

/** Merge rewritten authored modules and bundle outputs into the final graph. */
export async function assembleGraph(
  context: PrebundleContext,
  bundles: DependencyBundleSet,
  authoredEntries: Array<{ content: string; relativePath: string }>,
  directDependencyFilePaths: Set<string>,
  entryRequestKeyByTargetFilePath: Map<string, string>,
  atomOutputByTargetFilePath: Map<string, string>,
): Promise<MaterializedGraph> {
  const { authoredFiles, materialized, runtimeSrcDir } = context;
  const originalSourceIdsByFilePath = new Map(
    materialized.modules.map((module) => [
      normalizePath(module.filePath),
      [...module.sourceModuleIds],
    ]),
  );
  const bundleInputSourceIdsByEntry = new Map(
    bundles.writtenRequests.map((request) => [
      request.entryPoint,
      request.sourceModuleIds,
    ]),
  );
  const directDependencyEntries = await rewriteDirectDependencyModules({
    atomOutputByTargetFilePath,
    collapsedEntryOutputByPath: bundles.collapsedEntryOutputByPath,
    directDependencyFilePaths,
    materialized,
    runtimeSrcDir,
  });
  await syncDirectoryEntries(
    runtimeSrcDir,
    [...authoredEntries, ...directDependencyEntries],
    {
      preserve(relativePath) {
        return relativePath.startsWith(`${DEP_BUNDLE_OUTPUT_DIR}/`);
      },
    },
  );

  const bundledModules = await collectBundledModules({
    extraModules: bundles.canonicalizedEntryOutputs.canonicalModules,
    bundleSrcDir: materialized.srcDir,
    exportFacadesByOutputPath: collectExportFacadesByOutputPath(bundles),
    metafile: bundles.metafile,
    omittedFilePaths: new Set([
      ...bundles.collapsedEntryOutputByPath.keys(),
      ...bundles.canonicalizedEntryOutputs.omittedOutputFilePaths,
    ]),
    outputSrcDir: runtimeSrcDir,
    originalSourceIdsByFilePath,
    syntheticSourceIdsByFilePath: bundleInputSourceIdsByEntry,
  });

  await writeMaterializedDependencyBundleMarker({
    bundleDir: path.join(runtimeSrcDir, DEP_BUNDLE_OUTPUT_DIR),
    files: bundledModules.map((module) => module.filePath),
  });

  const runtimeEntrySpecifiers = materialized.entries.map((entry) => {
    const targetFilePath = normalizePath(
      path.resolve(materialized.srcDir, entry),
    );
    const requestKey = entryRequestKeyByTargetFilePath.get(targetFilePath);
    let outputFilePath = requestKey
      ? bundles.canonicalizedEntryOutputs.outputByRequestKey.get(
          bundles.requestGroupKeyByTarget.get(requestKey) ?? requestKey,
        )
      : undefined;
    if (outputFilePath) {
      outputFilePath =
        bundles.collapsedEntryOutputByPath.get(outputFilePath)
          ?.directTargetFilePath ?? outputFilePath;
    }
    return outputFilePath
      ? `./${path.relative(runtimeSrcDir, outputFilePath).replace(/\\/g, "/")}`
      : entry;
  });

  return {
    ...materialized,
    entries: runtimeEntrySpecifiers,
    authoredFiles: authoredEntries
      .map((entry) => path.join(runtimeSrcDir, entry.relativePath))
      .sort((left, right) => left.localeCompare(right)),
    modules: [
      ...materialized.modules
        .filter(
          (module) =>
            authoredFiles.has(normalizePath(module.filePath)) ||
            directDependencyFilePaths.has(normalizePath(module.filePath)),
        )
        .map((module) =>
          withOneToOneTypeProvenance(
            remapRuntimeModuleToSrcDir(
              module,
              materialized.srcDir,
              runtimeSrcDir,
            ),
          ),
        ),
      ...bundledModules,
    ].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    runtimeEntries: [
      ...new Set(
        [
          ...runtimeEntrySpecifiers,
          ...authoredEntries.map((entry) => `./${entry.relativePath}`),
          ...directDependencyEntries.map((entry) => `./${entry.relativePath}`),
          ...bundledModules.map((module) => `./${module.relativePath}`),
        ].sort((left, right) => left.localeCompare(right)),
      ),
    ],
    srcDir: runtimeSrcDir,
  } satisfies MaterializedGraph;
}
