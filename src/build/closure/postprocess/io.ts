import fs from "fs/promises";

export async function readCachedText(
  filePath: string,
  cache: Map<string, Promise<string>>,
) {
  let pending = cache.get(filePath);
  if (!pending) {
    pending = fs.readFile(filePath, "utf-8");
    cache.set(filePath, pending);
  }
  return pending;
}

export async function readPropertyRenamingReport(
  reportPath: string,
  cache: Map<string, Promise<string>>,
) {
  return readCachedText(reportPath, cache);
}
