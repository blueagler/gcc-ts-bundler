import path from "node:path";

import ts from "@typescript/typescript6";

import {
  collectNativeTypeMetadataFromContext,
  createNativeTypeAnalysisContext,
  scanNativeTypeAnalysisContext,
} from "../../../build/transpile/type-metadata";
import type {
  ClosureTypeMetadataFile,
  TypeMetadataTarget,
} from "../../../build/transpile/type-metadata";
import { finalizeSidecar, type OverlayAttachmentPlan } from "../fusion";
import type {
  DeclarationOverlayResult,
  ViteTypeMetadataDiagnostic,
  ViteTypeMetadataSidecar,
} from "../types";
import { serializeTypeScriptDiagnostic } from "./protocol";

interface NativeTypeAnalysisContext {
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
}

export type ViteTypeMetadataAnalysis =
  | { status: "done"; sidecar: ViteTypeMetadataSidecar }
  | {
      status: "ready";
      files: ClosureTypeMetadataFile[];
      overlayMetadataBySource: Map<string, ClosureTypeMetadataFile>;
    };

export async function analyzeViteTypeMetadata(input: {
  projectRoot: string;
  diagnostics: ViteTypeMetadataDiagnostic[];
  dependencies: Set<string>;
  directTargets: TypeMetadataTarget[];
  overlayAttachments: {
    plans: OverlayAttachmentPlan[];
    results: DeclarationOverlayResult[];
  };
  externalGlobalFiles: ClosureTypeMetadataFile[];
}): Promise<ViteTypeMetadataAnalysis> {
  const overlaySourceFiles = [
    ...new Set(
      input.overlayAttachments.plans.map((plan) =>
        path.normalize(plan.declaration.declarationFilePath),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const tsConfigPath = ts.findConfigFile(
    input.projectRoot,
    ts.sys.fileExists,
    "tsconfig.json",
  );

  if (input.directTargets.length === 0 && overlaySourceFiles.length === 0) {
    return {
      status: "done",
      sidecar: finalizeSidecar({
        dependencies: input.dependencies,
        diagnostics: input.diagnostics,
        files: input.externalGlobalFiles,
      }),
    };
  }
  if (!tsConfigPath) {
    input.diagnostics.push({
      detail: input.projectRoot,
      phase: "selection",
      reason: "analysis-config-unavailable",
    });
    return {
      status: "done",
      sidecar: finalizeSidecar({
        dependencies: input.dependencies,
        diagnostics: input.diagnostics,
        files: input.externalGlobalFiles,
      }),
    };
  }
  input.dependencies.add(path.normalize(tsConfigPath));

  const fileNames = [
    ...new Set([
      ...input.directTargets.map((target) => target.sourceFilePath),
      ...input.overlayAttachments.results.flatMap((result) =>
        result.identity ? [result.identity.declarationEntryPath] : [],
      ),
      ...overlaySourceFiles,
    ]),
  ].sort((left, right) => left.localeCompare(right));

  let context: NativeTypeAnalysisContext;
  try {
    context = await createNativeTypeAnalysisContext({
      fileNames,
      tsConfigPath,
      workspaceDir: input.projectRoot,
    });
  } catch (error) {
    input.diagnostics.push({
      detail: error instanceof Error ? error.message : String(error),
      phase: "selection",
      reason: "analysis-config-invalid",
    });
    return {
      status: "done",
      sidecar: finalizeSidecar({
        dependencies: input.dependencies,
        diagnostics: input.diagnostics,
        files: input.externalGlobalFiles,
      }),
    };
  }

  for (const sourceFile of context.program.getSourceFiles()) {
    if (!context.program.isSourceFileDefaultLibrary(sourceFile)) {
      input.dependencies.add(path.normalize(sourceFile.fileName));
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
    targets: [...input.directTargets, ...overlayIdentityTargets],
  });
  input.diagnostics.push(...analysis.typeMetadataDiagnostics);
  input.diagnostics.push(
    ...analysis.diagnostics.map(serializeTypeScriptDiagnostic),
  );

  const overlayMetadataBySource = new Map(
    analysis.files
      .filter((file) => file.filePath === file.sourceFilePath)
      .map((file) => [path.normalize(file.sourceFilePath), file]),
  );
  return {
    status: "ready",
    files: analysis.files,
    overlayMetadataBySource,
  };
}
