import fs from "fs";
import os from "os";
import path from "path";

import { CacheMode } from "../api/types";
import { hashContent } from "./hash";

export interface CacheStore {
  cleanup(): Promise<void>;
  mode: CacheMode;
  projectCacheDir: string;
  rootDir: string;
  workspaceDir: string;
}

export function getDefaultPersistentCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }

  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "gcc-ts-bundler",
    );
  }

  return path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "gcc-ts-bundler",
  );
}

export async function createCacheStore({
  cacheDir,
  mode,
  projectRoot,
}: {
  cacheDir?: string;
  mode: CacheMode;
  projectRoot: string;
}): Promise<CacheStore> {
  if (mode === "off" || mode === "temp") {
    const rootDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "gcc-ts-bundler-"),
    );
    const workspaceDir = path.join(rootDir, "workspace");
    await fs.promises.mkdir(workspaceDir, { recursive: true });

    return {
      async cleanup() {
        await fs.promises.rm(rootDir, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir,
      rootDir,
      workspaceDir,
    };
  }

  const rootDir = path.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path.join(rootDir, hashContent(projectRoot));
  const workspaceDir = path.join(projectCacheDir, "workspace");
  await fs.promises.mkdir(workspaceDir, { recursive: true });

  return {
    async cleanup() {},
    mode,
    projectCacheDir,
    rootDir,
    workspaceDir,
  };
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await ensureDirectoryExistence(filePath);
  await fs.promises.writeFile(
    filePath,
    JSON.stringify(value, null, 2),
    "utf-8",
  );
}

async function ensureDirectoryExistence(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}
