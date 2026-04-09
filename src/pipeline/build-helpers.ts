import fs from "fs";
import path from "path";

import { generateExterns } from "../api/externs";
import { hashJson } from "../cache/hash";
import { readJsonIfExists, writeJson } from "../cache/store";
import {
  copyOrLinkFiles,
  filesExist,
  publishedOutputsMatch,
} from "../internal/file-state";
import { loadCompilerOptions } from "../stages/native/compiler-options";

export interface RuntimeDependencyExternsCacheMetadata {
  key: string;
  outputFile: string;
  version: number;
}

export const RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION = 1;

export async function generateRuntimeDependencyExterns({
  appEntryFiles,
  cacheMode,
  cacheDir,
  dependencyModules,
  dependencyRuntimeFiles,
  projectRoot,
  srcDir,
  tsConfigPath,
}: {
  appEntryFiles: string[];
  cacheMode: "off" | "temp" | "persistent";
  cacheDir: string;
  dependencyModules: string[];
  dependencyRuntimeFiles: string[];
  projectRoot: string;
  srcDir: string;
  tsConfigPath: string;
}) {
  if (dependencyModules.length === 0 || dependencyRuntimeFiles.length === 0) {
    return null;
  }

  const outputFile = path.join(cacheDir, "runtime-dependency-externs.js");
  const metadataPath = path.join(
    cacheDir,
    "runtime-dependency-externs.meta.json",
  );
  if (cacheMode !== "off") {
    const compilerOptions = await loadCompilerOptions(tsConfigPath);
    const cacheKey = hashJson({
      appEntryFiles,
      compilerOptions,
      dependencyModules,
      dependencyRuntimeFiles,
      projectRoot,
      srcDir,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION,
    });
    const cachedMetadata =
      await readJsonIfExists<RuntimeDependencyExternsCacheMetadata>(
        metadataPath,
      );
    if (
      cachedMetadata?.version === RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION &&
      cachedMetadata.key === cacheKey &&
      cachedMetadata.outputFile === outputFile &&
      (await filesExist([outputFile]))
    ) {
      return outputFile;
    }

    await generateExterns({
      appEntryFiles,
      mode: "runtime-aware",
      modules: dependencyModules,
      outputFile,
      projectRoot,
      runtimeEntryFiles: dependencyRuntimeFiles,
      srcDir,
      tsConfigPath,
    });
    await writeJson(metadataPath, {
      key: cacheKey,
      outputFile,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION,
    } satisfies RuntimeDependencyExternsCacheMetadata);
    return outputFile;
  }

  await generateExterns({
    appEntryFiles,
    mode: "runtime-aware",
    modules: dependencyModules,
    outputFile,
    projectRoot,
    runtimeEntryFiles: dependencyRuntimeFiles,
    srcDir,
    tsConfigPath,
  });
  return outputFile;
}

export async function publishOutputs(outputFiles: string[], outDir: string) {
  if (await publishedOutputsMatch(outputFiles, outDir)) {
    return;
  }

  await copyOrLinkFiles(outputFiles, outDir);
}

export function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function toPublishedOutputPaths(
  publishedOutputs: Array<{ name: string }>,
  outDir: string,
) {
  return publishedOutputs.map(({ name }) => path.join(outDir, name));
}

export function createBuildDiagnostic(error: unknown) {
  return {
    category: 1,
    code: 0,
    messageText:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Build failed.",
  };
}

export async function removeProjectCacheDir(projectCacheDir: string) {
  await fs.promises.rm(projectCacheDir, { force: true, recursive: true });
}
