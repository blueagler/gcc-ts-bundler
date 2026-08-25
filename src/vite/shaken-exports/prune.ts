import ts from "@typescript/typescript6";

import { applyTextEdits } from "../../shared/text-edits";
import { toMaterializedRelativePath } from "../capture";
import type { ExportDemand } from "../graph";
import type { CapturedModule } from "../internal-types";
import { shakeModuleOnce } from "./shake";

/**
 * Drops re-export specifiers no importer demands.
 *
 * The capture stores each module's transform output, which is what Vite handed
 * Rollup *before* Rollup shook it. Rollup then erases the re-exports nobody
 * reached, and a barrel that re-exports 800 icons for the 20 an app uses ends
 * up spread over the chunks that use them. Keeping all 800 edges makes our
 * module graph a strict superset of the graph Rollup chunked, so a chunk plan
 * mirroring Rollup's cannot be a DAG: the barrel's chunk must precede every
 * chunk an icon landed in, and those chunks precede the barrel's.
 *
 * The demand map is the same barrel-demand chain the retained walk already
 * computes, so the pruned text and the walk always agree. Only re-export
 * *edges* are removed: a side-effect `import "x"` is untouched, `export * from
 * "x"` has no name to test and stays, and no statement that declares code is
 * removed. This is not general dead-code emulation; Closure does that later.
 */
export function pruneShakenReexports(input: {
  capturedModules: Map<string, CapturedModule>;
  demand: Map<string, ExportDemand>;
  moduleIds: Iterable<string>;
  projectRoot: string;
}) {
  const demandByFile = collectDemandPerMaterializedFile(input);
  let prunedModuleCount = 0;
  for (const moduleId of input.moduleIds) {
    const record = input.capturedModules.get(moduleId);
    const demand = demandByFile.get(
      toMaterializedRelativePath(input.projectRoot, moduleId),
    );
    if (!record || !demand) {
      continue;
    }

    const shakenCode = demand.all
      ? dropUnreachableTails(moduleId, record.code)
      : shakeModuleReexports(moduleId, record.code, demand.names);
    if (shakenCode === record.code) {
      continue;
    }
    record.capturedCode ??= record.code;
    record.code = shakenCode;
    delete record.rawAnalysis;
    delete record.normalizedAnalysis;
    delete record.normalizedCode;
    prunedModuleCount += 1;
  }
  return prunedModuleCount;
}

/**
 * Demand keyed by the file each module materializes to, not by module id.
 *
 * Two store copies of one package - `stylis` under `@emotion/cache` and under
 * `@ant-design/cssinjs` - are two captured modules that materialize to the same
 * path, and the second write wins. Shaking them apart would make that write
 * depend on iteration order and drop a name the other copy's importer still
 * reads, so the file is shaken against the union of both copies' demand.
 */
function collectDemandPerMaterializedFile(input: {
  demand: Map<string, ExportDemand>;
  moduleIds: Iterable<string>;
  projectRoot: string;
}) {
  const demandByFile = new Map<string, ExportDemand>();
  for (const moduleId of input.moduleIds) {
    const demand = input.demand.get(moduleId);
    if (!demand) {
      continue;
    }
    const filePath = toMaterializedRelativePath(input.projectRoot, moduleId);
    const merged = demandByFile.get(filePath);
    if (!merged) {
      demandByFile.set(filePath, {
        all: demand.all,
        names: new Set(demand.names),
      });
      continue;
    }
    merged.all ||= demand.all;
    for (const name of demand.names) {
      merged.names.add(name);
    }
  }
  return demandByFile;
}

/**
 * Shaking one statement can strand the next one, so it runs to a fixpoint: an
 * export drops, the function it named loses its last reader, and the import
 * that function used loses its last reader in turn. That chain is what removes
 * the edge Rollup removed when it shook an unused export out of a module it
 * otherwise kept.
 */
function shakeModuleReexports(
  moduleId: string,
  code: string,
  demandedNames: ReadonlySet<string>,
) {
  let shaken = code;
  // Names this module has already lost. An import binding is only removed once
  // the shake itself stranded it, never because it merely looked unused: an
  // import Rollup kept may still be the only thing running a side effect.
  const stranded = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const next = shakeModuleOnce(moduleId, shaken, demandedNames, stranded);
    if (next === shaken) {
      break;
    }
    shaken = next;
  }
  return dropUnreachableTails(moduleId, shaken);
}

/** Drops a function tail that cannot run after an expressionless return. */
function dropUnreachableTails(moduleId: string, code: string) {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBlock(node) &&
      node.statements[0] &&
      ts.isReturnStatement(node.statements[0]) &&
      node.statements[0].expression === undefined &&
      node.statements[1]
    ) {
      edits.push({
        end: node.statements.at(-1)?.getEnd() ?? node.getEnd(),
        start: node.statements[1].getStart(sourceFile),
        text: "",
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edits.length === 0 ? code : applyTextEdits(code, edits);
}
