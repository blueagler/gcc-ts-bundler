import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { normalizePath } from "../shared";

export interface CollapsibleBundleEntryOutput {
  directTargetFilePath: string;
  sideEffectImportFilePaths: string[];
}

interface CollapsibleAnalysisState {
  directTargetFilePath: string | null;
  importedBindingNames: Set<string>;
  sideEffectImportFilePaths: Set<string>;
}

export async function collectCollapsibleBundleEntryOutputs(
  outputFilePaths: string[],
) {
  const collapsibleByPath = new Map<string, CollapsibleBundleEntryOutput>();
  for (const outputFilePath of outputFilePaths) {
    const collapsible =
      await analyzeCollapsibleBundleEntryOutput(outputFilePath);
    if (!collapsible) {
      continue;
    }
    collapsibleByPath.set(outputFilePath, collapsible);
  }
  return collapsibleByPath;
}

async function analyzeCollapsibleBundleEntryOutput(outputFilePath: string) {
  const sourceText = await fs.readFile(outputFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    outputFilePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const state: CollapsibleAnalysisState = {
    directTargetFilePath: null,
    importedBindingNames: new Set(),
    sideEffectImportFilePaths: new Set(),
  };

  const resolveTarget = (specifier: string) =>
    normalizePath(path.resolve(path.dirname(outputFilePath), specifier));

  for (const statement of sourceFile.statements) {
    if (!analyzeEntryStatement(statement, state, resolveTarget)) {
      return null;
    }
  }

  const directTargetFilePath = state.directTargetFilePath;
  if (directTargetFilePath === null) {
    return null;
  }

  state.sideEffectImportFilePaths.delete(directTargetFilePath);
  return {
    directTargetFilePath,
    sideEffectImportFilePaths: [...state.sideEffectImportFilePaths].sort(
      (left, right) => left.localeCompare(right),
    ),
  } satisfies CollapsibleBundleEntryOutput;
}

/** Returns false when the statement rules out collapsing the entry output. */
function analyzeEntryStatement(
  statement: ts.Statement,
  state: CollapsibleAnalysisState,
  resolveTarget: (specifier: string) => string,
): boolean {
  if (
    ts.isImportDeclaration(statement) &&
    statement.moduleSpecifier &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return analyzeEntryImport(
      statement,
      resolveTarget(statement.moduleSpecifier.text),
      state,
    );
  }
  if (
    ts.isExportDeclaration(statement) &&
    statement.moduleSpecifier &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return analyzeEntryReexport(
      statement,
      resolveTarget(statement.moduleSpecifier.text),
      state,
    );
  }
  if (ts.isExportDeclaration(statement)) {
    return analyzeEntryLocalExport(statement, state);
  }
  return false;
}

function analyzeEntryImport(
  statement: ts.ImportDeclaration,
  targetFilePath: string,
  state: CollapsibleAnalysisState,
): boolean {
  if (!statement.importClause) {
    state.sideEffectImportFilePaths.add(targetFilePath);
    return true;
  }
  if (!setDirectTarget(state, targetFilePath)) {
    return false;
  }
  if (statement.importClause.name) {
    state.importedBindingNames.add(statement.importClause.name.text);
  }
  collectImportedBindingNames(
    statement.importClause.namedBindings,
    state.importedBindingNames,
  );
  return true;
}

function collectImportedBindingNames(
  namedBindings: ts.NamedImportBindings | undefined,
  importedBindingNames: Set<string>,
) {
  if (!namedBindings) {
    return;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    importedBindingNames.add(namedBindings.name.text);
    return;
  }
  for (const element of namedBindings.elements) {
    importedBindingNames.add(element.name.text);
  }
}

function analyzeEntryReexport(
  statement: ts.ExportDeclaration,
  targetFilePath: string,
  state: CollapsibleAnalysisState,
): boolean {
  const exportClause = statement.exportClause;
  if (exportClause && ts.isNamespaceExport(exportClause)) {
    return false;
  }
  if (
    exportClause &&
    ts.isNamedExports(exportClause) &&
    exportClause.elements.some(
      (element) =>
        element.propertyName && element.propertyName.text !== element.name.text,
    )
  ) {
    return false;
  }
  return setDirectTarget(state, targetFilePath);
}

function analyzeEntryLocalExport(
  statement: ts.ExportDeclaration,
  state: CollapsibleAnalysisState,
): boolean {
  if (
    !statement.exportClause ||
    !ts.isNamedExports(statement.exportClause) ||
    state.directTargetFilePath === null
  ) {
    return false;
  }
  for (const element of statement.exportClause.elements) {
    if (
      element.propertyName &&
      element.propertyName.text !== element.name.text
    ) {
      return false;
    }
    const localName = (element.propertyName ?? element.name).text;
    if (!state.importedBindingNames.has(localName)) {
      return false;
    }
  }
  return true;
}

function setDirectTarget(
  state: CollapsibleAnalysisState,
  nextTargetFilePath: string,
): boolean {
  if (
    state.directTargetFilePath !== null &&
    state.directTargetFilePath !== nextTargetFilePath
  ) {
    return false;
  }
  state.directTargetFilePath = nextTargetFilePath;
  return true;
}
