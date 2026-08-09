import { createHash } from "node:crypto";
import path from "node:path";

import type ts from "@typescript/typescript6";

/** Region label for per-target atoms imported by direct dependency modules. */
export const ATOM_REGION_LABEL = "@atom";

export const DEP_BUNDLE_INPUT_DIR = "__dep-bundle-inputs";

export const DEP_BUNDLE_OUTPUT_DIR = "__dep-bundles";

export const EAGER_REGION_LABEL = "@eager";

export function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePath(filePath: string) {
  return path.normalize(filePath);
}

/**
 * Strips the absolute materialized srcDir from every path embedded in a
 * request key, so hashes derived from the key are identical no matter where
 * the project happens to live on disk.
 */
export function toPathIndependentKey(key: string, srcDir: string) {
  return key.split(`${normalizePath(srcDir)}${path.sep}`).join("");
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
  bareImportSpecifiers: string[];
  dependencyFilePaths: string[];
  dependencyImports: ParsedDependencyImport[];
  exportedNames: string[];
  hasDefaultExport: boolean;
  /**
   * True when the materialized text still reads a build-time define
   * (`process.env.NODE_ENV`, an `__UPPER__` identifier). Materialization
   * substitutes the defines Vite owns, so anything left is unresolved and
   * must not reach the native pipeline unbundled.
   */
  hasDefineReferences: boolean;
  /** True when the text carries more than one `// #region` fusion marker. */
  isFusedDistribution: boolean;
  staticAuthoredImports: string[];
}
