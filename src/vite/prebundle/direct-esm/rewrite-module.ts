import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../../shared/text-edits";
import type { MaterializedGraph } from "../../internal-types";
import type { createBarrelFlattener } from "../barrels";
import { normalizePath } from "../shared";
import {
  rewriteNamedImportStatement,
  rewriteNamespaceImportStatement,
} from "./rewrite-statement";

export async function rewriteModuleImports(input: {
  atomFilePaths: Set<string>;
  directDependencyFilePaths: Set<string>;
  filePath: string;
  flattener: ReturnType<typeof createBarrelFlattener>;
  moduleByFilePath: Map<string, MaterializedGraph["modules"][number]>;
  sourceText: string;
}) {
  const sourceFile = ts.createSourceFile(
    input.filePath,
    input.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const usedNames = new Set<string>();
  const collectNames = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      usedNames.add(node.text);
    }
    ts.forEachChild(node, collectNames);
  };
  collectNames(sourceFile);
  let freshOrdinal = 0;
  const freshName = () => {
    for (;;) {
      const candidate = `__gcc_dep_${freshOrdinal}`;
      freshOrdinal += 1;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
    }
  };

  const edits: Array<{ end: number; start: number; text: string }> = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".") ||
      statement.attributes
    ) {
      continue;
    }
    const targetFilePath = normalizePath(
      path.resolve(
        path.dirname(input.filePath),
        statement.moduleSpecifier.text,
      ),
    );
    const targetModule = input.moduleByFilePath.get(targetFilePath);
    // An atom target keeps its specifier; only a namespace binding has to
    // become fixed named bindings, because the bundled CommonJS core it points
    // at has no enumerable namespace for the native pipeline to rebuild.
    const isAtomTarget = input.atomFilePaths.has(targetFilePath);
    if (
      !targetModule ||
      (!isAtomTarget &&
        (targetModule.renderedLength !== 0 ||
          !input.directDependencyFilePaths.has(targetFilePath)))
    ) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      const namespaceEdits = await rewriteNamespaceImportStatement({
        filePath: input.filePath,
        flattener: input.flattener,
        freshName,
        isAtomTarget,
        moduleSpecifierText: statement.moduleSpecifier.text,
        sourceFile,
        statement,
        targetFilePath,
      });
      if (namespaceEdits) {
        edits.push(...namespaceEdits);
      }
      continue;
    }

    if (isAtomTarget) {
      // Named and default bindings survive the move to the atom entry as they
      // are; only the specifier changes, once the bundle output exists.
      continue;
    }

    const namedEdits = await rewriteNamedImportStatement({
      filePath: input.filePath,
      flattener: input.flattener,
      sourceFile,
      statement,
      targetFilePath,
    });
    if (namedEdits) {
      edits.push(...namedEdits);
    }
  }

  return edits.length === 0
    ? input.sourceText
    : applyTextEdits(input.sourceText, edits);
}
