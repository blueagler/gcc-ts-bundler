import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import { generateExterns } from "../api/build";
import { analyzeRuntimeUsage } from "../api/externs/runtime-analysis";
import {
  getStringLiteralMemberName,
  isRuntimeExternPropertyName,
  renderStructuralExternLine,
} from "../api/externs/shared";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../cache/store";
import { hashJson } from "../cache/hash";
import { hashFileInput, writeFileIfChanged } from "../internal/files";
import { logInternalDetail } from "../internal/timing";
import { getPackageSignature } from "../pipeline/resolve-build/signatures";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type { MaterializedGraph } from "./internal-types";

interface CachedRuntimeHazards {
  accessedMembers: string[];
  definedMembers: string[];
  protocolMembers: string[];
}

const VITE_EXTERN_PACKAGE_CACHE_VERSION = 2;

export async function resolveCompilerExterns(input: {
  captureRoot: string;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  const explicitExterns = [...(input.options.compiler?.externs ?? [])].map(
    (filePath) => path.resolve(input.projectRoot, filePath),
  );
  const generateOptions = input.options.externs?.generate;
  if (!generateOptions) {
    return explicitExterns;
  }

  const generatedExternFile = path.resolve(
    input.projectRoot,
    generateOptions.outputFile ??
      path.join(input.captureRoot, "generated.externs.js"),
  );

  if ((generateOptions.mode ?? "runtime-aware") === "runtime-aware") {
    await generateViteRuntimeAwareExterns({
      captureRoot: input.captureRoot,
      generatedExternFile,
      includeDependencies: generateOptions.includeDependencies,
      materialized: input.materialized,
      modules: [...generateOptions.modules],
      options: input.options,
      projectRoot: input.projectRoot,
    });
  } else {
    await generateExterns({
      appEntryFiles: input.materialized.entries,
      includeDependencies: generateOptions.includeDependencies,
      mode: generateOptions.mode ?? "runtime-aware",
      modules: [...generateOptions.modules],
      outputFile: generatedExternFile,
      projectRoot: input.projectRoot,
      runtimeEntryFiles: input.materialized.runtimeEntries,
      srcDir: input.materialized.srcDir,
    });
  }

  if ((generateOptions.appendLines?.length ?? 0) > 0) {
    const currentText = await fs.readFile(generatedExternFile, "utf8");
    const appendedText = `${currentText.replace(/\s*$/u, "\n")}${generateOptions.appendLines!.join("\n")}\n`;
    await writeFileIfChanged(generatedExternFile, appendedText);
  }

  return [...new Set([...explicitExterns, generatedExternFile])];
}

async function generateViteRuntimeAwareExterns(input: {
  captureRoot: string;
  generatedExternFile: string;
  includeDependencies?: boolean;
  materialized: MaterializedGraph;
  modules: string[];
  options: GccTsBundlerVitePluginOptions;
  projectRoot: string;
}) {
  const packageSignature = await getPackageSignature();
  const cacheRoot = resolvePackageExternCacheRoot({
    captureRoot: input.captureRoot,
    options: input.options,
  });
  await fs.mkdir(cacheRoot, { recursive: true });

  const appRuntimeFiles: string[] = [];
  const dependencyFilesByPackage = new Map<string, string[]>();
  for (const module of input.materialized.modules) {
    if (isDependencyRuntimeModule(module.sourceModuleIds)) {
      const packageNames = new Set(
        module.sourceModuleIds
          .map((moduleId) => classifyModuleId(moduleId))
          .filter((packageName) => packageName !== "app"),
      );
      for (const packageName of packageNames) {
        const current = dependencyFilesByPackage.get(packageName);
        if (current) {
          current.push(module.filePath);
        } else {
          dependencyFilesByPackage.set(packageName, [module.filePath]);
        }
      }
      continue;
    }
    appRuntimeFiles.push(module.filePath);
  }

  const appUsageMembers = await analyzeJsUsageMembers(
    input.materialized.authoredFiles,
  );
  const appRuntimeUsage = await analyzeRuntimeUsage(appRuntimeFiles);
  const cacheStats = {
    hits: 0,
    misses: 0,
  };
  const packageHazards = await Promise.all(
    [...dependencyFilesByPackage.entries()].map(
      async ([packageName, filePaths]) => {
        const hazards = await loadCachedPackageRuntimeHazards({
          cacheRoot,
          filePaths,
          includeDependencies: input.includeDependencies ?? true,
          packageName,
          packageSignature,
        });
        if (hazards.cacheHit) {
          cacheStats.hits += 1;
        } else {
          cacheStats.misses += 1;
        }
        return hazards.value;
      },
    ),
  );

  const runtimeUsage = mergeRuntimeHazards(appRuntimeUsage, ...packageHazards);
  const emittedLines = new Set<string>();
  for (const member of runtimeUsage.protocolMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  for (const member of runtimeUsage.definedMembers) {
    if (
      runtimeUsage.accessedMembers.has(member) ||
      appUsageMembers.has(member)
    ) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }

  logInternalDetail(
    "vite:extern-package-cache",
    `hits=${cacheStats.hits} misses=${cacheStats.misses} packages=${dependencyFilesByPackage.size}`,
  );
  logInternalDetail("vite:extern-app-usage-members", `${appUsageMembers.size}`);

  const text = [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${input.modules.join(", ")}`,
    "// Mode: runtime-aware",
    `// Scanned 0 type files and ${input.materialized.runtimeEntries.length} runtime file${input.materialized.runtimeEntries.length === 1 ? "" : "s"}.`,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    "",
  ].join("\n");

  await fs.mkdir(path.dirname(input.generatedExternFile), { recursive: true });
  await writeFileIfChanged(input.generatedExternFile, text);
}

async function loadCachedPackageRuntimeHazards(input: {
  cacheRoot: string;
  filePaths: string[];
  includeDependencies: boolean;
  packageName: string;
  packageSignature: string;
}) {
  const fileHashes = await Promise.all(
    [...input.filePaths]
      .sort((left, right) => left.localeCompare(right))
      .map((filePath) => hashFileInput(filePath)),
  );
  const cacheKey = hashJson({
    cacheVersion: VITE_EXTERN_PACKAGE_CACHE_VERSION,
    fileHashes,
    includeDependencies: input.includeDependencies,
    mode: "runtime-aware",
    packageName: input.packageName,
    packageSignature: input.packageSignature,
  });
  const cacheFile = path.join(input.cacheRoot, `${cacheKey}.json`);
  const cached = await readJsonIfExists<CachedRuntimeHazards>(cacheFile);
  if (cached) {
    return {
      cacheHit: true,
      value: toRuntimeHazards(cached),
    };
  }

  const analyzed = await analyzeRuntimeUsage(input.filePaths);
  const serialized = serializeRuntimeHazards(analyzed);
  await writeJson(cacheFile, serialized);
  return {
    cacheHit: false,
    value: analyzed,
  };
}

async function analyzeJsUsageMembers(filePaths: string[]) {
  const members = new Set<string>();

  for (const filePath of filePaths) {
    const sourceText = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        if (isRuntimeExternPropertyName(node.name.text)) {
          members.add(node.name.text);
        }
      } else if (ts.isElementAccessExpression(node)) {
        const memberName = getStringLiteralMemberName(node.argumentExpression);
        if (memberName && isRuntimeExternPropertyName(memberName)) {
          members.add(memberName);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return members;
}

function mergeRuntimeHazards(
  ...hazardsList: Array<Awaited<ReturnType<typeof analyzeRuntimeUsage>>>
) {
  const merged = {
    accessedMembers: new Set<string>(),
    definedMembers: new Set<string>(),
    protocolMembers: new Set<string>(),
  };

  for (const hazards of hazardsList) {
    for (const member of hazards.accessedMembers) {
      merged.accessedMembers.add(member);
    }
    for (const member of hazards.definedMembers) {
      merged.definedMembers.add(member);
    }
    for (const member of hazards.protocolMembers) {
      merged.protocolMembers.add(member);
    }
  }

  return merged;
}

function serializeRuntimeHazards(
  hazards: Awaited<ReturnType<typeof analyzeRuntimeUsage>>,
): CachedRuntimeHazards {
  return {
    accessedMembers: [...hazards.accessedMembers].sort((left, right) =>
      left.localeCompare(right),
    ),
    definedMembers: [...hazards.definedMembers].sort((left, right) =>
      left.localeCompare(right),
    ),
    protocolMembers: [...hazards.protocolMembers].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

function toRuntimeHazards(hazards: CachedRuntimeHazards) {
  return {
    accessedMembers: new Set(hazards.accessedMembers),
    definedMembers: new Set(hazards.definedMembers),
    protocolMembers: new Set(hazards.protocolMembers),
  };
}

function resolvePackageExternCacheRoot(input: {
  captureRoot: string;
  options: GccTsBundlerVitePluginOptions;
}) {
  const cacheMode =
    input.options.compiler?.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode;
  if (cacheMode === "persistent") {
    return path.join(
      path.resolve(
        input.options.compiler?.cache?.dir ?? getDefaultPersistentCacheRoot(),
      ),
      "vite-extern-package-facts",
    );
  }

  return path.join(input.captureRoot, "vite-extern-package-facts");
}

function classifyModuleId(moduleId: string) {
  const cleanId = stripQuery(moduleId).replace(/\\/g, "/");
  const nodeModulesIndex = cleanId.lastIndexOf("/node_modules/");
  if (nodeModulesIndex < 0) {
    return "app";
  }

  const packagePath = cleanId.slice(nodeModulesIndex + "/node_modules/".length);
  const segments = packagePath.split("/");
  if (segments[0]?.startsWith("@")) {
    return segments.slice(0, 2).join("/");
  }
  return segments[0] || "app";
}

function isDependencyModuleId(moduleId: string) {
  return stripQuery(moduleId).includes(`${path.sep}node_modules${path.sep}`);
}

function isDependencyRuntimeModule(sourceModuleIds: string[]) {
  return (
    sourceModuleIds.length > 0 &&
    sourceModuleIds.every((moduleId) => isDependencyModuleId(moduleId))
  );
}

function stripQuery(id: string) {
  return id.replace(/[?#].*$/u, "");
}
