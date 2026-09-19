import ts from "@typescript/typescript6";

import type { ImportedBinding } from "../../shared/typescript";
import {
  collectImportBindings,
  dynamicImportSpecifier,
} from "../../shared/typescript";
import {
  resolveCapturedSpecifier,
  type CapturedModuleResolutionCache,
} from "../capture";
import { getCapturedSourceFile } from "../capture-analysis";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

/**
 * The export names some importer still asks a module for.
 *
 * `all` means a namespace import, a dynamic import, a `require`, or an entry
 * point: the whole surface is live and nothing about it can be shaken.
 */
export interface ExportDemand {
  all: boolean;
  names: Set<string>;
}

/**
 * The fixpoint state every demand source below widens, plus the resolver that
 * turns a specifier into a captured module id.
 *
 * `resolve` is a closure rather than a plain function because it needs the
 * plugin context `collectExportDemand` was called on.
 */
interface DemandWalk {
  demands: Map<string, ExportDemand>;
  metrics: ViteBuildMetrics | undefined;
  pending: string[];
  resolve: (specifier: string, importerId: string) => Promise<string | null>;
}

/** What a single `import` statement asks of the module it names. */
interface ImportedDemand {
  all: boolean;
  names: Set<string>;
  specifier: string;
}

/**
 * Widen a module's demand and queue it for propagation when that actually
 * added something.
 *
 * The queue is what makes the walk a fixpoint: a re-export can only forward
 * demand it has already received, so a module has to be revisited every time
 * its own demand grows.
 */
function addDemand(
  walk: DemandWalk,
  moduleId: string,
  all: boolean,
  names: Iterable<string>,
) {
  const demand = walk.demands.get(moduleId) ?? {
    all: false,
    names: new Set<string>(),
  };
  const previousSize = demand.names.size;
  const previousAll = demand.all;
  demand.all ||= all;
  for (const name of names) demand.names.add(name);
  walk.demands.set(moduleId, demand);
  if (demand.all !== previousAll || demand.names.size !== previousSize) {
    walk.pending.push(moduleId);
  }
}

/**
 * Every specifier reached through a form that names nothing it reads: a
 * dynamic `import()` or a `require()`.
 */
function collectOpaqueImportSpecifiers(sourceFile: ts.SourceFile) {
  const specifiers = new Set<string>();
  const visitOpaqueImports = (node: ts.Node) => {
    const imported = dynamicImportSpecifier(node);
    if (imported !== null) {
      specifiers.add(imported);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visitOpaqueImports);
  };
  visitOpaqueImports(sourceFile);
  return specifiers;
}

/**
 * An opaque import reads a module through a runtime string, so nothing about
 * the target can be shaken: mark the whole surface live.
 */
async function seedOpaqueImportDemand(
  walk: DemandWalk,
  sourceFile: ts.SourceFile,
  importerId: string,
) {
  for (const specifier of collectOpaqueImportSpecifiers(sourceFile)) {
    const targetId = await walk.resolve(specifier, importerId);
    if (targetId) addDemand(walk, targetId, true, []);
  }
}

/**
 * What one import clause reads: `default` for a default binding, the imported
 * spelling of each value-named binding, and everything for a namespace import,
 * whose object names nothing it reads.
 *
 * `default` is added before the named bindings so a clause carrying both hands
 * the same insertion order to `addDemand` as before this classification moved
 * out of `describeImportDemand`.
 */
