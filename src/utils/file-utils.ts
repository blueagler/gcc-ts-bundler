import fs from "fs";
import path from "path";

export async function ensureDirectoryExistence(
  filePath: string,
): Promise<void> {
  const dirName = path.dirname(filePath);
  if (
    await fs.promises
      .access(dirName)
      .then(() => true)
      .catch(() => false)
  )
    return;
  await fs.promises.mkdir(dirName, { recursive: true });
}
