import fs from "fs";
import path from "path";

export function usage(): void {
  console.error(`Usage: gcc-ts-compiler [gcc-ts-compiler options]

Example:
  gcc-ts-bundler --src-dir='./src' --entry_point='./index.ts' --js_output_file='./dist/index.js'

gcc-ts-compiler flags are:
  --fatalWarnings       Whether warnings should be fatal, causing tsickle to return a non-zero exit code
  --verbose             Print diagnostics to the console
  --language_out        ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
  --entry_point         The entry point for the application
  --js_output_file      The output file for the generated JS
  --compilation_level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --src-dir             The source directory
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

export function ensureDirectoryExistence(filePath: string): void {
  const dirName = path.dirname(filePath);
  if (fs.existsSync(dirName)) return;
  fs.mkdirSync(dirName, { recursive: true });
}
