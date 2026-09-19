import type { CapturedModuleResolutionCache } from "../capture";
import { resolveCapturedModuleId } from "../graph/demand";
import { rewriteImporterBindings } from "./rewrite";
import type { ExportOrigin } from "./rewrite";
import { collectModuleExportTable } from "./table";
import type { ModuleExportTable } from "./table";
import type {
  CapturedModule,
  PluginContext,
  ViteBuildMetrics,
} from "../internal-types";

/**
 * Shared resolution state for one `bypassDroppedReexports` pass. Tables and
 * origin memos are filled on demand and must not outlive the pass.
 */
interface ReexportChase {
  capturedModules: Map<string, CapturedModule>;
  metrics: ViteBuildMetrics | undefined;
  origins: Map<string, ExportOrigin>;
  resolve: (specifier: string, importerId: string) => Promise<string | null>;
  tables: Map<string, ModuleExportTable>;
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
  const chase: ReexportChase = {
    capturedModules: input.capturedModules,
    metrics: input.metrics,
    origins: new Map<string, ExportOrigin>(),
    resolve: (specifier, importerId) =>
      resolveCapturedModuleId.call(this, {
        capturedModules: input.capturedModules,
        importerId,
        metrics: input.metrics,
        resolutionCache: input.resolutionCache,
        specifier,
      }),
    tables: new Map<string, ModuleExportTable>(),
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
      metrics: input.metrics,
      originOf: (moduleId, name) => originOf(chase, moduleId, name),
      record,
      resolve: chase.resolve,
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

function exportTableOf(chase: ReexportChase, moduleId: string) {
  const existing = chase.tables.get(moduleId);
  if (existing) {
    return existing;
  }
  const record = chase.capturedModules.get(moduleId) ?? {
    code: "",
    id: moduleId,
  };
  const table = collectModuleExportTable(record, chase.metrics);
  chase.tables.set(moduleId, table);
  return table;
}

async function moduleProvidesExport(
  chase: ReexportChase,
  moduleId: string,
  name: string,
  depth: number,
) {
  if (depth > 8) {
    return false;
  }
  const table = exportTableOf(chase, moduleId);
  if (table.local.has(name) || table.named.has(name)) {
    return true;
  }
  for (const specifier of table.stars) {
    const targetId = await chase.resolve(specifier, moduleId);
    if (
      targetId &&
      (await moduleProvidesExport(chase, targetId, name, depth + 1))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The module that owns `name` after chasing named and star re-exports through
 * dropped barrels. First result for `${moduleId}\0${name}` is memoized, and a
 * self-entry is stored before the walk so a cycle cannot recurse forever.
 *
 * Precedence at each hop, unchanged:
 * 1. `table.local` owns the name → stop.
 * 2. `table.named` has the name → hop to that specifier's target (or stop if
 *    it does not resolve). Named beats every star.
 * 3. Else the first `table.stars` entry, in array order, whose target
 *    resolves and `moduleProvidesExport`s the name.
 * At most 16 hops.
 */
async function originOf(
  chase: ReexportChase,
  moduleId: string,
  name: string,
): Promise<ExportOrigin> {
  const key = `${moduleId}\u0000${name}`;
  const cached = chase.origins.get(key);
  if (cached) {
    return cached;
  }
  // A self-referential barrel chain would otherwise recurse forever.
  chase.origins.set(key, { moduleId, name });

  let origin: ExportOrigin = { moduleId, name };
  for (let step = 0; step < 16; step += 1) {
    const next = await nextReexportOrigin(chase, origin);
    if (!next) {
      break;
    }
    origin = next;
  }
  chase.origins.set(key, origin);
  return origin;
}

async function nextReexportOrigin(
  chase: ReexportChase,
  origin: ExportOrigin,
): Promise<ExportOrigin | null> {
  const table = exportTableOf(chase, origin.moduleId);
  if (table.local.has(origin.name)) {
    return null;
  }
  const named = table.named.get(origin.name);
  if (named) {
    return hopNamedReexport(
      chase,
      origin.moduleId,
      named.specifier,
      named.imported,
    );
  }
  return hopStarReexport(chase, origin, table.stars);
}

async function hopNamedReexport(
  chase: ReexportChase,
  moduleId: string,
  specifier: string,
  imported: string,
): Promise<ExportOrigin | null> {
  const targetId = await chase.resolve(specifier, moduleId);
  if (!targetId) {
    return null;
  }
  return { moduleId: targetId, name: imported };
}

async function hopStarReexport(
  chase: ReexportChase,
  origin: ExportOrigin,
  stars: readonly string[],
): Promise<ExportOrigin | null> {
  for (const specifier of stars) {
    const targetId = await chase.resolve(specifier, origin.moduleId);
    if (
      targetId &&
      (await moduleProvidesExport(chase, targetId, origin.name, 0))
    ) {
      return { moduleId: targetId, name: origin.name };
    }
  }
  return null;
}
