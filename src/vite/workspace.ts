import fs from "node:fs/promises";
import path from "node:path";

import type { ResolvedConfig } from "vite";

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
}): Promise<ViteWorkspaceLayout> {
  const captureRoot = input.debugDir
    ? path.resolve(input.projectRoot, input.debugDir)
    : resolveViteCaptureRootPath({
        config: input.config,
        options: input.options,
        projectRoot: input.projectRoot,
      });
  if (input.debugDir) {
    await fs.rm(captureRoot, { force: true, recursive: true });
  }
  const workspace = {
    captureRoot,
    coreOutDir: path.join(captureRoot, CORE_OUTPUT_DIR),
    finalOutDir: path.join(captureRoot, FINAL_OUTPUT_DIR),
    materializedSrcDir: path.join(captureRoot, "materialized-src"),
    srcDir: path.join(captureRoot, "src"),
  } satisfies ViteWorkspaceLayout;
  await Promise.all(
    [
      workspace.captureRoot,
      workspace.coreOutDir,
      workspace.finalOutDir,
      workspace.materializedSrcDir,
      workspace.srcDir,
    ].map((dirPath) => fs.mkdir(dirPath, { recursive: true })),
  );
  return workspace;
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
