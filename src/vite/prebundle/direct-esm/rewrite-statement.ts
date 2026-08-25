import ts from "@typescript/typescript6";

import { type ResolvedBinding, renderResolvedImports } from "./bindings";
import { collectNamespaceMemberUses } from "./namespace";

type TextEdit = { end: number; start: number; text: string };

interface DeepExportResolver {
  resolveDeepExport(
    targetFilePath: string,
    exportName: string,
  ): Promise<{ imported: string; targetFilePath: string } | null>;
}

export async function rewriteNamespaceImportStatement(input: {
  filePath: string;
  flattener: DeepExportResolver;
  freshName: () => string;
  isAtomTarget: boolean;
  moduleSpecifierText: string;
  sourceFile: ts.SourceFile;
  statement: ts.ImportDeclaration;
  targetFilePath: string;
}) {
  const bindings = input.statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamespaceImport(bindings)) {
    return null;
  }
  if (input.statement.importClause?.name) {
    return null;
  }
  const memberUses = collectNamespaceMemberUses(
    input.sourceFile,
    bindings.name,
  );
  if (!memberUses) {
    return null;
  }
  if (memberUses.size === 0) {
    if (!input.isAtomTarget) {
      return [];
    }
    return [
      {
        end: input.statement.getEnd(),
        start: input.statement.getStart(input.sourceFile),
        text: `import ${JSON.stringify(input.moduleSpecifierText)};`,
      },
    ];
  }
  const exportNames = [...memberUses.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const resolvedBindings: ResolvedBinding[] = [];
  for (const exportName of exportNames) {
    const resolved = input.isAtomTarget
      ? { imported: exportName, targetFilePath: input.targetFilePath }
      : await input.flattener.resolveDeepExport(
          input.targetFilePath,
          exportName,
        );
    if (!resolved) {
      return null;
    }
    resolvedBindings.push({
      imported: resolved.imported,
      local: input.freshName(),
      targetFilePath: resolved.targetFilePath,
    });
  }
  const localByExport = new Map(
    resolvedBindings.map((binding, index) => [
      exportNames[index],
      binding.local,
    ]),
  );
  const edits: TextEdit[] = [
    {
      end: input.statement.getEnd(),
      start: input.statement.getStart(input.sourceFile),
      text: renderResolvedImports(input.filePath, resolvedBindings),
    },
  ];
  for (const [exportName, uses] of memberUses) {
    const local = localByExport.get(exportName);
    if (!local) {
      throw new Error(
        `Missing resolved direct-ESM binding for ${exportName} in ${input.filePath}.`,
      );
    }
    for (const use of uses) {
      edits.push({
        end: use.getEnd(),
        start: use.getStart(input.sourceFile),
        text: local,
      });
    }
  }
  return edits;
}

export async function rewriteNamedImportStatement(input: {
  filePath: string;
  flattener: DeepExportResolver;
  sourceFile: ts.SourceFile;
  statement: ts.ImportDeclaration;
  targetFilePath: string;
}) {
  const requested: Array<{ imported: string; local: string }> = [];
  if (input.statement.importClause?.name) {
    requested.push({
      imported: "default",
      local: input.statement.importClause.name.text,
    });
  }
  const bindings = input.statement.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const specifier of bindings.elements) {
      if (specifier.isTypeOnly) {
        continue;
      }
      requested.push({
        imported: (specifier.propertyName ?? specifier.name).text,
        local: specifier.name.text,
      });
    }
  }
  if (requested.length === 0) {
    return [];
  }

  const resolvedBindings: ResolvedBinding[] = [];
  for (const requestedBinding of requested) {
    const resolved = await input.flattener.resolveDeepExport(
      input.targetFilePath,
      requestedBinding.imported,
    );
    if (!resolved) {
      return null;
    }
    resolvedBindings.push({
      imported: resolved.imported,
      local: requestedBinding.local,
      targetFilePath: resolved.targetFilePath,
    });
  }
  return [
    {
      end: input.statement.getEnd(),
      start: input.statement.getStart(input.sourceFile),
      text: renderResolvedImports(input.filePath, resolvedBindings),
    },
  ];
}
