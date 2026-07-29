import path from "node:path";

import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import { hashTypeMetadataValue } from "./cache";
import type {
  RuntimeModuleTypeProvenance,
  SourceToRuntimeMapping,
} from "./types";

const TYPESCRIPT_RUNTIME_EXTENSION = /\.(?:cts|mts|tsx?)$/u;
const JAVASCRIPT_RUNTIME_EXTENSION = /\.(?:cjs|js|jsx|mjs)$/u;
const EXPLICIT_JSDOC_TYPE_SIGNAL =
  /(?:\/\/\s*@ts-check\b|\/\*\*[\s\S]*?@(type|param|returns?|template|typedef|implements|extends|satisfies)\b)/u;

export type TypeMetadataSourceEligibility =
  | "js-jsdoc"
  | "ts-runtime"
  | "untyped";

export function classifyTypeMetadataSource(
  moduleId: string,
  sourceText?: string,
): TypeMetadataSourceEligibility {
  const cleanId = moduleId.replace(/[?#].*$/u, "");
  if (moduleId.startsWith("\0") || moduleId.startsWith("virtual:")) {
    return "untyped";
  }
  if (TYPESCRIPT_RUNTIME_EXTENSION.test(cleanId)) {
    return "ts-runtime";
  }
  if (
    JAVASCRIPT_RUNTIME_EXTENSION.test(cleanId) &&
    sourceText !== undefined &&
    EXPLICIT_JSDOC_TYPE_SIGNAL.test(sourceText)
  ) {
    return "js-jsdoc";
  }
  return "untyped";
}

export function collectOneToOneSourceMappings(
  graph: Pick<MaterializedGraph, "modules">,
): SourceToRuntimeMapping[] {
  return graph.modules
    .flatMap((module) => {
      const sourceModuleId = module.sourceModuleIds[0];
      if (module.sourceModuleIds.length !== 1 || sourceModuleId === undefined) {
        return [];
      }
      return [
        {
          materializedFilePath: path.normalize(module.filePath),
          runtimeModuleId: module.id,
          sourceModuleId,
        },
      ];
    })
    .sort((left, right) =>
      `${left.runtimeModuleId}\0${left.sourceModuleId}`.localeCompare(
        `${right.runtimeModuleId}\0${right.sourceModuleId}`,
      ),
    );
}

export function shouldBypassTypeMetadataFusion(
  module: Pick<CapturedRuntimeModule, "sourceModuleIds">,
) {
  const sourceModuleId = module.sourceModuleIds[0];
  return (
    module.sourceModuleIds.length === 1 &&
    sourceModuleId !== undefined &&
    classifyTypeMetadataSource(sourceModuleId) === "ts-runtime"
  );
}

export function withOneToOneTypeProvenance(
  module: CapturedRuntimeModule,
): CapturedRuntimeModule {
  const sourceModuleId = module.sourceModuleIds[0];
  if (module.sourceModuleIds.length !== 1 || sourceModuleId === undefined) {
    return module;
  }
  const sourceMappings = [
    {
      materializedFilePath: path.normalize(module.filePath),
      runtimeModuleId: module.id,
      sourceModuleId,
    },
  ];
  const typeMetadata = {
    cacheKey: hashTypeMetadataValue(sourceMappings),
    exportFacades: [],
    kind: "one-to-one",
    sourceMappings,
  } satisfies RuntimeModuleTypeProvenance;
  return { ...module, typeMetadata };
}
