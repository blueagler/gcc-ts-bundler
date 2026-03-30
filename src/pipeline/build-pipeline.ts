import fs from "fs";
import path from "path";
import ts from "typescript";

import { BuildOptions, BuildResult, CleanCacheOptions } from "../api/types";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import { hashContent } from "../cache/hash";
import { normalizeBuildOptions, resolveBuild } from "./resolve-build";
import { writeEntryShims } from "../stages/pre-compile/entry-shims";
import { emitTsickleStage } from "../stages/tsickle/emit";
import { runClosureStage } from "../stages/closure/run-closure";

interface FinalCacheMetadata {
  outputFiles: string[];
}

export async function build(options: BuildOptions): Promise<BuildResult> {
  const normalizedOptions = normalizeBuildOptions(options);
  const resolved = await resolveBuild(normalizedOptions);

  try {
    const finalMetadataPath = path.join(resolved.finalCacheDir, "meta.json");
    const finalMetadata =
      await readJsonIfExists<FinalCacheMetadata>(finalMetadataPath);
    if (
      normalizedOptions.cache.mode !== "off" &&
      finalMetadata &&
      (await Promise.all(finalMetadata.outputFiles.map(pathExists))).every(
        Boolean,
      )
    ) {
      await publishOutputs(finalMetadata.outputFiles, normalizedOptions.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        options: normalizedOptions,
        outputFiles: finalMetadata.outputFiles,
        workspaceDir: resolved.workspaceDir,
      };
    }

    await writeEntryShims({
      entries: resolved.entryFiles,
      shimDir: resolved.shimDir,
    });

    const tsickleMetadataPath = path.join(
      resolved.tsickleCacheDir,
      "meta.json",
    );
    const tsickleResult = await emitTsickleStage({
      cacheDir: resolved.tsickleCacheDir,
      compilerOptions: resolved.compilerOptions as ts.CompilerOptions,
      fileNames: [...resolved.filePaths, ...resolved.shimFiles],
      metadataPath: tsickleMetadataPath,
      options: normalizedOptions,
      workspaceDir: resolved.workspaceDir,
    });
    if (tsickleResult.diagnostics.length > 0 || tsickleResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: tsickleResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir,
      };
    }

    const bundledExterns = await collectBundledExterns(resolved.packageRoot);
    const exitCode = await runClosureStage({
      emittedOutDir: tsickleResult.outDir,
      entryFiles: resolved.entryFiles,
      externPaths: [
        ...normalizedOptions.externs,
        ...bundledExterns,
        tsickleResult.externsPath,
      ],
      finalCacheDir: resolved.finalCacheDir,
      graph: {
        ...resolved.graph,
        ...Object.fromEntries(
          resolved.shimFiles.map((shimFile, index) => [
            shimFile,
            [resolved.entryFiles[index].sourcePath],
          ]),
        ),
      },
      options: normalizedOptions,
      packageRoot: resolved.packageRoot,
      shimFiles: resolved.shimFiles,
      workspaceDir: resolved.workspaceDir,
    });
    if (exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode,
        options: normalizedOptions,
        outputFiles: [],
        workspaceDir: resolved.workspaceDir,
      };
    }

    const finalOutputFiles = await collectJavaScriptFiles(
      path.join(resolved.finalCacheDir, "outputs"),
    );
    await writeJson(finalMetadataPath, {
      outputFiles: finalOutputFiles,
    } satisfies FinalCacheMetadata);
    await publishOutputs(finalOutputFiles, normalizedOptions.outDir);

    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      options: normalizedOptions,
      outputFiles: finalOutputFiles,
      workspaceDir: resolved.workspaceDir,
    };
  } catch (error) {
    console.error(error);
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: true,
      exitCode: 1,
      options: normalizedOptions,
      outputFiles: [],
      workspaceDir: resolved.workspaceDir,
    };
  } finally {
    await resolved.cleanup();
  }
}

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path.resolve(
    options.cacheDir || getDefaultPersistentCacheRoot(),
  );
  const projectCacheDir = path.join(cacheRoot, hashContent(projectRoot));
  await fs.promises.rm(projectCacheDir, { force: true, recursive: true });
}

async function collectBundledExterns(packageRoot: string) {
  const closureExternsPath = path.join(packageRoot, "closure-externs");
  const entries = await fs.promises.readdir(closureExternsPath);
  return entries
    .map((entry) => path.join(closureExternsPath, entry))
    .sort((left, right) => left.localeCompare(right));
}

async function collectJavaScriptFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [dir];

  while (pending.length > 0) {
    const currentDir = pending.pop()!;
    const entries = await fs.promises.readdir(currentDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }

  files.sort((left, right) => left.localeCompare(right));
  return files;
}

async function publishOutputs(outputFiles: string[], outDir: string) {
  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });
  await Promise.all(
    outputFiles.map((outputFile) =>
      fs.promises.copyFile(
        outputFile,
        path.join(outDir, path.basename(outputFile)),
      ),
    ),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}
