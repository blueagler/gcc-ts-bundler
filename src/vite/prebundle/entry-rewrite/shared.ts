import ts from "@typescript/typescript6";

import { toRelativeImportSpecifier } from "../../capture";
import type { CollapsibleBundleEntryOutput } from "../entry-outputs";

export function renderCollapsedBundleImportStatement(input: {
  importerFilePath: string;
  sourceFile: ts.SourceFile;
  statement: ts.ImportDeclaration | ts.ExportDeclaration;
  wrapperOutput: CollapsibleBundleEntryOutput;
}) {
  const moduleSpecifier = input.statement.moduleSpecifier;
  if (!moduleSpecifier) {
    return input.sourceFile.text.slice(
      input.statement.getStart(input.sourceFile),
      input.statement.getEnd(),
    );
  }
  const statementStart = input.statement.getStart(input.sourceFile);
  const statementText = input.sourceFile.text.slice(
    statementStart,
    input.statement.getEnd(),
  );
  const directSpecifierText = toRelativeImportSpecifier(
    input.importerFilePath,
    input.wrapperOutput.directTargetFilePath,
  );
  const specifierStart =
    moduleSpecifier.getStart(input.sourceFile) - statementStart + 1;
  const specifierEnd = moduleSpecifier.getEnd() - statementStart - 1;
  const rewrittenStatementText =
    statementText.slice(0, specifierStart) +
    directSpecifierText +
    statementText.slice(specifierEnd);
  const sideEffectImports = input.wrapperOutput.sideEffectImportFilePaths.map(
    (filePath) =>
      `import ${JSON.stringify(
        toRelativeImportSpecifier(input.importerFilePath, filePath),
      )};`,
  );
  return [...sideEffectImports, rewrittenStatementText].join("\n");
}

export function dedupeAuthoredImportStatements(
  filePath: string,
  sourceText: string,
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const seenBoundImports = new Set<string>();
  const seenSideEffectImports = new Set<string>();
  const moduleSpecifiersWithBoundImports = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }
    moduleSpecifiersWithBoundImports.add(statement.moduleSpecifier.text);
  }

  const deletions: Array<{ start: number; end: number }> = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleSpecifier = statement.moduleSpecifier.text;
    const statementText = sourceFile.text.slice(
      statement.getStart(sourceFile),
      statement.getEnd(),
    );
    if (!statement.importClause) {
      if (
        moduleSpecifiersWithBoundImports.has(moduleSpecifier) ||
        seenSideEffectImports.has(moduleSpecifier)
      ) {
        deletions.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
        });
        continue;
      }
      seenSideEffectImports.add(moduleSpecifier);
      continue;
    }
    const boundImportKey = `${moduleSpecifier}\u0000${statementText}`;
    if (seenBoundImports.has(boundImportKey)) {
      deletions.push({
        end: statement.getEnd(),
        start: statement.getStart(sourceFile),
      });
      continue;
    }
    seenBoundImports.add(boundImportKey);
  }

  let rewritten = sourceText;
  for (const deletion of deletions.sort(
    (left, right) => right.start - left.start,
  )) {
    rewritten =
      rewritten.slice(0, deletion.start) + rewritten.slice(deletion.end);
  }
  return rewritten;
}
