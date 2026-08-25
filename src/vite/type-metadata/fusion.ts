import path from "node:path";

import ts from "@typescript/typescript6";

import { countTypeMetadata } from "../../build/transpile/type-metadata";
import type {
  ClosureAnnotation,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
  ClosureTypeSymbol,
  TypeMetadataTarget,
} from "../../build/transpile/type-metadata";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import type {
  DeclarationExportFact,
  JoinedExportTypeFact,
  ViteTypeMetadataDiagnostic,
  ViteTypeMetadataSidecar,
} from "./types";

export interface OverlayAttachmentPlan {
  declaration: DeclarationExportFact;
  outputBindingName: string;
  target: TypeMetadataTarget;
}

export function materializeJoinedExports(input: {
  diagnostics: ViteTypeMetadataDiagnostic[];
  facts: JoinedExportTypeFact[];
  materialized: MaterializedGraph;
  publicRuntimeModuleId: string;
}) {
  const plans: OverlayAttachmentPlan[] = [];
  const oneToOneBySourceId = new Map<string, CapturedRuntimeModule>();
  for (const module of input.materialized.modules) {
    const sourceModuleId = oneToOneSourceModuleId(module);
    if (sourceModuleId) {
      oneToOneBySourceId.set(sourceModuleId, module);
    }
  }

  for (const fact of input.facts) {
    const directModule = oneToOneBySourceId.get(fact.runtime.moduleId);
    const outputBindingName =
      fact.runtime.kind === "cjs" &&
      (fact.exportName === "default" || fact.exportName === "__cjsExports")
        ? "__cjsExports"
        : fact.runtime.localName;
    if (directModule && outputBindingName) {
      plans.push({
        declaration: fact.declaration,
        outputBindingName,
        target: {
          emitFilePath: directModule.filePath,
          runtimeModuleId: directModule.id,
          sourceFilePath: fact.declaration.declarationFilePath,
        },
      });
      continue;
    }

    const facades = input.materialized.modules.flatMap((module) =>
      (module.typeMetadata?.kind === "fused"
        ? module.typeMetadata.exportFacades
        : []
      )
        .filter(
          (facade) =>
            facade.originModuleId === input.publicRuntimeModuleId &&
            facade.originExportName === fact.exportName,
        )
        .map((facade) => ({ facade, module })),
    );
    for (const { facade, module } of facades) {
      if (!facade.outputLocalName) {
        input.diagnostics.push({
          exportName: fact.exportName,
          phase: "selection",
          reason: "fused-export-unproven",
          runtimeModuleId: module.id,
          sourceFilePath: fact.declaration.declarationFilePath,
        });
        continue;
      }
      plans.push({
        declaration: fact.declaration,
        outputBindingName: facade.outputLocalName,
        target: {
          emitFilePath: module.filePath,
          runtimeModuleId: module.id,
          sourceFilePath: fact.declaration.declarationFilePath,
        },
      });
    }
  }
  return plans;
}

export function selectOverlayMetadata(
  source: ClosureTypeMetadataFile,
  plan: OverlayAttachmentPlan,
): ClosureTypeMetadataFile | null {
  const annotations = source.annotations
    .filter((annotation) =>
      annotationTargetsName(annotation, plan.declaration.declarationName),
    )
    .map((annotation) =>
      retargetAnnotation(annotation, plan.outputBindingName),
    );
  const enums = source.enums
    .filter((item) => item.bindingName === plan.declaration.declarationName)
    .map((item) => ({ ...item, bindingName: plan.outputBindingName }));
  if (annotations.length === 0 && enums.length === 0) {
    return null;
  }

  const declarations = collectReferencedDeclarations(
    source.declarations,
    annotations,
  );
  const referencedSymbolIds = new Set([
    ...annotations.flatMap((annotation) =>
      annotation.references.map((reference) => reference.symbolId),
    ),
    ...declarations.flatMap((declaration) => [
      declaration.declaredSymbolId,
      ...declaration.references.map((reference) => reference.symbolId),
    ]),
    ...enums.map((item) => item.symbolId),
  ]);
  const symbols = source.symbols
    .filter(
      (symbol) =>
        referencedSymbolIds.has(symbol.id) ||
        symbol.id === plan.declaration.symbolId,
    )
    .map((symbol) => sanitizeOverlaySymbol(symbol, plan));

  return {
    annotations,
    declarations,
    decoratedOutputText: undefined,
    diagnostics: source.diagnostics,
    enums,
    filePath: plan.target.emitFilePath,
    runtimeModuleId: plan.target.runtimeModuleId,
    sourceFilePath: source.sourceFilePath,
    symbols,
  };
}

