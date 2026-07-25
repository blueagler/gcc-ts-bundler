import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { normalizePath } from "./shared";
import type {
  ParsedDependencyImport,
  ParsedMaterializedModule,
} from "./shared";

/**
 * A cached parser over materialized runtime modules: exports, authored
 * imports, and dependency imports that may become region bundles.
 */
export function createModuleParser(input: {
  authoredFiles: Set<string>;
  moduleFilePaths: Set<string>;
}) {
  const parseCache = new Map<string, ParsedMaterializedModule>();

  return async function parseModule(
    filePath: string,
  ): Promise<ParsedMaterializedModule> {
    const normalizedFilePath = normalizePath(filePath);
    const cached = parseCache.get(normalizedFilePath);
    if (cached) {
      return cached;
    }

    const sourceText = await fs.readFile(normalizedFilePath, "utf8");
    const sourceFile = ts.createSourceFile(
      normalizedFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const staticAuthoredImports = new Set<string>();
    const dependencyImports: ParsedDependencyImport[] = [];
    const exportedNames = new Set<string>();
    let hasDefaultExport = false;

    const resolveRelativeTarget = (specifier: string) => {
      if (!specifier.startsWith(".")) {
        return null;
      }
      return normalizePath(
        path.resolve(path.dirname(normalizedFilePath), specifier),
      );
    };

    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        hasDefaultExport = true;
        exportedNames.add("default");
        continue;
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        ) &&
        statement.modifiers.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        hasDefaultExport = true;
        exportedNames.add("default");
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isVariableStatement(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              exportedNames.add(declaration.name.text);
            }
          }
        } else if (statement.name) {
          exportedNames.add(statement.name.text);
        }
      }

      if (
        ts.isImportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const targetFilePath = resolveRelativeTarget(
          statement.moduleSpecifier.text,
        );
        if (!targetFilePath) {
          continue;
        }
        if (input.authoredFiles.has(targetFilePath)) {
          staticAuthoredImports.add(targetFilePath);
          continue;
        }

        if (!input.moduleFilePaths.has(targetFilePath)) {
          continue;
        }

        const importClause = statement.importClause;
        const isSideEffectOnly = !importClause;
        let hasDefault = false;
        let hasNamespace = false;
        const namedExports = new Set<string>();

        if (importClause) {
          if (importClause.name) {
            hasDefault = true;
          }
          if (importClause.namedBindings) {
            if (ts.isNamespaceImport(importClause.namedBindings)) {
              hasNamespace = true;
            } else {
              for (const element of importClause.namedBindings.elements) {
                namedExports.add((element.propertyName ?? element.name).text);
              }
            }
          }
        }

        dependencyImports.push({
          hasDefault,
          hasNamespace,
          isSideEffectOnly,
          namedExports: [...namedExports].sort((left, right) =>
            left.localeCompare(right),
          ),
          node: statement,
          targetFilePath,
        });
        continue;
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const targetFilePath = resolveRelativeTarget(
          statement.moduleSpecifier.text,
        );
        if (!targetFilePath) {
          continue;
        }
        if (input.authoredFiles.has(targetFilePath)) {
          staticAuthoredImports.add(targetFilePath);
          continue;
        }
        if (!input.moduleFilePaths.has(targetFilePath)) {
          continue;
        }
        if (
          statement.exportClause &&
          ts.isNamespaceExport(statement.exportClause)
        ) {
          continue;
        }

        if (!statement.exportClause) {
          dependencyImports.push({
            hasDefault: false,
            hasNamespace: true,
            isSideEffectOnly: false,
            namedExports: [],
            node: statement,
            targetFilePath,
          });
          continue;
        }

        if (ts.isNamedExports(statement.exportClause)) {
          const namedExports = new Set<string>();
          for (const element of statement.exportClause.elements) {
            const exportedName = (element.propertyName ?? element.name).text;
            namedExports.add(exportedName);
            exportedNames.add(element.name.text);
          }
          if (namedExports.has("default")) {
            namedExports.delete("default");
            hasDefaultExport = true;
            exportedNames.add("default");
          }
          dependencyImports.push({
            hasDefault: false,
            hasNamespace: false,
            isSideEffectOnly: false,
            namedExports: [...namedExports].sort((left, right) =>
              left.localeCompare(right),
            ),
            node: statement,
            targetFilePath,
          });
        }
      }
    }

    const parsed = {
      dependencyImports,
      exportedNames: [...exportedNames].sort((left, right) =>
        left.localeCompare(right),
      ),
      hasDefaultExport,
      staticAuthoredImports: [...staticAuthoredImports].sort((left, right) =>
        left.localeCompare(right),
      ),
    } satisfies ParsedMaterializedModule;
    parseCache.set(normalizedFilePath, parsed);
    return parsed;
  };
}
