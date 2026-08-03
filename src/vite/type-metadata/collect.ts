import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import {
  collectNativeTypeMetadataFromContext,
  countTypeMetadata,
  createNativeTypeAnalysisContext,
  scanNativeTypeAnalysisContext,
} from "../../build/transpile/closure-ir";
import type {
  ClosureAnnotation,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
  ClosureTypeSymbol,
  TypeMetadataTarget,
} from "../../build/transpile/closure-ir";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import { hashTypeMetadataFiles, hashTypeMetadataValue } from "./cache";
import { resolveDeclarationOverlay } from "./declaration-overlay";
import {
  joinDeclarationAndRuntimeExports,
  resolveRuntimeExportGraph,
} from "./export-graphs";
import { classifyTypeMetadataSource } from "./source-provenance";
import {
  VITE_TYPE_METADATA_VERSION,
  type DeclarationExportFact,
  type JoinedExportTypeFact,
  type RuntimeResolutionIdentity,
  type ViteTypeMetadataAttachment,
  type ViteTypeMetadataDiagnostic,
  type ViteTypeMetadataSidecar,
  type ViteTypeScriptDiagnostic,
} from "./types";

interface OverlayAttachmentPlan {
  declaration: DeclarationExportFact;
  exportName: string;
  facadeId?: string | undefined;
  originExportName: string;
  originRuntimeModuleId: string;
  outputBindingName: string;
  target: TypeMetadataTarget;
}

