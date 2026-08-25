import fs from "node:fs/promises";
import path from "node:path";

import type { TypeMetadataTarget } from "../../../build/transpile/type-metadata";
import type { MaterializedGraph } from "../../internal-types";
import { metadataTargetKey, oneToOneSourceModuleId } from "../fusion";
import { classifyTypeMetadataSource } from "../provenance";
import type { ViteTypeMetadataDiagnostic } from "../types";

export async function collectDirectTargets(input: {
  materialized: MaterializedGraph;
  diagnostics: ViteTypeMetadataDiagnostic[];
  dependencies: Set<string>;
}): Promise<TypeMetadataTarget[]> {
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
      input.diagnostics.push({
        phase: "selection",
        reason: "virtual-module-omitted",
        runtimeModuleId: module.id,
        sourceFilePath: sourceModuleId,
      });
      continue;
    }
    if (/[?#]/u.test(sourceModuleId)) {
      input.diagnostics.push({
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
      input.diagnostics.push({
        phase: "selection",
        reason: "source-file-unreadable",
        runtimeModuleId: module.id,
        sourceFilePath: sourceModuleId,
      });
      continue;
    }
    input.dependencies.add(path.normalize(sourceModuleId));
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
    }
  }

  return directTargets;
}
