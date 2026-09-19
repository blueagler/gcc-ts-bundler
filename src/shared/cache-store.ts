import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import type { CacheMode } from "../api/types";
import { ensureParentDirectory } from "./files";
import type { Validator } from "./validation";
import {
  hasErrorCode,
  isNumber,
  isRecord,
  isString,
  parseJson,
} from "./validation";
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
    try {
      await fs.promises.mkdir(workspaceDir, { recursive: true });
    } catch (error) {
      try {
        await fs.promises.rm(rootDir, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to create workspace and remove ${rootDir}.`,
          { cause: cleanupError },
        );
      }
      throw error;
    }

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
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const owner = await readLockOwner(ownerPath);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(lockDir);
      } catch (statError) {
        if (hasErrorCode(statError, "ENOENT")) continue;
        throw statError;
      }
      if (
        (owner && !processIsAlive(owner.pid)) ||
        (!owner && Date.now() - stat.mtimeMs >= 60_000)
      ) {
        throw new Error(
          `Cache lock ${lockDir} has ${owner ? `inactive owner pid=${owner.pid}, token=${owner.token}` : "no valid owner"}. Check that no build is active before manually removing this exact lock directory.`,
          { cause: error },
        );
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 25);
      await promise;
      continue;
    }
    // Only this successful mkdir establishes ownership; never remove a contender's lock.
    try {
      await fs.promises.writeFile(
        ownerPath,
        JSON.stringify({ pid: process.pid, token }),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (error) {
      try {
        await fs.promises.rm(lockDir, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to initialize and release cache lock ${lockDir}.`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
    return async () => {
      const owner = await readLockOwner(ownerPath);
      if (owner?.token !== token) {
        throw new Error(
          `Cannot release cache lock ${lockDir}: acquired token ${token}, observed ${owner ? `pid=${owner.pid}, token=${owner.token}` : "no valid owner"}. Check that no build is active before manual recovery.`,
        );
      }
      await fs.promises.rm(lockDir, { force: true, recursive: true });
    };
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
  } catch (error) {
    try {
      await fs.promises.rm(filePath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Failed to discard invalid cache metadata ${filePath}.`,
        { cause: cleanupError },
      );
    }
    return null;
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await ensureParentDirectory(filePath);
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const failures: unknown[] = [];
  try {
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(value, null, 2),
      "utf-8",
    );
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    failures.push(error);
  }
  try {
    await fs.promises.rm(tempPath, { force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      `Failed to write and clean temporary metadata for ${filePath}.`,
    );
}

interface LockOwner {
  pid: number;
  token: string;
}

const validateLockOwner: Validator<LockOwner> = (
  value: unknown,
): value is LockOwner =>
  isRecord(value) &&
  isNumber(value["pid"]) &&
  Number.isInteger(value["pid"]) &&
  value["pid"] > 0 &&
  isString(value["token"]) &&
  value["token"].length > 0;

async function readLockOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    return parseJson(
      await fs.promises.readFile(ownerPath, "utf8"),
      validateLockOwner,
      ownerPath,
    );
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    )
      return null;
    throw error;
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}
