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

interface BarrelParseState {
  localExports: Set<string>;
  pure: boolean;
  reexports: Map<string, BarrelReexport>;
  starTargets: string[];
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
  const state: BarrelParseState = {
    localExports: new Set(),
    pure: true,
    reexports: new Map(),
    starTargets: [],
  };

  for (const statement of sourceFile.statements) {
    if (ts.isEmptyStatement(statement)) {
      continue;
    }
    if (!recordBarrelStatement(statement, filePath, moduleFilePaths, state)) {
      return impure;
    }
  }

  return {
    localExports: state.localExports,
    pure: state.pure,
    reexports: state.reexports,
    starTargets: state.starTargets,
  };
}

/** Returns false when the module is not a known in-graph re-export target. */
function recordBarrelStatement(
  statement: ts.Statement,
  filePath: string,
  moduleFilePaths: Set<string>,
  state: BarrelParseState,
): boolean {
  if (ts.isExportDeclaration(statement)) {
    return recordBarrelExportDeclaration(
      statement,
      filePath,
      moduleFilePaths,
      state,
    );
  }
  if (ts.isExportAssignment(statement)) {
    state.pure = false;
    if (!statement.isExportEquals) {
      state.localExports.add("default");
    }
    return true;
  }
  if (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  ) {
    state.pure = false;
    collectExportedDeclarationNames(statement, state.localExports);
    return true;
  }
  state.pure = false;
  return true;
}

function recordBarrelExportDeclaration(
  statement: ts.ExportDeclaration,
  filePath: string,
  moduleFilePaths: Set<string>,
  state: BarrelParseState,
): boolean {
  if (statement.isTypeOnly) {
    return true;
  }
  if (
    statement.moduleSpecifier &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return recordBarrelFromExport(
      statement,
      statement.moduleSpecifier.text,
      filePath,
      moduleFilePaths,
      state,
    );
  }
  state.pure = false;
  if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
    for (const specifier of statement.exportClause.elements) {
      state.localExports.add(specifier.name.text);
    }
  }
  return true;
}

function recordBarrelFromExport(
  statement: ts.ExportDeclaration,
  specifierText: string,
  filePath: string,
  moduleFilePaths: Set<string>,
  state: BarrelParseState,
): boolean {
  const targetFilePath = normalizePath(
    path.resolve(path.dirname(filePath), specifierText),
  );
  if (!moduleFilePaths.has(targetFilePath)) {
    return false;
  }
  if (!statement.exportClause) {
    state.starTargets.push(targetFilePath);
    return true;
  }
  if (!ts.isNamedExports(statement.exportClause)) {
    return false;
  }
  for (const specifier of statement.exportClause.elements) {
    const exportedName = specifier.name.text;
    const importedName = specifier.propertyName?.text ?? exportedName;
    state.reexports.set(exportedName, {
      imported: importedName,
      targetFilePath,
    });
  }
  return true;
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
