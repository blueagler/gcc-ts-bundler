import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { normalizePath } from "./shared";

/**
 * Pure barrel modules (files whose statements are exclusively re-exports)
 * hide the defining module from both routing paths. Flattening resolves each
 * requested name to its unique deep definition so esbuild can split CJS/mixed
 * regions and native direct-ESM input can avoid broad namespace barrels.
 */

interface BarrelReexport {
  imported: string;
  targetFilePath: string;
}

interface BarrelModuleInfo {
  localExports: Set<string>;
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
      const normalizedTarget = normalizePath(targetFilePath);
      if (!(await loadBarrelInfo(normalizedTarget)).pure) {
        return null;
      }
      return await resolveBarrelExport(
        normalizedTarget,
        exportName,
        0,
        new Set<string>(),
      );
    },
  };

  async function resolveBarrelExport(
    filePath: string,
    exportName: string,
    depth: number,
    seen: Set<string>,
  ): Promise<ResolvedDeepExport | null> {
    if (depth >= MAX_BARREL_DEPTH) {
      return null;
    }
    const key = `${filePath}\u0000${exportName}`;
    if (seen.has(key)) {
      return null;
    }
    const nextSeen = new Set(seen).add(key);
    const info = await loadBarrelInfo(filePath);
    const named = info.reexports.get(exportName);
    if (named) {
      return await resolveBarrelExport(
        named.targetFilePath,
        named.imported,
        depth + 1,
        nextSeen,
      );
    }
    if (info.localExports.has(exportName)) {
      return { imported: exportName, targetFilePath: filePath };
    }
    if (exportName === "default") {
      return null;
    }

    const candidates = (
      await Promise.all(
        info.starTargets.map((targetFilePath) =>
          resolveBarrelExport(targetFilePath, exportName, depth + 1, nextSeen),
        ),
      )
    ).filter(
      (candidate): candidate is ResolvedDeepExport => candidate !== null,
    );
    const uniqueCandidates = new Map(
      candidates.map((candidate) => [
        `${candidate.targetFilePath}\u0000${candidate.imported}`,
        candidate,
      ]),
    );
    return uniqueCandidates.size === 1
      ? (uniqueCandidates.values().next().value ?? null)
      : null;
  }
}

async function parseBarrelModule(
  filePath: string,
  moduleFilePaths: Set<string>,
): Promise<BarrelModuleInfo> {
  const impure: BarrelModuleInfo = {
    localExports: new Set(),
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
  const localExports = new Set<string>();
  const reexports = new Map<string, BarrelReexport>();
  const starTargets: string[] = [];
  let pure = true;

  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) {
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) {
        continue;
      }
      if (
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
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
        continue;
      }
      pure = false;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          localExports.add(specifier.name.text);
        }
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      pure = false;
      if (!statement.isExportEquals) {
        localExports.add("default");
      }
      continue;
    }
    if (
      ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      pure = false;
      collectExportedDeclarationNames(statement, localExports);
      continue;
    }
    pure = false;
  }

  return { localExports, pure, reexports, starTargets };
}

function collectExportedDeclarationNames(
  statement: ts.Statement,
  names: Set<string>,
) {
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    names.add(statement.name.text);
    if (
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
      )
    ) {
      names.add("default");
    }
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.add(declaration.name.text);
      }
    }
  }
}
