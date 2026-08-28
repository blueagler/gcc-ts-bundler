import fs from "node:fs/promises";
import path from "node:path";

import { getPackageSignature } from "../../build/resolve/signatures";
import { analyzeCssVariableProtocol } from "../../externs/css-variable-protocol";
import {
  collectRuntimeUsageExternLines,
  createEmptyAppUsageMembers,
  renderExternText,
} from "../../externs/render";
import {
  analyzeRuntimeUsage,
  mergeRuntimeHazards,
} from "../../externs/runtime";
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
  postPrebundleMaterialized: Promise<MaterializedGraph>;
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
}) {
  const packageSignature = await getPackageSignature();
  const cacheRoot = resolvePackageExternCacheRoot({
    captureRoot: input.captureRoot,
    options: input.options,
  });
  await fs.mkdir(cacheRoot, { recursive: true });
  // Every scan reads the post-prebundle graph, and none of them may start
  // before it resolves. Prebundling rewrites authored and direct-dependency
  // modules *in place* (`prebundle/direct-esm/rewrite.ts`), so an app-side scan
  // overlapping it read pre-rewrite text on one build and post-rewrite text on
  // the next, purely on interleaving. That made `generated.externs.js` unstable
  // between a cold build and its first rebuild, and the extern file is a
  // cache-key input for the resolve snapshot, native emit and Closure — so the
  // first rebuild paid a full recompile it had already earned. The rewritten
  // text is also the only text that matters: it is what Closure compiles.
  const postPrebundle = await input.postPrebundleMaterialized;
  const { appRuntimeFiles, dependencyFilesByPackage } =
    splitRuntimeModules(postPrebundle);
  const appRuntimeUsagePromise = analyzeRuntimeUsage(
    appRuntimeFiles,
    input.protocolHelpers,
  );
  // The CSS custom-property taint crosses package boundaries — the token
  // literal, the merge and the enumeration each live in a different package —
  // so it cannot be cached per package and runs once over the whole graph.
  const cssVariablePromise = analyzeCssVariableProtocol(
    [...postPrebundle.modules.map((module) => module.filePath)].sort(),
  );
  const cacheStats = {
    hits: 0,
    misses: 0,
  };
  const packageHazards = await Promise.all(
    [...dependencyFilesByPackage.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(async ([packageName, filePaths]) => {
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
      }),
  );

  const cssVariables = await cssVariablePromise;
  const runtimeUsage = mergeRuntimeHazards(
    await appRuntimeUsagePromise,
    ...packageHazards,
  );
  for (const member of cssVariables.keyNames) {
    runtimeUsage.cssVariableKeyNames.add(member);
  }
  const appUsage = createEmptyAppUsageMembers();
  const emittedLines = collectRuntimeUsageExternLines(runtimeUsage, appUsage);

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
    runtimeEntryFiles: postPrebundle.runtimeEntries,
    scannedFiles: [],
  });

  await fs.mkdir(path.dirname(input.generatedExternFile), { recursive: true });
  await writeFileIfChanged(input.generatedExternFile, text);
}

/**
 * Splits a materialized graph into app runtime files and dependency files
 * grouped by package. File lists and package keys are sorted so later
 * analysis walks a stable order regardless of module insertion order.
 */
function splitRuntimeModules(materialized: MaterializedGraph) {
  const appRuntimeFiles: string[] = [];
  const dependencyFilesByPackage = new Map<string, string[]>();
  for (const module of materialized.modules) {
    if (!isDependencyRuntimeModule(module.sourceModuleIds)) {
      appRuntimeFiles.push(module.filePath);
      continue;
    }
    const packageNames = [
      ...new Set(
        module.sourceModuleIds
          .map((moduleId) => classifyModuleId(moduleId))
          .filter((packageName) => packageName !== "app"),
      ),
    ].sort();
    for (const packageName of packageNames) {
      const current = dependencyFilesByPackage.get(packageName);
      if (current) {
        current.push(module.filePath);
      } else {
        dependencyFilesByPackage.set(packageName, [module.filePath]);
      }
    }
  }
  appRuntimeFiles.sort();
  for (const filePaths of dependencyFilesByPackage.values()) {
    filePaths.sort();
  }
  return { appRuntimeFiles, dependencyFilesByPackage };
}

function isDependencyRuntimeModule(sourceModuleIds: string[]) {
  return (
    sourceModuleIds.length > 0 &&
    sourceModuleIds.every((moduleId) =>
      stripQuery(moduleId).includes(`${path.sep}node_modules${path.sep}`),
    )
  );
}
