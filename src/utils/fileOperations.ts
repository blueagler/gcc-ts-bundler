import fs from "fs";
import path from "path";

import { ensureDirectoryExistence } from "./fileUtils";

export function copyDirectoryRecursive(src: string, dest: string) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function cleanDirectory(dir: string) {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach((file) => {
      const filePath = path.join(dir, file);
      fs.unlinkSync(filePath);
    });
  }
}

export function writeFileContent(filePath: string, contents: string) {
  ensureDirectoryExistence(filePath);
  fs.writeFileSync(filePath, contents, "utf-8");
}
