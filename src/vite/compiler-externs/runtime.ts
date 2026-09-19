import fs from "node:fs/promises";
import path from "node:path";

import { getPackageSignature } from "../../build/resolve/signatures";
import { analyzeCssVariableProtocol } from "../../externs/css-variable-protocol";
import {
  applyPropertyPolicy,
  resolvePropertyPolicy,
  type PropertyPolicy,
} from "../../externs/property-policy";
import {
  collectRuntimeUsageExternLines,
  createEmptyAppUsageMembers,
  renderExternText,
} from "../../externs/render";
import {
  analyzeRuntimeUsage,
  mergeRuntimeHazards,
} from "../../externs/runtime";
import { runWithConcurrency } from "../../shared/concurrency";
import { writeFileIfChanged } from "../../shared/files";
import { logInternalDetail } from "../../shared/timing";
import { classifyModuleId, stripQuery } from "../capture";
import {
  loadCachedPackageRuntimeHazards,
  resolvePackageExternCacheRoot,
} from "./cache";
import type { MaterializedGraph } from "../internal-types";
import type { GccTsBundlerVitePluginOptions } from "../types";

export async function generateViteRuntimeAwareExterns(input: {
  captureRoot: string;
  generatedExternFile: string;
  modules: string[];
  options: GccTsBundlerVitePluginOptions;
  materialized: MaterializedGraph;
  propertyPolicy?: PropertyPolicy | undefined;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
}) {
  const propertyPolicy = resolvePropertyPolicy(input.propertyPolicy);
  const packageSignature = await getPackageSignature();
  const cacheRoot = resolvePackageExternCacheRoot({
    captureRoot: input.captureRoot,
    options: input.options,
  });
  await fs.mkdir(cacheRoot, { recursive: true });
  const { appRuntimeFiles, dependencyFilesByPackage } = splitRuntimeModules(
    input.materialized,
  );
  // The CSS custom-property taint crosses package boundaries — the token
  // literal, the merge and the enumeration each live in a different package —
  // so it cannot be cached per package and runs once over the whole graph.
  const [appRuntimeUsage, cssVariables] = await Promise.all([
    analyzeRuntimeUsage(appRuntimeFiles, input.protocolHelpers),
    analyzeCssVariableProtocol(
      input.materialized.modules.map((module) => module.filePath).sort(),
    ),
  ]);
  const cacheStats = {
    hits: 0,
    misses: 0,
  };
  const packageHazards = await runWithConcurrency(
    [...dependencyFilesByPackage.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
    8,
    async ([packageName, filePaths]) => {
      const hazards = await loadCachedPackageRuntimeHazards({
        cacheRoot,
        filePaths,
        packageName,
        packageSignature,
        protocolHelpers: input.protocolHelpers,
      });
      if (hazards.cacheHit) {
        cacheStats.hits += 1;
      } else {
        cacheStats.misses += 1;
      }
      return hazards.value;
    },
  );

  const runtimeUsage = mergeRuntimeHazards(appRuntimeUsage, ...packageHazards);
  for (const member of cssVariables.keyNames) {
    runtimeUsage.cssVariableKeyNames.add(member);
  }
  const appUsage = createEmptyAppUsageMembers();
  const emittedLines = collectRuntimeUsageExternLines(runtimeUsage, appUsage);
  applyPropertyPolicy(emittedLines, propertyPolicy);

  logInternalDetail(
    "vite:extern-package-cache",
    `hits=${cacheStats.hits} misses=${cacheStats.misses} packages=${dependencyFilesByPackage.size}`,
  );
  logInternalDetail(
    "vite:extern-app-usage-members",
    `dot=${appUsage.dotAccessed.size} string=${appUsage.stringLiteralRead.size}`,
  );
  logInternalDetail(
    "vite:extern-hazards",
    `stringDefined=${runtimeUsage.stringDefined.size} dotDefined=${runtimeUsage.dotDefined.size} stringRead=${runtimeUsage.stringLiteralRead.size} protocol=${runtimeUsage.protocolMembers.size} enumeratedKeys=${runtimeUsage.enumeratedKeyNames.size} cssVariableKeys=${runtimeUsage.cssVariableKeyNames.size}`,
  );
  logInternalDetail(
    "vite:extern-css-variable-protocol",
    `names=${cssVariables.keyNames.size} sinks=${cssVariables.sinkSites.length}`,
  );

  const text = renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules: input.modules,
    runtimeEntryFiles: input.materialized.runtimeEntries,
    scannedFiles: [],
  });

  await fs.mkdir(path.dirname(input.generatedExternFile), { recursive: true });
  await writeFileIfChanged(input.generatedExternFile, text);
}

/**
 * Splits a materialized graph into app runtime files and dependency files
 * grouped by the complete sorted contributing-package set. A fused emitted
 * file that several packages produced is analyzed once under that set, not
 * once per package. File lists and package keys are sorted so later analysis
 * walks a stable order regardless of module insertion order.
 */
export function splitRuntimeModules(materialized: MaterializedGraph) {
  const appRuntimeFiles: string[] = [];
  const dependencyFilesByPackage = new Map<string, string[]>();
  for (const module of materialized.modules) {
    if (!isDependencyRuntimeModule(module.sourceModuleIds)) {
      appRuntimeFiles.push(module.filePath);
      continue;
    }
    const packageNames = contributingPackageNames(module.sourceModuleIds);
    const packageKey = packageNames.join("\0");
    const current = dependencyFilesByPackage.get(packageKey);
    if (current) {
      current.push(module.filePath);
    } else {
      dependencyFilesByPackage.set(packageKey, [module.filePath]);
    }
  }
  const uniqueAppRuntimeFiles = [...new Set(appRuntimeFiles)].sort(
    (left, right) => left.localeCompare(right),
  );
  for (const [packageKey, filePaths] of dependencyFilesByPackage) {
    dependencyFilesByPackage.set(
      packageKey,
      [...new Set(filePaths)].sort((left, right) => left.localeCompare(right)),
    );
  }
  return {
    appRuntimeFiles: uniqueAppRuntimeFiles,
    dependencyFilesByPackage,
  };
}

function contributingPackageNames(sourceModuleIds: string[]) {
  return [
    ...new Set(
      sourceModuleIds
        .map((moduleId) => classifyModuleId(moduleId))
        .filter((packageName) => packageName !== "app"),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function isDependencyRuntimeModule(sourceModuleIds: string[]) {
  return (
    sourceModuleIds.length > 0 &&
    sourceModuleIds.every((moduleId) =>
      stripQuery(moduleId).includes(`${path.sep}node_modules${path.sep}`),
    )
  );
}
