import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";
import { stripQuery } from "../capture";
import { getCapturedSourceFile } from "../capture-analysis";
import type { PluginContext } from "../internal-types";

export interface ExportOrigin {
  moduleId: string;
  name: string;
}

interface ImporterBindingRewrite {
  code: string;
  importerId: string;
  originOf: (moduleId: string, name: string) => Promise<ExportOrigin>;
  resolve: (specifier: string, importerId: string) => Promise<string | null>;
  retainedModuleIds: ReadonlySet<string>;
}

interface RebindableBinding {
  imported: string;
  local: string;
}

interface ImportTextEdit {
  end: number;
  start: number;
  text: string;
}

export async function rewriteImporterBindings(
  this: PluginContext,
  input: ImporterBindingRewrite,
) {
  // Side-effect and named imports are the only statements this pass rewrites.
  // A file with no `import` token cannot have either, so skip the parse.
  if (!input.code.includes("import")) {
    return input.code;
  }
  const sourceFile = getCapturedSourceFile(input.importerId, input.code);
  const edits: ImportTextEdit[] = [];

  for (const statement of sourceFile.statements) {
    const edit = await rewriteImportStatement(sourceFile, statement, input);
    if (edit) {
      edits.push(edit);
    }
  }

  return edits.length === 0 ? input.code : applyTextEdits(input.code, edits);
}

async function rewriteImportStatement(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
  input: ImporterBindingRewrite,
): Promise<ImportTextEdit | null> {
  if (
    !ts.isImportDeclaration(statement) ||
    !ts.isStringLiteralLike(statement.moduleSpecifier)
  ) {
    return null;
  }
  const specifierText = statement.moduleSpecifier.text;
  const targetId = await input.resolve(specifierText, input.importerId);
  if (!targetId) {
    return null;
  }
  if (!statement.importClause) {
    return droppedSideEffectEdit(sourceFile, statement, targetId, input);
  }
  return rewriteNamedImportBindings(
    sourceFile,
    statement,
    specifierText,
    targetId,
    input,
  );
}

/**
 * Rollup keeps every module whose execution it cannot prove pointless, so a
 * module it dropped has no side effect left to run.
 */
function droppedSideEffectEdit(
  sourceFile: ts.SourceFile,
  statement: ts.ImportDeclaration,
  targetId: string,
  input: ImporterBindingRewrite,
): ImportTextEdit | null {
  if (input.retainedModuleIds.has(targetId)) {
    return null;
  }
  return {
    end: statement.getEnd(),
    start: statement.getStart(sourceFile),
    text: "",
  };
}

async function rewriteNamedImportBindings(
  sourceFile: ts.SourceFile,
  statement: ts.ImportDeclaration,
  specifierText: string,
  targetId: string,
  input: ImporterBindingRewrite,
): Promise<ImportTextEdit | null> {
  const bindings = readRebindableSpecifiers(statement);
  if (!bindings) {
    return null;
  }

  const grouped = new Map<string, string[]>();
  let changed = false;
  for (const binding of bindings) {
    const redirected = await redirectBinding(
      binding,
      specifierText,
      targetId,
      input,
    );
    grouped.set(redirected.specifier, [
      ...(grouped.get(redirected.specifier) ?? []),
      redirected.clause,
    ]);
    if (redirected.changed) {
      changed = true;
    }
  }
  if (!changed) {
    return null;
  }
  return {
    end: statement.getEnd(),
    start: statement.getStart(sourceFile),
    text: [...grouped.entries()]
      .map(
        ([specifier, names]) =>
          `import { ${names.join(", ")} } from ${JSON.stringify(specifier)};`,
      )
      .join("\n"),
  };
}

async function redirectBinding(
  binding: RebindableBinding,
  specifierText: string,
  targetId: string,
  input: ImporterBindingRewrite,
) {
  const origin = await input.originOf(targetId, binding.imported);
  const specifier =
    origin.moduleId === targetId
      ? null
      : toRelativeModuleSpecifier(input.importerId, origin.moduleId);
  if (specifier === null) {
    return {
      changed: false,
      clause: `${binding.imported} as ${binding.local}`,
      specifier: specifierText,
    };
  }
  return {
    changed: true,
    clause: `${origin.name} as ${binding.local}`,
    specifier,
  };
}

/**
 * The named bindings of a statement that can be re-pointed at another module.
 *
 * Namespace forms are excluded: they need the barrel's whole export object, so
 * there is no single module to re-point them at.
 */
function readRebindableSpecifiers(statement: ts.ImportDeclaration) {
  if (!statement.importClause || statement.importClause.isTypeOnly) {
    return null;
  }
  const names: RebindableBinding[] = [];
  if (statement.importClause.name) {
    names.push({
      imported: "default",
      local: statement.importClause.name.text,
    });
  }
  const namedBindings = statement.importClause.namedBindings;
  if (!namedBindings) {
    return names.length === 0 ? null : names;
  }
  const named = namedImportElements(namedBindings);
  if (!named) {
    return null;
  }
  names.push(...named);
  return names.length === 0 ? null : names;
}

function namedImportElements(namedBindings: ts.NamedImportBindings) {
  if (ts.isNamespaceImport(namedBindings)) {
    return null;
  }
  if (!ts.isNamedImports(namedBindings)) {
    return [];
  }
  const names: RebindableBinding[] = [];
  for (const element of namedBindings.elements) {
    if (element.isTypeOnly) {
      return null;
    }
    names.push({
      imported: (element.propertyName ?? element.name).text,
      local: element.name.text,
    });
  }
  return names;
}

/**
 * A specifier for `targetId` that resolves the same way from `importerId`.
 *
 * Only plain absolute files can be addressed relatively: virtual ids and query
 * variants have no path form, so imports through them keep their barrel.
 */
function toRelativeModuleSpecifier(importerId: string, targetId: string) {
  if (targetId !== stripQuery(targetId)) {
    return null;
  }
  const importerFile = stripQuery(importerId);
  if (!path.isAbsolute(importerFile) || !path.isAbsolute(targetId)) {
    return null;
  }
  const relative = path
    .relative(path.dirname(importerFile), targetId)
    .replace(/\\/g, "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}
