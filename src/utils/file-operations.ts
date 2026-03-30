import fs from "fs";

import { ensureDirectoryExistence } from "./file-utils";

export async function copyDirectoryRecursive(
  src: string,
  dest: string,
): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });

  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const srcPath = `${src}/${entry.name}`;
      const destPath = `${dest}/${entry.name}`;

      if (entry.isDirectory()) {
        await copyDirectoryRecursive(srcPath, destPath);
        return;
      }

      await fs.promises.copyFile(srcPath, destPath);
    }),
  );
}

export async function cleanDirectory(dir: string): Promise<void> {
  await fs.promises.rm(dir, { force: true, recursive: true });
  await fs.promises.mkdir(dir, { recursive: true });
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
    dirs.map((dir) =>
      remove
        ? fs.promises.rm(dir, { force: true, recursive: true })
        : cleanDirectory(dir),
    ),
  );
}
