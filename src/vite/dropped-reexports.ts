import path from "node:path";

import ts from "@typescript/typescript6";

import { applyTextEdits } from "../shared/text-edits";
import { resolveCapturedSpecifier, stripQuery } from "./capture";
import type { CapturedModuleResolutionCache } from "./capture";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "./internal-types";

interface ModuleExportTable {
  local: Set<string>;
  named: Map<string, { imported: string; specifier: string }>;
  stars: string[];
}

interface ExportOrigin {
  moduleId: string;
  name: string;
}

/**
 * Rewrites imports that travel through a barrel Rollup erased so they name the
 * module that declares the value, exactly as Rollup's own binding resolution
 * did.
 *
 * `@ant-design/icons` re-exports ~800 icons from one file. Rollup shakes that
 * file out of existence and points each importer at the icon it uses; the
 * capture stores transform output, so our copy still routes every importer
 * through the barrel. One module then depends on modules Rollup spread over a
 * dozen chunks, and no chunk plan mirroring Rollup can order that: the barrel's
 * chunk has to precede every chunk holding an icon, and those chunks precede
 * the barrel's. Chasing the name through modules Rollup dropped removes exactly
 * the edges Rollup does not have, so the captured graph becomes a subgraph of
 * the graph Rollup chunked. Modules Rollup kept are never chased through, and
 * A module Rollup dropped is never assumed unreachable, only never assumed to
 * own a binding: Rollup also drops a module whose value it inlined, and the
 * capture still has the arithmetic that reads it. The shake in
 * `shaken-exports.ts` is what removes those readers, and the module then has no
 * importer left.
 */
export async function bypassDroppedReexports(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    materializedModuleIds: Iterable<string>;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    retainedModuleIds: ReadonlySet<string>;
  },
) {
  const tables = new Map<string, ModuleExportTable>();
  const tableOf = (moduleId: string) => {
    const existing = tables.get(moduleId);
    if (existing) {
      return existing;
    }
    const record = input.capturedModules.get(moduleId);
    const table = collectModuleExportTable(moduleId, record?.code ?? "");
    tables.set(moduleId, table);
    return table;
  };
  const resolve = async (specifier: string, importerId: string) => {
    const resolved = await resolveCapturedSpecifier.call(this, {
      importerId,
      metrics: input.metrics,
      resolutionCache: input.resolutionCache,
      specifier,
    });
    return resolved &&
      !resolved.external &&
      input.capturedModules.has(resolved.id)
      ? resolved.id
      : null;
  };

  const provides = async (moduleId: string, name: string, depth: number) => {
    if (depth > 8) {
      return false;
    }
    const table = tableOf(moduleId);
    if (table.local.has(name) || table.named.has(name)) {
      return true;
    }
    for (const specifier of table.stars) {
      const targetId = await resolve(specifier, moduleId);
      if (targetId && (await provides(targetId, name, depth + 1))) {
        return true;
      }
    }
    return false;
  };

  const origins = new Map<string, ExportOrigin>();
  const originOf = async (
    moduleId: string,
    name: string,
  ): Promise<ExportOrigin> => {
    const key = `${moduleId}\u0000${name}`;
    const cached = origins.get(key);
    if (cached) {
      return cached;
    }
    // A self-referential barrel chain would otherwise recurse forever.
    origins.set(key, { moduleId, name });

    let origin: ExportOrigin = { moduleId, name };
    for (let step = 0; step < 16; step += 1) {
      const table = tableOf(origin.moduleId);
      if (table.local.has(origin.name)) {
        break;
      }
      const named = table.named.get(origin.name);
      if (named) {
        const targetId = await resolve(named.specifier, origin.moduleId);
        if (!targetId) {
          break;
        }
        origin = { moduleId: targetId, name: named.imported };
        continue;
      }
      let next: ExportOrigin | null = null;
      for (const specifier of table.stars) {
        const targetId = await resolve(specifier, origin.moduleId);
        if (targetId && (await provides(targetId, origin.name, 0))) {
          next = { moduleId: targetId, name: origin.name };
          break;
        }
      }
      if (!next) {
        break;
      }
      origin = next;
    }
    origins.set(key, origin);
    return origin;
  };

  let rewrittenModuleCount = 0;
  for (const importerId of input.materializedModuleIds) {
    const record = input.capturedModules.get(importerId);
    if (!record) {
      continue;
    }
    const rewritten = await rewriteImporterBindings.call(this, {
      code: record.code,
      importerId,
      originOf,
      resolve,
      retainedModuleIds: input.retainedModuleIds,
    });
    if (rewritten === record.code) {
      continue;
    }
    record.capturedCode ??= record.code;
    record.code = rewritten;
    delete record.rawAnalysis;
    delete record.normalizedAnalysis;
    delete record.normalizedCode;
    rewrittenModuleCount += 1;
  }
  return rewrittenModuleCount;
}

async function rewriteImporterBindings(
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

function collectModuleExportTable(
  moduleId: string,
  code: string,
): ModuleExportTable {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const table: ModuleExportTable = {
    local: new Set<string>(),
    named: new Map<string, { imported: string; specifier: string }>(),
    stars: [],
  };
  // Vite's own transform rewrites `export { x } from "m"` into an import plus a
  // local `export { x }`, so a binding that came straight from another module
  // is the common shape of a barrel, not the exception.
  const importBindings = collectImportBindings(sourceFile);

  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const forwarded = ts.isIdentifier(statement.expression)
        ? importBindings.get(statement.expression.text)
        : undefined;
      if (forwarded) {
        table.named.set("default", forwarded);
      } else {
        table.local.add("default");
      }
      continue;
    }
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      if (isLocalExportDeclaration(statement)) {
        for (const name of readDeclaredExportNames(statement)) {
          table.local.add(name);
        }
      }
      continue;
    }

    const specifier =
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
    if (!statement.exportClause) {
      if (specifier !== null) {
        table.stars.push(specifier);
      }
      continue;
    }
    if (ts.isNamespaceExport(statement.exportClause)) {
      table.local.add(statement.exportClause.name.text);
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) {
        continue;
      }
      const localName = (element.propertyName ?? element.name).text;
      if (specifier === null) {
        const forwarded = importBindings.get(localName);
        if (forwarded) {
          table.named.set(element.name.text, forwarded);
        } else {
          table.local.add(element.name.text);
        }
        continue;
      }
      table.named.set(element.name.text, {
        imported: localName,
        specifier,
      });
    }
  }

  return table;
}

/**
 * Bindings a module took straight from another module, by local name. A
 * namespace binding is excluded: it is an object this module built, not a
 * value another module declares.
 */
function collectImportBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<string, { imported: string; specifier: string }>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (statement.importClause.name) {
      bindings.set(statement.importClause.name.text, {
        imported: "default",
        specifier,
      });
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        bindings.set(element.name.text, {
          imported: (element.propertyName ?? element.name).text,
          specifier,
        });
      }
    }
  }
  return bindings;
}

function isLocalExportDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function readDeclaredExportNames(statement: ts.Statement) {
  const names: string[] = [];
  const isDefault =
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
      true;
  if (isDefault) {
    names.push("default");
    return names;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        names.push(declaration.name.text);
      }
    }
    return names;
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  ) {
    names.push(statement.name.text);
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
