import fs from "fs";
import path from "path";
import ts from "typescript";

import type { ResolvedBuildOptions } from "../types";
import { hasErrorCode } from "../../shared/validation";

export async function ensureDirectorySymlink(
  linkPath: string,
  targetPath: string,
) {
  const resolvedTargetPath = path.resolve(targetPath);
  await fs.promises.mkdir(path.dirname(linkPath), { recursive: true });

  // ponytail: bound retries so conflicting targets cannot livelock the build.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await symlinkTargetsPath(linkPath, resolvedTargetPath)) {
      return;
    }
    await removePathIfExists(linkPath);
    try {
      await fs.promises.symlink(
        resolvedTargetPath,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      return;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
      if (await symlinkTargetsPath(linkPath, resolvedTargetPath)) {
        return;
      }
    }
  }

  throw new Error(`Unable to create directory symlink ${linkPath}`);
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

  const nodeModulesPath = await findNearestNodeModules(options.projectRoot);
  if (!nodeModulesPath) {
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

async function findNearestNodeModules(projectRoot: string) {
  let currentDir = path.resolve(projectRoot);
  while (true) {
    const nodeModulesPath = path.join(currentDir, "node_modules");
    try {
      if ((await fs.promises.stat(nodeModulesPath)).isDirectory()) {
        return nodeModulesPath;
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) {
        throw error;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function symlinkTargetsPath(linkPath: string, targetPath: string) {
  try {
    const currentTarget = await fs.promises.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), currentTarget) === targetPath;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EINVAL")) {
      return false;
    }
    throw error;
  }
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
