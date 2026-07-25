import fs from "fs";
import path from "path";
import ts from "typescript";

import type { ResolvedBuildOptions } from "../types";
import { hasErrorCode } from "../../shared/validation";

export async function ensureDirectorySymlink(
  linkPath: string,
  targetPath: string,
) {
  try {
    const currentTarget = await fs.promises.readlink(linkPath);
    if (path.resolve(path.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      await fs.promises.rm(linkPath, { force: true, recursive: true });
    }
  }

  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.promises.symlink(
    targetPath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

export async function ensureWorkspaceNodeModules(
  workspaceDir: string,
  options: ResolvedBuildOptions,
) {
  const linkPath = path.join(workspaceDir, "node_modules");
  if (options.packages === "off") {
    await removePathIfExists(linkPath);
    return;
  }

  const nodeModulesPath = path.join(options.projectRoot, "node_modules");
  const hasNodeModules = await fs.promises
    .access(nodeModulesPath)
    .then(() => true)
    .catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }

  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}

export async function resolveTsConfigPath(
  projectRoot: string,
): Promise<string> {
  const configPath = ts.findConfigFile(
    projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }

  return configPath;
}

async function removePathIfExists(targetPath: string) {
  try {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}
