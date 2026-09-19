import fs from "node:fs/promises";
import path from "node:path";

import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../../internal-types";
import { resolveDeclarationOverlays } from "../declaration-overlay";
import {
  joinDeclarationAndRuntimeExports,
  parseRuntimeExportGraph,
  resolveRuntimeExportGraph,
} from "../export-graphs";
import {
  materializeJoinedExports,
  type OverlayAttachmentPlan,
} from "../fusion";
import type { RuntimeExportFact, ViteTypeMetadataDiagnostic } from "../types";

export async function collectOverlayAttachments(input: {
  dependencies: Set<string>;
  diagnostics: ViteTypeMetadataDiagnostic[];
  input: {
    materialized: MaterializedGraph;
    projectRoot: string;
  };
  sourceGraph: MaterializedGraph;
}) {
  const overlayInputs: Parameters<
    typeof resolveDeclarationOverlays
  >[0][number][] = [];
  const plans: OverlayAttachmentPlan[] = [];
  const seen = new Set<string>();
  const moduleById = new Map(
    input.sourceGraph.modules.map((module) => [module.id, module]),
  );
  const runtimeGraph = createRuntimeGraphResolver(moduleById);
  // Share facts across package entries only for this collection. Provenance
  // copies become dependencies when export resolution actually consumes them.
  const parsedByFilePath = new Map<string, Promise<RuntimeExportFact[]>>();
  const factsFor = (moduleId: string): Promise<RuntimeExportFact[]> => {
    const module = moduleById.get(moduleId);
    if (!module) {
      return Promise.resolve([]);
    }
    const filePath = path.normalize(module.filePath);
    const cached = parsedByFilePath.get(filePath);
    if (cached) {
      return cached;
    }
    input.dependencies.add(filePath);
    const pending = fs.readFile(filePath, "utf8").then(
      (sourceText) => parseRuntimeExportGraph(moduleId, sourceText),
      () => {
        input.diagnostics.push({
          phase: "selection",
          reason: "source-file-unreadable",
          runtimeModuleId: moduleId,
          sourceFilePath: filePath,
        });
        return [];
      },
    );
    parsedByFilePath.set(filePath, pending);
    return pending;
  };

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

    const overlayInput: (typeof overlayInputs)[number] = {
      resolution,
      resolutionMode: resolution.resolutionMode,
    };
    const containingFilePath = path.isAbsolute(resolution.importerModuleId)
      ? resolution.importerModuleId.replace(/[?#].*$/u, "")
      : undefined;
    if (containingFilePath !== undefined) {
      overlayInput.containingFilePath = containingFilePath;
    }
    overlayInputs.push(overlayInput);
  }

  const results = await resolveDeclarationOverlays(overlayInputs);
  for (const [index, overlay] of results.entries()) {
    const overlayInput = overlayInputs[index];
    if (!overlayInput) {
      throw new Error("Declaration overlay result has no corresponding input.");
    }
    const { resolution } = overlayInput;
    input.diagnostics.push(...overlay.diagnostics);
    if (!overlay.identity || overlay.exports.length === 0) {
      continue;
    }

    const runtime = await resolveRuntimeExportGraph({
      entryModuleId: resolution.runtimeModuleId,
      factsFor,
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

function createRuntimeGraphResolver(
  moduleById: ReadonlyMap<string, CapturedRuntimeModule>,
) {
  const moduleIdByFilePath = new Map<string, string>();
  for (const module of moduleById.values()) {
    moduleIdByFilePath.set(path.normalize(module.filePath), module.id);
  }
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
