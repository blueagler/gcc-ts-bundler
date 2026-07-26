import { createHash } from "node:crypto";
import path from "node:path";

import type ts from "typescript";

export const DEP_BUNDLE_INPUT_DIR = "__dep-bundle-inputs";

export const DEP_BUNDLE_OUTPUT_DIR = "__dep-bundles";

export const EAGER_REGION_LABEL = "@eager";

export function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePath(filePath: string) {
  return path.normalize(filePath);
}

export interface ParsedDependencyImport {
  hasDefault: boolean;
  hasNamespace: boolean;
  isSideEffectOnly: boolean;
  namedExports: string[];
  node: ts.ImportDeclaration | ts.ExportDeclaration;
  targetFilePath: string;
}

export interface ParsedMaterializedModule {
  dependencyImports: ParsedDependencyImport[];
  exportedNames: string[];
  hasDefaultExport: boolean;
  staticAuthoredImports: string[];
}
