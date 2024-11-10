import fs from "fs";
import path from "path";

import { ensureDirectoryExistence } from "./fileUtils";

export async function copyDirectoryRecursive(
  src: string,
  dest: string,
): Promise<void> {
  if (
    !(await fs.promises
      .access(dest)
      .then(() => true)
      .catch(() => false))
  ) {
    await fs.promises.mkdir(dest, { recursive: true });
  }

  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await copyDirectoryRecursive(srcPath, destPath);
      } else {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }),
  );
}

export async function cleanDirectory(dir: string): Promise<void> {
  if (
    !(await fs.promises
      .access(dir)
      .then(() => true)
      .catch(() => false))
  ) {
    return;
  }

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await cleanDirectory(fullPath);
        await fs.promises.rmdir(fullPath);
      } else {
        await fs.promises.unlink(fullPath);
      }
    }),
  );
}

export async function writeFileContent(
  filePath: string,
  contents: string,
): Promise<void> {
  await ensureDirectoryExistence(filePath);
  await fs.promises.writeFile(filePath, contents, "utf-8");
}

export async function cleanupDirectories(dirs: string[], remove = true) {
  await Promise.all(
    dirs.map(async (dir) => {
      await cleanDirectory(dir);
      if (remove) {
        await fs.promises.rmdir(dir);
      }
    }),
  );
}
