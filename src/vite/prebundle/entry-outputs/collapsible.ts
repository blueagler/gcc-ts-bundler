import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { normalizePath } from "../shared";

export interface CollapsibleBundleEntryOutput {
  directTargetFilePath: string;
  sideEffectImportFilePaths: string[];
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
  const sideEffectImportFilePaths = new Set<string>();
  const importedBindingNames = new Set<string>();
  let directTargetFilePath: string | null = null;

  const resolveTarget = (specifier: string) =>
    normalizePath(path.resolve(path.dirname(outputFilePath), specifier));

  const setDirectTarget = (nextTargetFilePath: string) => {
    if (
      directTargetFilePath !== null &&
      directTargetFilePath !== nextTargetFilePath
    ) {
      return false;
    }
    directTargetFilePath = nextTargetFilePath;
    return true;
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const targetFilePath = resolveTarget(statement.moduleSpecifier.text);
      if (!statement.importClause) {
        sideEffectImportFilePaths.add(targetFilePath);
        continue;
      }
      if (!setDirectTarget(targetFilePath)) {
        return null;
      }
      if (statement.importClause.name) {
        importedBindingNames.add(statement.importClause.name.text);
      }
      if (statement.importClause.namedBindings) {
        if (ts.isNamespaceImport(statement.importClause.namedBindings)) {
          importedBindingNames.add(
            statement.importClause.namedBindings.name.text,
          );
        } else {
          for (const element of statement.importClause.namedBindings.elements) {
            importedBindingNames.add(element.name.text);
          }
        }
      }
      continue;
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      if (
        statement.exportClause &&
        ts.isNamespaceExport(statement.exportClause)
      ) {
        return null;
      }
      if (
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.some(
          (element) =>
            element.propertyName &&
            element.propertyName.text !== element.name.text,
        )
      ) {
        return null;
      }
      if (!setDirectTarget(resolveTarget(statement.moduleSpecifier.text))) {
        return null;
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (
        !statement.exportClause ||
        !ts.isNamedExports(statement.exportClause) ||
        directTargetFilePath === null
      ) {
        return null;
      }
      for (const element of statement.exportClause.elements) {
        if (
          element.propertyName &&
          element.propertyName.text !== element.name.text
        ) {
          return null;
        }
        const localName = (element.propertyName ?? element.name).text;
        if (!importedBindingNames.has(localName)) {
          return null;
        }
      }
      continue;
    }

    return null;
  }

  if (directTargetFilePath === null) {
    return null;
  }

  sideEffectImportFilePaths.delete(directTargetFilePath);
  return {
    directTargetFilePath,
    sideEffectImportFilePaths: [...sideEffectImportFilePaths].sort(
      (left, right) => left.localeCompare(right),
    ),
  } satisfies CollapsibleBundleEntryOutput;
}
