import { createHash } from "node:crypto";
import path from "node:path";

import ts from "typescript";

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

export function classifyPackageName(moduleId: string) {
  const normalized = moduleId.replace(/\\/g, "/");
  const nodeModulesIndex = normalized.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) {
    return "bundle";
  }

  const packagePath = normalized.slice(
    nodeModulesIndex + "/node_modules/".length,
  );
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || "bundle";
}
