import path from "node:path";

import type {
  ClosureTypeMetadataFile,
  TypeMetadataTarget,
} from "../../../build/transpile/type-metadata";
import { selectOverlayMetadata, type OverlayAttachmentPlan } from "../fusion";
import type { ViteTypeMetadataDiagnostic } from "../types";
import { filterDirectMetadata } from "./filter";

export async function assembleViteTypeMetadataFiles(input: {
  diagnostics: ViteTypeMetadataDiagnostic[];
  directTargets: TypeMetadataTarget[];
  analysisFiles: ClosureTypeMetadataFile[];
  overlayMetadataBySource: Map<string, ClosureTypeMetadataFile>;
  overlayPlans: OverlayAttachmentPlan[];
}): Promise<ClosureTypeMetadataFile[]> {
  const files: ClosureTypeMetadataFile[] = [];
  for (const target of input.directTargets) {
    const file = input.analysisFiles.find(
      (candidate) =>
        candidate.filePath === target.emitFilePath &&
        candidate.sourceFilePath === target.sourceFilePath &&
        candidate.runtimeModuleId === target.runtimeModuleId,
    );
    if (!file) {
      continue;
    }
    const filtered = await filterDirectMetadata(file, input.diagnostics);
    if (filtered) {
      files.push(filtered);
    }
  }

  for (const plan of input.overlayPlans) {
    const source = input.overlayMetadataBySource.get(
      path.normalize(plan.declaration.declarationFilePath),
    );
    if (!source) {
      input.diagnostics.push({
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
      input.diagnostics.push({
        exportName: plan.declaration.exportName,
        phase: "selection",
        reason: "declaration-export-metadata-unavailable",
        runtimeModuleId: plan.target.runtimeModuleId,
        sourceFilePath: plan.declaration.declarationFilePath,
      });
      continue;
    }
    files.push(file);
  }

  return files;
}
