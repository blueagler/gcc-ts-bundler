import fs from "fs";

import ts from "@typescript/typescript6";

import type { BuildDiagnostic } from "../api/types";

export function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

export function createBuildDiagnostic(error: unknown): BuildDiagnostic {
  return {
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Build failed.",
  };
}

export function toBuildDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  toAuthoredPath: (filePath: string) => string = (filePath) => filePath,
): BuildDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    if (!diagnostic.file || diagnostic.start === undefined) {
      return { message };
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    return {
      file: toAuthoredPath(diagnostic.file.fileName),
      line: line + 1,
      message,
    };
  });
}

export async function removeProjectCacheDir(projectCacheDir: string) {
  await fs.promises.rm(projectCacheDir, { force: true, recursive: true });
}
