import ts from "@typescript/typescript6";

import { applyTextEdits } from "../shared/text-edits";
import { toMaterializedRelativePath } from "./capture";
import type { ExportDemand } from "./graph";
import type { CapturedModule } from "./internal-types";

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
    if (!record || !demand || demand.all) {
      continue;
    }

    const shakenCode = shakeModuleReexports(
      moduleId,
      record.code,
      demand.names,
    );
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
 * Restores the transform output every module was captured with.
 *
 * Shaking rewrites the record in place, and a watch rebuild re-runs `transform`
 * only for the modules that changed. Without this, the second build would shake
 * an already-shaken barrel and could never bring a name back.
 */
export function restoreCapturedModuleCode(
  capturedModules: Map<string, CapturedModule>,
) {
  for (const record of capturedModules.values()) {
    if (record.capturedCode === undefined) {
      continue;
    }
    record.code = record.capturedCode;
    delete record.capturedCode;
    delete record.rawAnalysis;
    delete record.normalizedAnalysis;
    delete record.normalizedCode;
  }
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
  return shaken;
}

function shakeModuleOnce(
  moduleId: string,
  code: string,
  demandedNames: ReadonlySet<string>,
  stranded: Set<string>,
) {
  const sourceFile = ts.createSourceFile(
    moduleId,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const edits: Array<{ end: number; start: number; text: string }> = [];
  const forwarded = collectForwardedBindings(sourceFile);
  const droppedBindings = new Set<ts.ImportSpecifier | ts.Identifier>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.exportClause
    ) {
      continue;
    }

    if (ts.isNamespaceExport(statement.exportClause)) {
      if (
        statement.moduleSpecifier &&
        !demandedNames.has(statement.exportClause.name.text)
      ) {
        edits.push({
          end: statement.getEnd(),
          start: statement.getStart(sourceFile),
          text: "",
        });
      }
      continue;
    }

    const elements = statement.exportClause.elements;
    const kept = elements.filter((element) =>
      demandedNames.has(element.name.text),
    );
    if (kept.length === elements.length) {
      continue;
    }
    // Vite rewrites `export { a } from "m"` into an import plus a local
    // `export { a }`, so the forwarding shape has to be shaken in both forms.
    for (const element of elements) {
      if (kept.includes(element)) {
        continue;
      }
      const localName = (element.propertyName ?? element.name).text;
      stranded.add(localName);
      const binding = forwarded.get(localName);
      if (binding) {
        droppedBindings.add(binding);
      }
    }
    edits.push(
      kept.length === 0
        ? {
            end: statement.getEnd(),
            start: statement.getStart(sourceFile),
            text: "",
          }
        : {
            end: statement.exportClause.getEnd(),
            start: statement.exportClause.getStart(sourceFile),
            text: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }`,
          },
    );
  }

  for (const [name, binding] of forwarded) {
    if (stranded.has(name)) {
      droppedBindings.add(binding);
    }
  }
  edits.push(...dropImportBindings(sourceFile, droppedBindings));
  edits.push(...dropUnreadFunctions(sourceFile, stranded, demandedNames));
  return edits.length === 0 ? code : applyTextEdits(code, edits);
}

/**
 * Top-level function declarations nothing can reach: either the module never
 * names them again after a shaken export, or they are exported under a name no
 * importer asks for. A function body runs nothing until it is called, so
 * removing one removes only the imports it was the last reader of - which is
 * the edge Rollup removed when it shook the same unused export. Declarations
 * that could run code on evaluation are left to Closure.
 */
function dropUnreadFunctions(
  sourceFile: ts.SourceFile,
  stranded: Set<string>,
  demandedNames: ReadonlySet<string>,
) {
  const exported = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        exported.add((element.propertyName ?? element.name).text);
      }
    }
  }

  const read = countIdentifierReads(sourceFile);
  return sourceFile.statements
    .filter(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name !== undefined &&
        !exported.has(statement.name.text) &&
        (isExportedDeclaration(statement)
          ? !isDefaultExportedDeclaration(statement) &&
            !demandedNames.has(statement.name.text)
          : stranded.has(statement.name.text)) &&
        (read.get(statement.name.text) ?? 0) === 0,
    )
    .map((statement) => {
      for (const name of countIdentifierReads(statement).keys()) {
        stranded.add(name);
      }
      return {
        end: statement.getEnd(),
        start: statement.getStart(sourceFile),
        text: "",
      };
    });
}

function isDefaultExportedDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
      true
  );
}

function isExportedDeclaration(statement: ts.Statement) {
  return (
    ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

/**
 * Import bindings this module only forwards: bound from another module and
 * never read in its own body, so dropping the export drops the whole edge.
 */
function collectForwardedBindings(sourceFile: ts.SourceFile) {
  const bindings = new Map<string, ts.ImportSpecifier | ts.Identifier>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }
    if (statement.importClause.name) {
      bindings.set(
        statement.importClause.name.text,
        statement.importClause.name,
      );
    }
    const namedBindings = statement.importClause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, element);
      }
    }
  }

  for (const name of countIdentifierReads(sourceFile).keys()) {
    bindings.delete(name);
  }
  return bindings;
}

/**
 * How often each name is read as a value. Import clauses, export clauses,
 * member names and a declaration's own name are bindings, not reads.
 */
function countIdentifierReads(root: ts.Node) {
  const read = new Map<string, number>();
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportSpecifier(node)) {
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    ) {
      ts.forEachChild(node, (child) => {
        if (child !== node.name) {
          visit(child);
        }
      });
      return;
    }
    if (ts.isIdentifier(node)) {
      read.set(node.text, (read.get(node.text) ?? 0) + 1);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return read;
}

/** One edit per import declaration, so removals never overlap. */
function dropImportBindings(
  sourceFile: ts.SourceFile,
  bindings: ReadonlySet<ts.ImportSpecifier | ts.Identifier>,
) {
  const byDeclaration = new Map<
    ts.ImportDeclaration,
    Set<ts.ImportSpecifier | ts.Identifier>
  >();
  for (const binding of bindings) {
    const declaration = ts.isImportSpecifier(binding)
      ? binding.parent.parent.parent
      : binding.parent.parent;
    if (!ts.isImportDeclaration(declaration)) {
      continue;
    }
    const existing = byDeclaration.get(declaration);
    if (existing) {
      existing.add(binding);
      continue;
    }
    byDeclaration.set(declaration, new Set([binding]));
  }

  const edits: Array<{ end: number; start: number; text: string }> = [];
  for (const [declaration, dropped] of byDeclaration) {
    const clause = declaration.importClause;
    if (!clause) {
      continue;
    }
    const namedBindings = clause.namedBindings;
    const keptNames =
      namedBindings && ts.isNamedImports(namedBindings)
        ? namedBindings.elements.filter((element) => !dropped.has(element))
        : [];
    const keptDefault =
      clause.name && !dropped.has(clause.name) ? clause.name : null;
    if (!keptDefault && keptNames.length === 0) {
      edits.push({
        end: declaration.getEnd(),
        start: declaration.getStart(sourceFile),
        text: "",
      });
      continue;
    }
    edits.push({
      end: clause.getEnd(),
      start: clause.getStart(sourceFile),
      text: [
        ...(keptDefault ? [keptDefault.getText(sourceFile)] : []),
        ...(keptNames.length > 0
          ? [
              `{ ${keptNames.map((element) => element.getText(sourceFile)).join(", ")} }`,
            ]
          : []),
      ].join(", "),
    });
  }
  return edits;
}
