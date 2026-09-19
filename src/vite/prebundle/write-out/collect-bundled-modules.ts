import fs from "node:fs/promises";
import path from "node:path";

import type { Metafile } from "esbuild";

import type { CapturedRuntimeModule } from "../../internal-types";
import { parseRuntimeExportGraph } from "../../type-metadata/export-graphs";
import type { PrebundleExportFacade } from "../../type-metadata";
import { normalizePath } from "../shared";
import type { DependencyBundleSet } from "../types";

export async function collectBundledModules(input: {
  extraModules: CapturedRuntimeModule[];
  bundleSrcDir: string;
  metafile: Metafile;
  omittedFilePaths: Set<string>;
  originalSourceIdsByFilePath: Map<string, string[]>;
  outputSrcDir: string;
  syntheticSourceIdsByFilePath: Map<string, string[]>;
  exportFacadesByOutputPath: Map<string, PrebundleExportFacade[]>;
}): Promise<CapturedRuntimeModule[]> {
  const modules: CapturedRuntimeModule[] = [];

  for (const [outputPath, metadata] of Object.entries(input.metafile.outputs)) {
    if (!outputPath.endsWith(".js")) {
      continue;
    }

    const sourceModuleIds = new Set<string>();
    for (const inputPath of Object.keys(metadata.inputs)) {
      const absoluteInputPath = normalizePath(
        path.resolve(input.bundleSrcDir, inputPath),
      );
      const sourceIds =
        input.syntheticSourceIdsByFilePath.get(absoluteInputPath) ??
        input.originalSourceIdsByFilePath.get(absoluteInputPath);
      if (!sourceIds) {
        continue;
      }
      for (const sourceId of sourceIds) {
        sourceModuleIds.add(sourceId);
      }
    }

    const filePath = normalizePath(
      path.resolve(input.outputSrcDir, outputPath),
    );
    if (input.omittedFilePaths.has(filePath)) {
      continue;
    }
    const sourceModuleIdsSorted = [...sourceModuleIds].sort((left, right) =>
      left.localeCompare(right),
    );
    const exportFacades = input.exportFacadesByOutputPath.get(filePath) ?? [];
    let sourceText = "";
    try {
      sourceText = await fs.readFile(filePath, "utf8");
    } catch {
      // The build path owns missing-output errors. Metadata stays conservative.
    }
    const localNameByExport = new Map(
      parseRuntimeExportGraph(filePath, sourceText).flatMap((fact) =>
        fact.exportName && fact.localName
          ? [[fact.exportName, fact.localName] as const]
          : [],
      ),
    );
    const resolvedFacades = exportFacades.map((facade) => ({
      ...facade,
      outputLocalName: localNameByExport.get(facade.outputExportName),
    }));
    modules.push({
      filePath,
      format: "esm",
      id: filePath,
      relativePath: path
        .relative(input.outputSrcDir, filePath)
        .replace(/\\/g, "/"),
      sourceModuleIds: sourceModuleIdsSorted,
      typeMetadata: {
        exportFacades: resolvedFacades,
        kind: "fused",
        sourceMappings: [],
      },
    });
  }

  modules.push(
    ...input.extraModules.map((module) => {
      const exportFacades =
        input.exportFacadesByOutputPath.get(normalizePath(module.filePath)) ??
        [];
      return {
        ...module,
        typeMetadata: {
          exportFacades,
          kind: "fused" as const,
          sourceMappings: [],
        },
      };
    }),
  );

  return mergeBundledModulesByEmittedFile(modules);
}

/**
 * One materialized module per emitted file. Duplicate listings of the same
 * fused output union their contributing source ids so later hazard analysis
 * sees the complete package set once.
 */
function mergeBundledModulesByEmittedFile(
  modules: CapturedRuntimeModule[],
): CapturedRuntimeModule[] {
  const merged = new Map<string, CapturedRuntimeModule>();
  for (const module of modules) {
    const existing = merged.get(module.filePath);
    if (!existing) {
      merged.set(module.filePath, module);
      continue;
    }
    existing.sourceModuleIds = [
      ...new Set([...existing.sourceModuleIds, ...module.sourceModuleIds]),
    ].sort((left, right) => left.localeCompare(right));
  }
  return [...merged.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

export function collectExportFacadesByOutputPath(bundles: DependencyBundleSet) {
  const facadesByOutputPath = new Map<string, PrebundleExportFacade[]>();
  for (const writtenRequest of bundles.writtenRequests) {
    let outputFilePath =
      bundles.canonicalizedEntryOutputs.outputByRequestKey.get(
        writtenRequest.requestKey,
      );
    if (!outputFilePath) {
      continue;
    }
    outputFilePath =
      bundles.collapsedEntryOutputByPath.get(outputFilePath)
        ?.directTargetFilePath ?? outputFilePath;
    const facades = facadesByOutputPath.get(outputFilePath) ?? [];
    for (const request of writtenRequest.requests) {
      const outputNames = new Set(
        request.needsExportAll
          ? request.exportedNames
          : [...request.usedNamedExports],
      );
      if (request.hasDefaultExport && request.needsDefault) {
        outputNames.add("default");
      }
      for (const outputExportName of [...outputNames].sort()) {
        facades.push({
          originExportName: outputExportName,
          originModuleId: request.targetModule.id,
          outputExportName,
        });
      }
    }
    facadesByOutputPath.set(
      outputFilePath,
      [
        ...new Map(
          facades.map((facade) => [
            `${facade.outputExportName}\0${facade.originModuleId}\0${facade.originExportName}`,
            facade,
          ]),
        ).values(),
      ].sort((left, right) =>
        `${left.outputExportName}\0${left.originModuleId}`.localeCompare(
          `${right.outputExportName}\0${right.originModuleId}`,
        ),
      ),
    );
  }
  return facadesByOutputPath;
}
