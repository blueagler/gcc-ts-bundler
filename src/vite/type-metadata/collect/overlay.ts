import fs from "node:fs/promises";
import path from "node:path";

import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../../internal-types";
import { resolveDeclarationOverlay } from "../declaration-overlay";
import {
  joinDeclarationAndRuntimeExports,
  resolveRuntimeExportGraph,
} from "../export-graphs";
import {
  materializeJoinedExports,
  type OverlayAttachmentPlan,
} from "../fusion";
import type {
  DeclarationOverlayResult,
  ViteTypeMetadataDiagnostic,
} from "../types";

export async function collectOverlayAttachments(input: {
  diagnostics: ViteTypeMetadataDiagnostic[];
  input: {
    materialized: MaterializedGraph;
    projectRoot: string;
  };
  sourceGraph: MaterializedGraph;
  sourceTextByModuleId: Map<string, string>;
}) {
  const results: DeclarationOverlayResult[] = [];
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

    const overlayInput: Parameters<typeof resolveDeclarationOverlay>[0] = {
      resolution,
      resolutionMode: resolution.resolutionMode,
    };
    const containingFilePath = path.isAbsolute(resolution.importerModuleId)
      ? resolution.importerModuleId.replace(/[?#].*$/u, "")
      : undefined;
    if (containingFilePath !== undefined) {
      overlayInput.containingFilePath = containingFilePath;
    }
    const overlay = await resolveDeclarationOverlay(overlayInput);
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

export async function readRuntimeModuleSources(
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
