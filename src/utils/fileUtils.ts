import fs from "fs";
import path from "path";

export function usage(): void {
  console.error(`Usage: gcc-ts-compiler [gcc-ts-compiler options]

Example:
  gcc-ts-bundler --src_dir='./src' --entry_point='./index.ts' --output_dir='./dist' --language_out=ECMASCRIPT_NEXT

gcc-ts-compiler flags are:
  --src_dir             The source directory
  --entry_point         The entry point for the application
  --output_dir          The output directory
  --language_out        ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
  --compilation_level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --preserve_cache      Whether to preserve the cache files for debugging
  --verbose             Print diagnostics to the console
  --fatal_warnings       Whether warnings should be fatal, causing tsickle to return a non-zero exit code
  -h, --help            Show this help message
`);
}

export function getCommonParentDirectory(fileNames: string[]): string {
  if (fileNames.length === 0) return "/";
  const commonPath = fileNames
    .map((fileName) => fileName.split(path.sep))
    .reduce((commonParts, pathParts) => {
      const minLength = Math.min(commonParts.length, pathParts.length);
      const newCommonParts = [];
      for (let i = 0; i < minLength; i++) {
        if (commonParts[i] !== pathParts[i]) break;
        newCommonParts.push(commonParts[i]);
      }
      return newCommonParts;
    });
  return commonPath.length > 0 ? commonPath.join(path.sep) : "/";
}

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
