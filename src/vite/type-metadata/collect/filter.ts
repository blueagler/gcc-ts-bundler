import fs from "node:fs/promises";

import ts from "@typescript/typescript6";

import type {
  ClosureAnnotation,
  ClosureTypeMetadataFile,
} from "../../../build/transpile/type-metadata";
import type { ViteTypeMetadataDiagnostic } from "../types";

export async function filterDirectMetadata(
  file: ClosureTypeMetadataFile,
  diagnostics: ViteTypeMetadataDiagnostic[],
): Promise<ClosureTypeMetadataFile | null> {
  let runtimeText: string;
  try {
    runtimeText = await fs.readFile(file.filePath, "utf8");
  } catch {
    diagnostics.push({
      phase: "selection",
      reason: "source-file-unreadable",
      runtimeModuleId: file.runtimeModuleId,
      sourceFilePath: file.filePath,
    });
    return null;
  }
  const runtimeBindings = collectTopLevelRuntimeBindings(
    file.filePath,
    runtimeText,
  );
  const annotations = file.annotations.filter((annotation) =>
    annotationTargetExists(annotation, runtimeBindings),
  );
  const enums = file.enums.filter((item) =>
    runtimeBindings.has(item.bindingName),
  );
  if (
    annotations.length !== file.annotations.length ||
    enums.length !== file.enums.length
  ) {
    diagnostics.push({
      detail: `annotations=${file.annotations.length - annotations.length} enums=${file.enums.length - enums.length}`,
      phase: "selection",
      reason: "source-runtime-binding-mismatch",
      runtimeModuleId: file.runtimeModuleId,
      sourceFilePath: file.sourceFilePath,
    });
  }
  return {
    ...file,
    annotations,
    decoratedOutputText: undefined,
    enums,
    symbols: file.symbols.map((symbol) =>
      symbol.kind === "runtime" &&
      symbol.localName &&
      !runtimeBindings.has(symbol.localName)
        ? { ...symbol, localName: undefined }
        : symbol,
    ),
  };
}

function annotationTargetExists(
  annotation: ClosureAnnotation,
  runtimeBindings: ReadonlySet<string>,
) {
  return annotation.target.kind === "binding"
    ? runtimeBindings.has(annotation.target.bindingName)
    : runtimeBindings.has(annotation.target.ownerBindingName);
}

function collectTopLevelRuntimeBindings(filePath: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name) {
        names.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        names.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
}