function describeImportClauseDemand(importClause: ts.ImportClause) {
  const names = new Set<string>();
  if (importClause.name) names.add("default");
  const bindings = importClause.namedBindings;
  if (!bindings) return { all: false, names };
  if (ts.isNamespaceImport(bindings)) return { all: true, names };
  for (const element of bindings.elements) {
    if (!element.isTypeOnly) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return { all: false, names };
}

/**
 * The demand one `import` statement places on its target.
 *
 * Type-only imports and bare side-effect imports name nothing that survives to
 * runtime, so they place no demand at all.
 */
function describeImportDemand(statement: ts.Statement): ImportedDemand | null {
  if (!ts.isImportDeclaration(statement)) return null;
  const importClause = statement.importClause;
  if (!importClause || importClause.isTypeOnly) return null;
  if (!ts.isStringLiteralLike(statement.moduleSpecifier)) return null;
  const clause = describeImportClauseDemand(importClause);
  return {
    all: clause.all,
    names: clause.names,
    specifier: statement.moduleSpecifier.text,
  };
}

/** The named, default and namespace imports written in one importer. */
async function seedStaticImportDemand(
  walk: DemandWalk,
  sourceFile: ts.SourceFile,
  importerId: string,
) {
  for (const statement of sourceFile.statements) {
    const imported = describeImportDemand(statement);
    if (!imported) continue;
    const targetId = await walk.resolve(imported.specifier, importerId);
    if (!targetId) continue;
    addDemand(walk, targetId, imported.all, imported.names);
  }
}

/**
 * The imported binding a local `export { a as b }` forwards, if that export is
 * demanded and `a` was imported. Returns nothing for type-only exports, names
 * nobody asked for, and locals that were not imported — those three skips used
 * to sit in `forwardLocalReexportDemand` before the `await resolve`.
 */
function demandedLocalReexportBinding(
  element: ts.ExportSpecifier,
  demand: ExportDemand,
  importBindings: Map<string, ImportedBinding>,
) {
  if (element.isTypeOnly) return undefined;
  if (!demand.all && !demand.names.has(element.name.text)) return undefined;
  return importBindings.get((element.propertyName ?? element.name).text);
}

/**
 * Forward the demand a local `export { a as b }` received to the module `a`
 * was imported from, under the name that module exports it as.
 */
async function forwardLocalReexportDemand(
  walk: DemandWalk,
  input: {
    demand: ExportDemand;
    exportClause: ts.NamedExports;
    importBindings: Map<string, ImportedBinding>;
    moduleId: string;
  },
) {
  for (const element of input.exportClause.elements) {
    const forwarded = demandedLocalReexportBinding(
      element,
      input.demand,
      input.importBindings,
    );
    if (!forwarded) continue;
    const forwardedId = await walk.resolve(forwarded.specifier, input.moduleId);
    if (forwardedId) {
      addDemand(walk, forwardedId, false, [forwarded.imported]);
    }
  }
}

/**
 * `export * from "m"` forwards every demanded name except `default`, which
 * star re-exports never re-export. Insertion order matches `demand.names`.
 */
function computeStarReexportDemand(demand: ExportDemand) {
  const names = new Set<string>();
  for (const name of demand.names) {
    if (name !== "default") names.add(name);
  }
  return { all: demand.all, names };
}

/**
 * `export { a as b } from "m"` forwards only names someone asked for, spelled
 * the way `m` exports them. Type-only specifiers place no runtime demand.
 */
function computeNamedReexportDemand(
  exportClause: ts.NamedExports,
  demand: ExportDemand,
) {
  const names = new Set<string>();
  for (const element of exportClause.elements) {
    if (element.isTypeOnly) continue;
    if (demand.all || demand.names.has(element.name.text)) {
      names.add((element.propertyName ?? element.name).text);
    }
  }
  return { all: false, names };
}

/**
 * The demand `export ... from "m"` passes on to `m`.
 *
 * A namespace re-export makes the whole target live as soon as its own name is
 * demanded, because the namespace object names nothing it reads.
 */
function computeReexportedDemand(
  exportClause: ts.ExportDeclaration["exportClause"],
  demand: ExportDemand,
) {
  if (!exportClause) return computeStarReexportDemand(demand);
  if (ts.isNamespaceExport(exportClause)) {
    return {
      all: demand.all || demand.names.has(exportClause.name.text),
      names: new Set<string>(),
    };
  }
  return computeNamedReexportDemand(exportClause, demand);
}

/** Forward the demand one `export ... from` statement received to its target. */
async function forwardModuleReexportDemand(
  walk: DemandWalk,
  input: {
    demand: ExportDemand;
    exportClause: ts.ExportDeclaration["exportClause"];
    moduleId: string;
    specifier: string;
  },
) {
  const targetId = await walk.resolve(input.specifier, input.moduleId);
  if (!targetId) return;
  const forwarded = computeReexportedDemand(input.exportClause, input.demand);
  if (!forwarded.all && forwarded.names.size === 0) return;
  addDemand(walk, targetId, forwarded.all, forwarded.names);
}

/**
 * The work one `export` statement does, or nothing for type-only and
 * non-literal specifiers. Returning `undefined` (instead of an async no-op)
 * keeps `propagateModuleDemand` from `await`ing skips the original loop
 * `continue`d past.
 */
function propagateExportStatementDemand(
  walk: DemandWalk,
  input: {
    demand: ExportDemand;
    importBindings: Map<string, ImportedBinding>;
    moduleId: string;
    statement: ts.ExportDeclaration;
  },
) {
  if (input.statement.isTypeOnly) return;
  if (!input.statement.moduleSpecifier) {
    if (
      input.statement.exportClause &&
      ts.isNamedExports(input.statement.exportClause)
    ) {
      return forwardLocalReexportDemand(walk, {
        demand: input.demand,
        exportClause: input.statement.exportClause,
        importBindings: input.importBindings,
        moduleId: input.moduleId,
      });
    }
    return;
  }
  if (!ts.isStringLiteralLike(input.statement.moduleSpecifier)) return;
  return forwardModuleReexportDemand(walk, {
    demand: input.demand,
    exportClause: input.statement.exportClause,
    moduleId: input.moduleId,
    specifier: input.statement.moduleSpecifier.text,
  });
}

/**
 * Push the demand one module has received through its re-export statements.
 *
 * Runs once per queue entry, so a module whose demand grew re-walks the same
 * statements and hands the wider demand further down the chain. Statement
 * order is the source order; each `await` is only the original
 * `forwardLocal` / `forwardModule` call.
 */
async function propagateModuleDemand(
  walk: DemandWalk,
  moduleId: string,
  demand: ExportDemand,
  sourceFile: ts.SourceFile,
) {
  const importBindings = collectImportBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const work = propagateExportStatementDemand(walk, {
      demand,
      importBindings,
      moduleId,
      statement,
    });
    if (work) await work;
  }
}

