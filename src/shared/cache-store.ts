import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { CacheMode } from "../api/types";
import { ensureParentDirectory } from "./files";
import type { Validator } from "./validation";
import { hasErrorCode, parseJson } from "./validation";
import { hashContent } from "./hash";

export interface CacheStore {
  cleanup(): Promise<void>;
  mode: CacheMode;
  projectCacheDir: string;
  rootDir: string;
  workspaceDir: string;
}

export function getProjectCacheDir(rootDir: string, projectRoot: string) {
  return path.join(rootDir, hashContent(projectRoot));
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
  cacheDir: string | undefined;
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
  const projectCacheDir = getProjectCacheDir(rootDir, projectRoot);
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

// ponytail: project-wide lock keeps every mutable cache stage coherent; split by key only if measured same-project throughput requires it.
export async function acquireProjectCacheLock(
  projectCacheDir: string,
): Promise<() => Promise<void>> {
  const lockDir = `${projectCacheDir}.lock`;
  const ownerPath = path.join(lockDir, "owner.json");
  const token = `${process.pid}-${randomUUID()}`;
  await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      await fs.promises.mkdir(lockDir);
      await fs.promises.writeFile(
        ownerPath,
        JSON.stringify({ pid: process.pid, token }),
        { encoding: "utf8", flag: "wx" },
      );
      return async () => {
        const owner = await readLockOwner(ownerPath);
        if (owner?.token === token) {
          await fs.promises.rm(lockDir, { force: true, recursive: true });
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        await fs.promises.rm(lockDir, { force: true, recursive: true });
        throw error;
      }
      if (await removeAbandonedLock(lockDir, ownerPath)) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function readJsonIfExists<T>(
  filePath: string,
  validate: Validator<T>,
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf-8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  try {
    return parseJson(raw, validate, filePath);
  } catch {
    await fs.promises.rm(filePath, { force: true }).catch(() => {});
    return null;
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await ensureParentDirectory(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(value, null, 2),
      "utf-8",
    );
    await fs.promises.rename(tempPath, filePath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

interface LockOwner {
  pid: number;
  token: string;
}

async function readLockOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.promises.readFile(ownerPath, "utf8"),
    );
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      typeof value.pid === "number" &&
      "token" in value &&
      typeof value.token === "string"
    ) {
      return { pid: value.pid, token: value.token };
    }
  } catch {
    // The creator may still be writing owner.json; wait and revalidate.
  }
  return null;
}

async function removeAbandonedLock(lockDir: string, ownerPath: string) {
  const owner = await readLockOwner(ownerPath);
  if (owner && processIsAlive(owner.pid)) {
    return false;
  }

  const stat = await fs.promises.stat(lockDir).catch(() => null);
  if (!stat || (!owner && Date.now() - stat.mtimeMs < 60_000)) {
    return !stat;
  }

  const staleDir = `${lockDir}.stale-${randomUUID()}`;
  try {
    await fs.promises.rename(lockDir, staleDir);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    return false;
  }

  const movedOwner = await readLockOwner(path.join(staleDir, "owner.json"));
  if (owner?.token !== movedOwner?.token) {
    await fs.promises.rename(staleDir, lockDir).catch(() => {});
    return false;
  }
  await fs.promises.rm(staleDir, { force: true, recursive: true });
  return true;
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}
