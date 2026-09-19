import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ResolvedConfig } from "vite";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import { acquireProjectCacheLock } from "../shared/cache-store";
import { syncDirectoryEntries } from "../shared/files";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type {
  CompiledCoreOutputSet,
  ViteWorkspaceLayout,
} from "./internal-types";
import { resolveViteCaptureRootPath } from "./capture";

const CORE_OUTPUT_DIR = "gcc-core-out";
const FINAL_OUTPUT_DIR = "gcc-final-out";

export async function prepareViteWorkspace(input: {
  config: ResolvedConfig;
  debugDir: string | undefined;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}): Promise<ViteWorkspaceLayout & { dispose(): Promise<void> }> {
  const cacheMode =
    input.options.compiler?.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode;
  let captureRoot: string;
  if (input.debugDir) {
    captureRoot = path.resolve(
      input.projectRoot,
      input.debugDir,
      "gcc-ts-bundler",
    );
  } else if (cacheMode === "persistent") {
    captureRoot = resolveViteCaptureRootPath({
      config: input.config,
      options: input.options,
      projectRoot: input.projectRoot,
    });
  } else {
    captureRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "gcc-ts-bundler-vite-"),
    );
  }
  // Stable capture roots contain mutable prebundle and staged output trees.
  // Hold their distinct lock through emit, not only while creating directories.
  const releaseLock =
    input.debugDir || cacheMode === "persistent"
      ? await acquireProjectCacheLock(captureRoot)
      : undefined;
  let coreOutputRoot = captureRoot;
  const dispose = async () => {
    const failures: unknown[] = [];
    const directories = [];
    if (coreOutputRoot !== captureRoot) directories.push(coreOutputRoot);
    if (!input.debugDir && cacheMode !== "persistent") {
      directories.push(captureRoot);
    }
    for (const directory of directories) {
      try {
        await fs.rm(directory, { force: true, recursive: true });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await releaseLock?.();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Failed to release the Vite workspace.",
      );
    }
  };
  try {
    if (cacheMode === "persistent") {
      // Publication cannot target the cache containing captured inputs. This
      // invocation owns the external output tree; the compiler keys external
      // outDir paths as "..", so fresh destinations still reuse canonical bytes.
      coreOutputRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "gcc-ts-bundler-vite-output-"),
      );
    }
    const workspace = {
      captureRoot,
      coreOutDir: path.join(coreOutputRoot, CORE_OUTPUT_DIR),
      finalOutDir: path.join(captureRoot, FINAL_OUTPUT_DIR),
      materializedSrcDir: path.join(captureRoot, "materialized-src"),
      srcDir: path.join(captureRoot, "src"),
    } satisfies ViteWorkspaceLayout;
    if (input.debugDir) {
      await fs.rm(captureRoot, { force: true, recursive: true });
    }
    for (const dirPath of [
      workspace.coreOutDir,
      workspace.finalOutDir,
      workspace.materializedSrcDir,
      workspace.srcDir,
    ]) {
      await fs.mkdir(dirPath, { recursive: true });
    }
    return { ...workspace, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to prepare and release the Vite workspace.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function stageCompiledCoreOutputs(input: {
  coreOutDir: string;
  finalOutDir: string;
  outputFiles: readonly string[];
}): Promise<CompiledCoreOutputSet> {
  const stagedEntries = await Promise.all(
    input.outputFiles.map(async (outputFile) => ({
      content: await fs.readFile(outputFile),
      relativePath: path
        .relative(input.coreOutDir, outputFile)
        .replace(/\\/g, "/"),
    })),
  );
  await syncDirectoryEntries(input.finalOutDir, stagedEntries);
  return {
    finalOutDir: input.finalOutDir,
    outputFiles: stagedEntries.map((entry) =>
      path.join(input.finalOutDir, entry.relativePath),
    ),
  };
}