function collectReferencedDeclarations(
  declarations: ClosureTypeDeclaration[],
  annotations: ClosureAnnotation[],
) {
  const bySymbolId = new Map(
    declarations.map((declaration) => [
      declaration.declaredSymbolId,
      declaration,
    ]),
  );
  const pending = annotations.flatMap((annotation) =>
    annotation.references.map((reference) => reference.symbolId),
  );
  const collected = new Map<string, ClosureTypeDeclaration>();
  while (pending.length > 0) {
    const symbolId = pending.pop();
    if (!symbolId || collected.has(symbolId)) {
      continue;
    }
    const declaration = bySymbolId.get(symbolId);
    if (!declaration) {
      continue;
    }
    collected.set(symbolId, declaration);
    pending.push(
      ...declaration.references.map((reference) => reference.symbolId),
    );
  }
  return [...collected.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function sanitizeOverlaySymbol(
  symbol: ClosureTypeSymbol,
  plan: OverlayAttachmentPlan,
): ClosureTypeSymbol {
  if (symbol.kind !== "runtime") {
    return symbol;
  }
  return symbol.id === plan.declaration.symbolId
    ? { ...symbol, localName: plan.outputBindingName }
    : { ...symbol, localName: undefined };
}

function retargetAnnotation(
  annotation: ClosureAnnotation,
  outputBindingName: string,
): ClosureAnnotation {
  return annotation.target.kind === "binding"
    ? {
        ...annotation,
        target: { bindingName: outputBindingName, kind: "binding" },
      }
    : {
        ...annotation,
        target: { ...annotation.target, ownerBindingName: outputBindingName },
      };
}

function annotationTargetsName(annotation: ClosureAnnotation, name: string) {
  return annotation.target.kind === "binding"
    ? annotation.target.bindingName === name
    : annotation.target.ownerBindingName === name;
}

function mergeMetadataFiles(files: ClosureTypeMetadataFile[]) {
  const byTarget = new Map<string, ClosureTypeMetadataFile>();
  for (const file of files) {
    const key = `${path.normalize(file.filePath)}\0${file.runtimeModuleId ?? ""}`;
    const existing = byTarget.get(key);
    if (!existing) {
      byTarget.set(key, file);
      continue;
    }
    byTarget.set(key, {
      ambientGlobals: dedupe(
        (existing.ambientGlobals ?? []).concat(file.ambientGlobals ?? []),
      ),
      annotations: dedupe(existing.annotations.concat(file.annotations)),
      declarations: dedupeById(existing.declarations.concat(file.declarations)),
      decoratedOutputText: undefined,
      diagnostics: dedupe(existing.diagnostics.concat(file.diagnostics)),
      enums: dedupe(existing.enums.concat(file.enums)),
      externalGlobalMemberAccesses: [
        ...new Set(
          (existing.externalGlobalMemberAccesses ?? []).concat(
            file.externalGlobalMemberAccesses ?? [],
          ),
        ),
      ].sort((left, right) => left - right),
      externalOwnedMemberAccesses: [
        ...new Set(
          (existing.externalOwnedMemberAccesses ?? []).concat(
            file.externalOwnedMemberAccesses ?? [],
          ),
        ),
      ].sort((left, right) => left - right),
      filePath: existing.filePath,
      runtimeModuleId: existing.runtimeModuleId,
      sourceFilePath:
        [existing.sourceFilePath, file.sourceFilePath].sort()[0] ??
        existing.sourceFilePath,
      symbols: mergeSymbols(existing.symbols, file.symbols),
    });
  }
  return [...byTarget.values()].sort((left, right) =>
    `${left.filePath}\0${left.runtimeModuleId ?? ""}`.localeCompare(
      `${right.filePath}\0${right.runtimeModuleId ?? ""}`,
    ),
  );
}

function mergeSymbols(left: ClosureTypeSymbol[], right: ClosureTypeSymbol[]) {
  const byId = new Map(left.map((symbol) => [symbol.id, symbol]));
  for (const symbol of right) {
    const existing = byId.get(symbol.id);
    if (!existing) {
      byId.set(symbol.id, symbol);
      continue;
    }
    const localName =
      existing.localName &&
      symbol.localName &&
      existing.localName !== symbol.localName
        ? undefined
        : (existing.localName ?? symbol.localName);
    byId.set(symbol.id, { ...existing, ...symbol, localName });
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function dedupe<T>(values: T[]) {
  return [
    ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
  ];
}

function dedupeById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

export function finalizeSidecar(input: {
  dependencies: Set<string>;
  diagnostics: ViteTypeMetadataDiagnostic[];
  files: ClosureTypeMetadataFile[];
}): ViteTypeMetadataSidecar {
  const dependencies = [
    ...new Set(
      [...input.dependencies]
        .filter((filePath) => path.isAbsolute(filePath))
        .map((filePath) => path.normalize(filePath)),
    ),
  ]
    .filter((filePath) => ts.sys.fileExists(filePath))
    .sort((left, right) => left.localeCompare(right));
  const files = mergeMetadataFiles(input.files);
  const diagnostics = dedupe(input.diagnostics).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return {
    dependencies,
    diagnostics,
    extractedCounts: countTypeMetadata(files),
    files,
  };
}

export function oneToOneSourceModuleId(module: CapturedRuntimeModule) {
  const provenance = module.typeMetadata;
  if (provenance?.kind === "fused") {
    return null;
  }
  const mapping = provenance?.sourceMappings[0];
  if (provenance && (provenance.sourceMappings.length !== 1 || !mapping)) {
    return null;
  }
  if (mapping) {
    return mapping;
  }
  return module.sourceModuleIds.length === 1
    ? (module.sourceModuleIds[0] ?? null)
    : null;
}

export function metadataTargetKey(target: TypeMetadataTarget) {
  return [
    target.sourceFilePath,
    target.emitFilePath,
    target.runtimeModuleId ?? "",
  ].join("\0");
}
