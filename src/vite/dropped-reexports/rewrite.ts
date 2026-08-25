import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";
import { stripQuery } from "../capture";
import type { PluginContext } from "../internal-types";

export interface ExportOrigin {
  moduleId: string;
  name: string;
}

export async function rewriteImporterBindings(
  this: PluginContext,
  input: {
    code: string;
    importerId: string;
    originOf: (moduleId: string, name: string) => Promise<ExportOrigin>;
    resolve: (specifier: string, importerId: string) => Promise<string | null>;
    retainedModuleIds: ReadonlySet<string>;
  },
) {
  const sourceFile = ts.createSourceFile(
    input.importerId,
    input.code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifierText = statement.moduleSpecifier.text;
    const targetId = await input.resolve(specifierText, input.importerId);
    if (!targetId) {
      continue;
    }
    const targetIsDropped = !input.retainedModuleIds.has(targetId);

    // Rollup keeps every module whose execution it cannot prove pointless, so
    // a module it dropped has no side effect left to run.
    if (!statement.importClause) {
      if (targetIsDropped) {
        edits.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
          text: "",
        });
      }
      continue;
    }

    const bindings = readRebindableSpecifiers(statement);
    if (!bindings) {
      continue;
    }

    const grouped = new Map<string, string[]>();
    let changed = false;
    for (const binding of bindings) {
      const origin = await input.originOf(targetId, binding.imported);
      const specifier =
        origin.moduleId === targetId
          ? null
          : toRelativeModuleSpecifier(input.importerId, origin.moduleId);
      if (specifier === null) {
        grouped.set(specifierText, [
          ...(grouped.get(specifierText) ?? []),
          `${binding.imported} as ${binding.local}`,
        ]);
        continue;
      }
      changed = true;
      grouped.set(specifier, [
        ...(grouped.get(specifier) ?? []),
        `${origin.name} as ${binding.local}`,
      ]);
    }
    if (!changed) {
      continue;
    }
    edits.push({
      end: statement.getEnd(),
      start: statement.getStart(sourceFile),
      text: [...grouped.entries()]
        .map(
          ([specifier, names]) =>
            `import { ${names.join(", ")} } from ${JSON.stringify(specifier)};`,
        )
        .join("\n"),
    });
  }

  return edits.length === 0 ? input.code : applyTextEdits(input.code, edits);
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
  const names: Array<{ imported: string; local: string }> = [];
  if (statement.importClause.name) {
    names.push({
      imported: "default",
      local: statement.importClause.name.text,
    });
  }
  const namedBindings = statement.importClause.namedBindings;
  if (namedBindings && ts.isNamespaceImport(namedBindings)) {
    return null;
  }
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      if (element.isTypeOnly) {
        return null;
      }
      names.push({
        imported: (element.propertyName ?? element.name).text,
        local: element.name.text,
      });
    }
  }
  return names.length === 0 ? null : names;
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