export async function collectViteTypeMetadata(input: {
  materialized: MaterializedGraph;
  projectRoot: string;
  sourceGraph?: MaterializedGraph | undefined;
}): Promise<ViteTypeMetadataSidecar> {
  const sourceGraph = input.sourceGraph ?? input.materialized;
  const diagnostics: ViteTypeMetadataDiagnostic[] = [];
  const dependencies = new Set<string>();
  const attachments: ViteTypeMetadataAttachment[] = [];
  const directTargets: TypeMetadataTarget[] = [];
  const directTargetKeys = new Set<string>();

  for (const module of input.materialized.modules) {
    const sourceModuleId = oneToOneSourceModuleId(module);
    if (!sourceModuleId) {
      continue;
    }
    if (
      sourceModuleId.startsWith("\0") ||
      sourceModuleId.startsWith("virtual:")
    ) {
      diagnostics.push({
        phase: "selection",
        reason: "virtual-module-omitted",
        runtimeModuleId: module.id,
        sourceFilePath: sourceModuleId,
      });
      continue;
    }
    if (/[?#]/u.test(sourceModuleId)) {
      diagnostics.push({
        phase: "selection",
        reason: "query-module-omitted",
        runtimeModuleId: module.id,
        sourceFilePath: sourceModuleId,
      });
      continue;
    }
    if (!path.isAbsolute(sourceModuleId)) {
      continue;
    }

    let sourceText: string;
    try {
      sourceText = await fs.readFile(sourceModuleId, "utf8");
    } catch {
      diagnostics.push({
        phase: "selection",
        reason: "source-file-unreadable",
        runtimeModuleId: module.id,
        sourceFilePath: sourceModuleId,
      });
      continue;
    }
    dependencies.add(path.normalize(sourceModuleId));
    if (classifyTypeMetadataSource(sourceModuleId, sourceText) === "untyped") {
      continue;
    }

    const target = {
      emitFilePath: path.normalize(module.filePath),
      runtimeModuleId: module.id,
      sourceFilePath: path.normalize(sourceModuleId),
    } satisfies TypeMetadataTarget;
    const targetKey = metadataTargetKey(target);
    if (!directTargetKeys.has(targetKey)) {
      directTargetKeys.add(targetKey);
      directTargets.push(target);
      attachments.push({
        kind: "source",
        runtimeModuleId: module.id,
        sourceFilePath: target.sourceFilePath,
      });
    }
  }

  const sourceTextByModuleId = await readRuntimeModuleSources(
    sourceGraph.modules,
    dependencies,
    diagnostics,
  );
  const overlayAttachments = await collectOverlayAttachments({
    diagnostics,
    input,
    sourceGraph,
    sourceTextByModuleId,
  });
  for (const overlay of overlayAttachments.results) {
    for (const cacheFile of overlay.cacheFiles) {
      dependencies.add(path.normalize(cacheFile));
    }
  }

  const overlaySourceFiles = [
    ...new Set(
      overlayAttachments.plans.map((plan) =>
        path.normalize(plan.declaration.declarationFilePath),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const tsConfigPath = ts.findConfigFile(
    input.projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );
  const provenance = {
    attachments,
    moduleCacheKeys: input.materialized.modules
      .flatMap((module) =>
        module.typeMetadata
          ? [
              {
                cacheKey: module.typeMetadata.cacheKey,
                runtimeModuleId: module.id,
              },
            ]
          : [],
      )
      .sort((left, right) =>
        left.runtimeModuleId.localeCompare(right.runtimeModuleId),
      ),
    resolutions: [...(sourceGraph.runtimeResolutions ?? [])].sort(
      (left, right) => resolutionKey(left).localeCompare(resolutionKey(right)),
    ),
  };

  if (directTargets.length === 0 && overlaySourceFiles.length === 0) {
    return finalizeSidecar({
      dependencies,
      diagnostics,
      files: [],
      provenance,
    });
  }
  if (!tsConfigPath) {
    diagnostics.push({
      detail: input.projectRoot,
      phase: "selection",
      reason: "analysis-config-unavailable",
    });
    return finalizeSidecar({
      dependencies,
      diagnostics,
      files: [],
      provenance,
    });
  }
  dependencies.add(path.normalize(tsConfigPath));

  const fileNames = [
    ...new Set([
      ...directTargets.map((target) => target.sourceFilePath),
      ...overlayAttachments.results.flatMap((result) =>
        result.identity ? [result.identity.declarationEntryPath] : [],
      ),
      ...overlaySourceFiles,
    ]),
  ].sort((left, right) => left.localeCompare(right));

  let context: Awaited<ReturnType<typeof createNativeTypeAnalysisContext>>;
  try {
    context = await createNativeTypeAnalysisContext({
      fileNames,
      tsConfigPath,
      workspaceDir: input.projectRoot,
    });
  } catch (error) {
    diagnostics.push({
      detail: error instanceof Error ? error.message : String(error),
      phase: "selection",
      reason: "analysis-config-invalid",
    });
    return finalizeSidecar({
      dependencies,
      diagnostics,
      files: [],
      provenance,
    });
  }

  for (const sourceFile of context.program.getSourceFiles()) {
    if (!context.program.isSourceFileDefaultLibrary(sourceFile)) {
      dependencies.add(path.normalize(sourceFile.fileName));
    }
  }

  const overlayIdentityTargets = overlaySourceFiles.map(
    (sourceFilePath): TypeMetadataTarget => ({
      emitFilePath: sourceFilePath,
      sourceFilePath,
    }),
  );
  const analysis = collectNativeTypeMetadataFromContext({
    context,
    scan: scanNativeTypeAnalysisContext({ context }),
    targets: [...directTargets, ...overlayIdentityTargets],
  });
  diagnostics.push(...analysis.typeMetadataDiagnostics);
  diagnostics.push(...analysis.diagnostics.map(serializeTypeScriptDiagnostic));

  const overlayMetadataBySource = new Map(
    analysis.files
      .filter((file) => file.filePath === file.sourceFilePath)
      .map((file) => [path.normalize(file.sourceFilePath), file]),
  );
  const files: ClosureTypeMetadataFile[] = [];
  for (const target of directTargets) {
    const file = analysis.files.find(
      (candidate) =>
        candidate.filePath === target.emitFilePath &&
        candidate.sourceFilePath === target.sourceFilePath &&
        candidate.runtimeModuleId === target.runtimeModuleId,
    );
    if (!file) {
      continue;
    }
    const filtered = await filterDirectMetadata(file, diagnostics);
    if (filtered) {
      files.push(filtered);
    }
  }

  for (const plan of overlayAttachments.plans) {
    const source = overlayMetadataBySource.get(
      path.normalize(plan.declaration.declarationFilePath),
    );
    if (!source) {
      diagnostics.push({
        exportName: plan.declaration.exportName,
        phase: "selection",
        reason: "declaration-export-metadata-unavailable",
        runtimeModuleId: plan.target.runtimeModuleId,
        sourceFilePath: plan.declaration.declarationFilePath,
      });
      continue;
    }
    const file = selectOverlayMetadata(source, plan);
    if (!file) {
      diagnostics.push({
        exportName: plan.declaration.exportName,
        phase: "selection",
        reason: "declaration-export-metadata-unavailable",
        runtimeModuleId: plan.target.runtimeModuleId,
        sourceFilePath: plan.declaration.declarationFilePath,
      });
      continue;
    }
    files.push(file);
    const attachment = {
      declarationId: plan.declaration.declarationId,
      exportName: plan.exportName,
      facadeId: plan.facadeId,
      kind: "declaration-overlay",
      originExportName: plan.originExportName,
      originRuntimeModuleId: plan.originRuntimeModuleId,
      outputBindingName: plan.outputBindingName,
      runtimeModuleId: plan.target.runtimeModuleId ?? plan.target.emitFilePath,
      sourceFilePath: plan.declaration.declarationFilePath,
    } satisfies ViteTypeMetadataAttachment;
    attachments.push(attachment);
  }

  return finalizeSidecar({
    dependencies,
    diagnostics,
    files: mergeMetadataFiles(files),
    provenance,
  });
}

async function collectOverlayAttachments(input: {
  diagnostics: ViteTypeMetadataDiagnostic[];
  input: {
    materialized: MaterializedGraph;
    projectRoot: string;
  };
  sourceGraph: MaterializedGraph;
  sourceTextByModuleId: Map<string, string>;
}) {
  const results: Array<Awaited<ReturnType<typeof resolveDeclarationOverlay>>> =
    [];
  const plans: OverlayAttachmentPlan[] = [];
  const seen = new Set<string>();
  const runtimeGraph = createRuntimeGraphResolver(input.sourceGraph);

  for (const resolution of input.sourceGraph.runtimeResolutions ?? []) {
    const cleanRuntimePath = resolution.runtimePath.replace(/[?#].*$/u, "");
    if (!/\.(?:cjs|js|jsx|mjs)$/u.test(cleanRuntimePath)) {
      continue;
    }
    const overlayKey = [
      resolution.runtimeModuleId,
      resolution.packageSubpath ?? ".",
      resolution.resolutionMode,
    ].join("\0");
    if (seen.has(overlayKey)) {
      continue;
    }
    seen.add(overlayKey);

    const containingFilePath = path.isAbsolute(resolution.importerModuleId)
      ? resolution.importerModuleId.replace(/[?#].*$/u, "")
      : undefined;
    const overlay = await resolveDeclarationOverlay({
      ...(containingFilePath ? { containingFilePath } : {}),
      resolution,
      resolutionMode: resolution.resolutionMode,
    });
    results.push(overlay);
    input.diagnostics.push(...overlay.diagnostics);
    if (!overlay.identity || overlay.exports.length === 0) {
      continue;
    }

    const runtime = resolveRuntimeExportGraph({
      entryModuleId: resolution.runtimeModuleId,
      modules: input.sourceTextByModuleId,
      resolveModuleId: runtimeGraph,
    });
    input.diagnostics.push(...runtime.diagnostics);
    const joined = joinDeclarationAndRuntimeExports({
      declarationExports: overlay.exports,
      runtimeExports: runtime.exports,
      runtimeModuleId: resolution.runtimeModuleId,
    });
    input.diagnostics.push(...joined.diagnostics);
    plans.push(
      ...materializeJoinedExports({
        diagnostics: input.diagnostics,
        facts: joined.facts,
        materialized: input.input.materialized,
        publicRuntimeModuleId: resolution.runtimeModuleId,
      }),
    );
  }

  return { plans, results };
}

function materializeJoinedExports(input: {
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
        exportName: fact.exportName,
        originExportName: fact.exportName,
        originRuntimeModuleId: input.publicRuntimeModuleId,
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
        exportName: facade.outputExportName,
        facadeId: facade.facadeId,
        originExportName: facade.originExportName,
        originRuntimeModuleId: facade.originModuleId,
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

async function readRuntimeModuleSources(
  modules: CapturedRuntimeModule[],
  dependencies: Set<string>,
  diagnostics: ViteTypeMetadataDiagnostic[],
) {
  const sources = new Map<string, string>();
  await Promise.all(
    modules.map(async (module) => {
      dependencies.add(path.normalize(module.filePath));
      try {
        sources.set(module.id, await fs.readFile(module.filePath, "utf8"));
      } catch {
        diagnostics.push({
          phase: "selection",
          reason: "source-file-unreadable",
          runtimeModuleId: module.id,
          sourceFilePath: module.filePath,
        });
      }
    }),
  );
  return sources;
}

function createRuntimeGraphResolver(graph: MaterializedGraph) {
  const moduleById = new Map(
    graph.modules.map((module) => [module.id, module]),
  );
  const moduleIdByFilePath = new Map(
    graph.modules.map((module) => [path.normalize(module.filePath), module.id]),
  );
  return (importerModuleId: string, specifier: string) => {
    const importer = moduleById.get(importerModuleId);
    if (!importer || !specifier.startsWith(".")) {
      return null;
    }
    const targetPath = path.normalize(
      path.resolve(path.dirname(importer.filePath), specifier),
    );
    return (
      moduleIdByFilePath.get(targetPath) ??
      [".js", ".mjs", ".cjs"]
        .map((extension) => moduleIdByFilePath.get(`${targetPath}${extension}`))
        .find((moduleId) => moduleId !== undefined) ??
      null
    );
  };
}

async function filterDirectMetadata(
  file: ClosureTypeMetadataFile,
  diagnostics: ViteTypeMetadataDiagnostic[],
): Promise<ClosureTypeMetadataFile | null> {
  let runtimeText: string;
  try {
    runtimeText = await fs.readFile(file.filePath, "utf8");
  } catch {
    diagnostics.push({
      phase: "selection",
      reason: "source-file-unreadable",
      runtimeModuleId: file.runtimeModuleId,
      sourceFilePath: file.filePath,
    });
    return null;
  }
  const runtimeBindings = collectTopLevelRuntimeBindings(
    file.filePath,
    runtimeText,
  );
  const annotations = file.annotations.filter((annotation) =>
    annotationTargetExists(annotation, runtimeBindings),
  );
  const enums = file.enums.filter((item) =>
    runtimeBindings.has(item.bindingName),
  );
  if (
    annotations.length !== file.annotations.length ||
    enums.length !== file.enums.length
  ) {
    diagnostics.push({
      detail: `annotations=${file.annotations.length - annotations.length} enums=${file.enums.length - enums.length}`,
      phase: "selection",
      reason: "source-runtime-binding-mismatch",
      runtimeModuleId: file.runtimeModuleId,
      sourceFilePath: file.sourceFilePath,
    });
  }
  return {
    ...file,
    annotations,
    decoratedOutputText: undefined,
    enums,
    symbols: file.symbols.map((symbol) =>
      symbol.kind === "runtime" &&
      symbol.localName &&
      !runtimeBindings.has(symbol.localName)
        ? { ...symbol, localName: undefined }
        : symbol,
    ),
  };
}

function selectOverlayMetadata(
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

function annotationTargetExists(
  annotation: ClosureAnnotation,
  runtimeBindings: ReadonlySet<string>,
) {
  return annotation.target.kind === "binding"
    ? runtimeBindings.has(annotation.target.bindingName)
    : runtimeBindings.has(annotation.target.ownerBindingName);
}

function collectTopLevelRuntimeBindings(filePath: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      (ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name) {
        names.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        names.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          names.add(element.name.text);
        }
      }
    }
  }
  return names;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
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
      annotations: dedupe(existing.annotations.concat(file.annotations)),
      declarations: dedupeById(existing.declarations.concat(file.declarations)),
      decoratedOutputText: undefined,
      diagnostics: dedupe(existing.diagnostics.concat(file.diagnostics)),
      enums: dedupe(existing.enums.concat(file.enums)),
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

async function finalizeSidecar(input: {
  dependencies: Set<string>;
  diagnostics: ViteTypeMetadataDiagnostic[];
  files: ClosureTypeMetadataFile[];
  provenance: ViteTypeMetadataSidecar["provenance"];
}): Promise<ViteTypeMetadataSidecar> {
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
    diagnosticKey(left).localeCompare(diagnosticKey(right)),
  );
  const dependencyContentHash =
    dependencies.length > 0
      ? await hashTypeMetadataFiles(dependencies)
      : hashTypeMetadataValue([]);
  return {
    cacheKey: hashTypeMetadataValue({
      dependencyContentHash,
      files,
      provenance: input.provenance,
    }),
    dependencies,
    diagnostics,
    extractedCounts: countTypeMetadata(files),
    files,
    provenance: input.provenance,
    version: VITE_TYPE_METADATA_VERSION,
  };
}

function serializeTypeScriptDiagnostic(
  diagnostic: ts.Diagnostic,
): ViteTypeScriptDiagnostic {
  return {
    category: diagnosticCategory(diagnostic.category),
    code: diagnostic.code,
    filePath: diagnostic.file?.fileName,
    length: diagnostic.length,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    phase: "typescript",
    start: diagnostic.start,
  };
}

function diagnosticCategory(category: ts.DiagnosticCategory) {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error" as const;
    case ts.DiagnosticCategory.Message:
      return "message" as const;
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion" as const;
    case ts.DiagnosticCategory.Warning:
      return "warning" as const;
  }
}

function oneToOneSourceModuleId(module: CapturedRuntimeModule) {
  const provenance = module.typeMetadata;
  if (provenance?.kind === "fused") {
    return null;
  }
  const mapping = provenance?.sourceMappings[0];
  if (provenance && (provenance.sourceMappings.length !== 1 || !mapping)) {
    return null;
  }
  if (mapping) {
    return mapping.sourceModuleId;
  }
  return module.sourceModuleIds.length === 1
    ? (module.sourceModuleIds[0] ?? null)
    : null;
}

function metadataTargetKey(target: TypeMetadataTarget) {
  return [
    target.sourceFilePath,
    target.emitFilePath,
    target.runtimeModuleId ?? "",
  ].join("\0");
}

function resolutionKey(resolution: RuntimeResolutionIdentity) {
  return [
    resolution.importerModuleId,
    resolution.specifier,
    resolution.runtimeModuleId,
  ].join("\0");
}

function diagnosticKey(diagnostic: ViteTypeMetadataDiagnostic) {
  return JSON.stringify(diagnostic);
}