/**
 * The captured module a specifier names, or `null` when resolution missed,
 * landed on an external, or named a module the capture does not hold.
 *
 * Shared with `dropped-reexports`: both walks treat only captured, non-external
 * ids as demand/origin targets.
 */
export async function resolveCapturedModuleId(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    importerId: string;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    specifier: string;
  },
) {
  const resolved = await resolveCapturedSpecifier.call(this, {
    importerId: input.importerId,
    metrics: input.metrics,
    resolutionCache: input.resolutionCache,
    specifier: input.specifier,
  });
  return resolved &&
    !resolved.external &&
    input.capturedModules.has(resolved.id)
    ? resolved.id
    : null;
}

/**
 * Demand placed by every materialized importer's opaque and static imports.
 * Importer order and the opaque-then-static await pair per importer are the
 * seed order the LIFO drain later observes.
 */
async function seedMaterializedImportDemand(
  walk: DemandWalk,
  capturedModules: Map<string, CapturedModule>,
  materializedModuleIds: Iterable<string>,
) {
  for (const importerId of materializedModuleIds) {
    const record = capturedModules.get(importerId);
    if (!record) continue;
    const sourceFile = getCapturedSourceFile(record, record.code, walk.metrics);
    await seedOpaqueImportDemand(walk, sourceFile, importerId);
    await seedStaticImportDemand(walk, sourceFile, importerId);
  }
}

/**
 * Drain pending modules last-in-first-out. `addDemand` pushes when a module's
 * demand grows; `pop` is what makes a later widening of an earlier module run
 * before leftover work. Termination is the same as before: a module leaves
 * the queue until a later `addDemand` pushes it again.
 */
async function drainDemandWorklist(
  walk: DemandWalk,
  capturedModules: Map<string, CapturedModule>,
) {
  while (walk.pending.length > 0) {
    const moduleId = walk.pending.pop();
    if (!moduleId) continue;
    const demand = walk.demands.get(moduleId);
    const record = capturedModules.get(moduleId);
    if (!demand || !record) continue;
    await propagateModuleDemand(
      walk,
      moduleId,
      demand,
      getCapturedSourceFile(record, record.code, walk.metrics),
    );
  }
}

/**
 * Which export names each module still has to provide, as a fixpoint over the
 * re-export chains.
 *
 * A named import demands names; a namespace import, a dynamic import, a
 * `require` and an entry point demand everything, because none of them names
 * what it reads. `export ... from` forwards the demand it received, which is
 * what walks the demand through a chain of barrels down to the module that
 * declares the value.
 */
export async function collectExportDemand(
  this: PluginContext,
  input: {
    capturedModules: Map<string, CapturedModule>;
    materializedModuleIds: Set<string>;
    metrics: ViteBuildMetrics | undefined;
    resolutionCache: CapturedModuleResolutionCache;
    unshakenModuleIds: readonly string[];
  },
) {
  const walk: DemandWalk = {
    demands: new Map(),
    metrics: input.metrics,
    pending: [],
    resolve: (specifier, importerId) =>
      resolveCapturedModuleId.call(this, {
        capturedModules: input.capturedModules,
        importerId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
        specifier,
      }),
  };

  for (const moduleId of input.unshakenModuleIds) {
    addDemand(walk, moduleId, true, []);
  }
  await seedMaterializedImportDemand(
    walk,
    input.capturedModules,
    input.materializedModuleIds,
  );
  await drainDemandWorklist(walk, input.capturedModules);
  return walk.demands;
}
