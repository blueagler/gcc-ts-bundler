import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";
import { toRelativeImportSpecifier } from "../capture";
import type { MaterializedGraph } from "../internal-types";
import { createBarrelFlattener } from "./barrels";
import { normalizePath } from "./shared";

interface ResolvedBinding {
  imported: string;
  local: string;
  targetFilePath: string;
}

export async function rewriteDirectEsmImports(input: {
  directDependencyFilePaths: Set<string>;
  materialized: MaterializedGraph;
}) {
  const moduleByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      module,
    ]),
  );
  const flattener = createBarrelFlattener({
    moduleFilePaths: new Set(moduleByFilePath.keys()),
  });

  await Promise.all(
    input.materialized.modules
      .filter((module) => {
        const filePath = normalizePath(module.filePath);
        return (
          input.materialized.authoredFiles.includes(module.filePath) ||
          input.directDependencyFilePaths.has(filePath)
        );
      })
      .map(async (module) => {
        const sourceText = await fs.readFile(module.filePath, "utf8");
        const rewritten = await rewriteModuleImports({
          directDependencyFilePaths: input.directDependencyFilePaths,
          filePath: normalizePath(module.filePath),
          flattener,
          moduleByFilePath,
          sourceText,
        });
        if (rewritten !== sourceText) {
          await fs.writeFile(module.filePath, rewritten, "utf8");
        }
      }),
  );
}

async function rewriteModuleImports(input: {
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
    if (
      !targetModule ||
      targetModule.renderedLength !== 0 ||
      !input.directDependencyFilePaths.has(targetFilePath)
    ) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (statement.importClause.name) {
        continue;
      }
      const memberUses = collectNamespaceMemberUses(sourceFile, bindings.name);
      if (!memberUses || memberUses.size === 0) {
        continue;
      }
      const exportNames = [...memberUses.keys()].sort((left, right) =>
        left.localeCompare(right),
      );
      const resolvedBindings: ResolvedBinding[] = [];
      let unresolved = false;
      for (const exportName of exportNames) {
        const resolved = await input.flattener.resolveDeepExport(
          targetFilePath,
          exportName,
        );
        if (!resolved) {
          unresolved = true;
          break;
        }
        resolvedBindings.push({
          imported: resolved.imported,
          local: freshName(),
          targetFilePath: resolved.targetFilePath,
        });
      }
      if (unresolved) {
        continue;
      }
      const localByExport = new Map(
        resolvedBindings.map((binding, index) => [
          exportNames[index],
          binding.local,
        ]),
      );
      edits.push({
        end: statement.getEnd(),
        start: statement.getStart(sourceFile),
        text: renderResolvedImports(input.filePath, resolvedBindings),
      });
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
            start: use.getStart(sourceFile),
            text: local,
          });
        }
      }
      continue;
    }

    const requested: Array<{ imported: string; local: string }> = [];
    if (statement.importClause.name) {
      requested.push({
        imported: "default",
        local: statement.importClause.name.text,
      });
    }
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
      continue;
    }

    const resolvedBindings: ResolvedBinding[] = [];
    let unresolved = false;
    for (const requestedBinding of requested) {
      const resolved = await input.flattener.resolveDeepExport(
        targetFilePath,
        requestedBinding.imported,
      );
      if (!resolved) {
        unresolved = true;
        break;
      }
      resolvedBindings.push({
        imported: resolved.imported,
        local: requestedBinding.local,
        targetFilePath: resolved.targetFilePath,
      });
    }
    if (unresolved) {
      continue;
    }
    edits.push({
      end: statement.getEnd(),
      start: statement.getStart(sourceFile),
      text: renderResolvedImports(input.filePath, resolvedBindings),
    });
  }

  return edits.length === 0
    ? input.sourceText
    : applyTextEdits(input.sourceText, edits);
}

function collectNamespaceMemberUses(
  sourceFile: ts.SourceFile,
  namespaceBinding: ts.Identifier,
) {
  const uses = new Map<string, ts.PropertyAccessExpression[]>();
  let safe = true;
  const visit = (node: ts.Node) => {
    if (!safe) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === namespaceBinding.text) {
      if (node === namespaceBinding) {
        return;
      }
      const parent = node.parent;
      if (
        !parent ||
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== node ||
        parent.questionDotToken
      ) {
        safe = false;
        return;
      }
      const bucket = uses.get(parent.name.text);
      if (bucket) {
        bucket.push(parent);
      } else {
        uses.set(parent.name.text, [parent]);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return safe ? uses : null;
}

function renderResolvedImports(
  importerFilePath: string,
  bindings: ResolvedBinding[],
) {
  const bindingsByTarget = new Map<string, ResolvedBinding[]>();
  for (const binding of bindings) {
    const bucket = bindingsByTarget.get(binding.targetFilePath);
    if (bucket) {
      bucket.push(binding);
    } else {
      bindingsByTarget.set(binding.targetFilePath, [binding]);
    }
  }
  return [...bindingsByTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetFilePath, targetBindings]) => {
      const specifiers = targetBindings
        .sort((left, right) => left.local.localeCompare(right.local))
        .map(({ imported, local }) =>
          imported === local ? imported : `${imported} as ${local}`,
        );
      return `import { ${specifiers.join(", ")} } from ${JSON.stringify(
        toRelativeImportSpecifier(importerFilePath, targetFilePath),
      )};`;
    })
    .join("\n");
}
