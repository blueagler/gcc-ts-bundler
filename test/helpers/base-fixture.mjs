import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "bun:test";

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function getProjectCacheDir(cacheDir, projectRoot) {
  return path.join(cacheDir, hashText(projectRoot));
}

export async function findFilesNamed(rootDir, fileName) {
  const matches = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.name === fileName) {
        matches.push(entryPath);
      }
    }
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

export async function listDirectoryNames(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-ts-bundler-test-"));
  onTestFinished(async () => {
    await fs.rm(root, { force: true, recursive: true });
  });

  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ESNext",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    outDir: path.join(root, "dist"),
    projectRoot: root,
    srcDir: path.join(root, "src"),
    async read(relativePath) {
      return fs.readFile(path.join(root, relativePath), "utf8");
    },
    async write(relativePath, contents) {
      const filePath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf8");
    },
  };
}
