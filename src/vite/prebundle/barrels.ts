import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { normalizePath } from "./shared";

/**
 * Pure barrel modules (files whose statements are exclusively re-exports)
 * defeat esbuild's code splitting: every region entry that goes through the
 * barrel drags the barrel's whole dependency closure into one shared chunk.
 * Flattening resolves each requested name to the deep module that defines it
 * so esbuild can place per-region components into per-region bundles.
 */

interface BarrelReexport {
  imported: string;
  targetFilePath: string;
}

interface BarrelModuleInfo {
  /** Only pure barrels are safe to skip executing. */
  pure: boolean;
  reexports: Map<string, BarrelReexport>;
  starTargets: string[];
}

interface ResolvedDeepExport {
  imported: string;
  targetFilePath: string;
}

const MAX_BARREL_DEPTH = 8;

export function createBarrelFlattener(input: { moduleFilePaths: Set<string> }) {
  const infoCache = new Map<string, Promise<BarrelModuleInfo>>();

  function loadBarrelInfo(filePath: string): Promise<BarrelModuleInfo> {
    const cached = infoCache.get(filePath);
    if (cached) {
      return cached;
    }
    const loaded = parseBarrelModule(filePath, input.moduleFilePaths);
    infoCache.set(filePath, loaded);
    return loaded;
  }

  return {
    /**
     * Resolves `exportName` of `targetFilePath` through pure re-export chains.
     * Returns null when the module is not a pure barrel or the name cannot be
     * traced, in which case the caller keeps the original specifier.
     */
    async resolveDeepExport(
      targetFilePath: string,
      exportName: string,
    ): Promise<ResolvedDeepExport | null> {
      let currentFilePath = normalizePath(targetFilePath);
      let currentName = exportName;
      for (let depth = 0; depth < MAX_BARREL_DEPTH; depth += 1) {
        const info = await loadBarrelInfo(currentFilePath);
        if (!info.pure) {
          return depth === 0
            ? null
            : { imported: currentName, targetFilePath: currentFilePath };
        }
        const reexport = resolveBarrelName(info, currentName);
        if (!reexport) {
          return null;
        }
        currentFilePath = reexport.targetFilePath;
        currentName = reexport.imported;
      }
      return null;
    },
  };
}

function resolveBarrelName(
  info: BarrelModuleInfo,
  exportName: string,
): BarrelReexport | null {
  const named = info.reexports.get(exportName);
  if (named) {
    return named;
  }
  if (exportName !== "default" && info.starTargets.length === 1) {
    const starTarget = info.starTargets[0];
    if (starTarget !== undefined) {
      return { imported: exportName, targetFilePath: starTarget };
    }
  }
  return null;
}

async function parseBarrelModule(
  filePath: string,
  moduleFilePaths: Set<string>,
): Promise<BarrelModuleInfo> {
  const impure: BarrelModuleInfo = {
    pure: false,
    reexports: new Map(),
    starTargets: [],
  };
  let sourceText: string;
  try {
    sourceText = await fs.readFile(filePath, "utf8");
  } catch {
    return impure;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const reexports = new Map<string, BarrelReexport>();
  const starTargets: string[] = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      return impure;
    }
    const targetFilePath = normalizePath(
      path.resolve(path.dirname(filePath), statement.moduleSpecifier.text),
    );
    if (!moduleFilePaths.has(targetFilePath)) {
      return impure;
    }
    if (!statement.exportClause) {
      starTargets.push(targetFilePath);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) {
      return impure;
    }
    for (const specifier of statement.exportClause.elements) {
      const exportedName = specifier.name.text;
      const importedName = specifier.propertyName?.text ?? exportedName;
      reexports.set(exportedName, {
        imported: importedName,
        targetFilePath,
      });
    }
  }

  return { pure: true, reexports, starTargets };
}
