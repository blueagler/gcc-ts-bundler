import { resolveCapturedSpecifier } from "../capture";
import type { CapturedModuleResolutionCache } from "../capture";
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
