import fs from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import { generateExterns } from "../api/build";
import { collectRuntimeUsageExternLines } from "../externs/render";
import type { AppUsageMembers } from "../externs/render";
import { classifyModuleId, stripQuery } from "./capture";
import {
  analyzeRuntimeUsage,
  mergeRuntimeHazards
} from "../externs/runtime-analysis";
import type { RuntimeRenameHazards ,
  RUNTIME_HAZARD_KEYS} from "../externs/runtime-analysis";
import {
  getStringLiteralMemberName,
  isRuntimeExternPropertyName,
} from "../externs/shared";
import {
  getDefaultPersistentCacheRoot,
  readJsonIfExists,
  writeJson,
} from "../shared/cache-store";
import { hashJson } from "../shared/hash";
import { hashFileInput, writeFileIfChanged } from "../shared/files";
import { logInternalDetail } from "../shared/timing";
import { isObjectOf, isStringArray } from "../shared/validation";
import { getPackageSignature } from "../build/resolve/signatures";
import type { GccTsBundlerVitePluginOptions } from "./types";
import type { MaterializedGraph } from "./internal-types";

type CachedRuntimeHazards = Record<
  (typeof RUNTIME_HAZARD_KEYS)[number],
  string[]
>;

// v3: hazard payload split into evidence classes (see externs/render.ts).
const VITE_EXTERN_PACKAGE_CACHE_VERSION = 3;

export async function resolveCompilerExterns(input: {
  captureRoot: string;
  materialized: MaterializedGraph;
  options: GccTsBundlerVitePluginOptions;
  /**
   * The graph Closure actually compiles. Dependency hazards must be read from
   * here: esbuild's class-field lowering is what *creates* the string-keyed
   * definitions (`__publicField(this, "name")`), so they do not exist yet in
   * the pre-prebundle graph. Kept as a promise so the app-side scans still run
   * concurrently with prebundling.
   */
  postPrebundleMaterialized: Promise<MaterializedGraph>;
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

  const protocolHelpers = {
    keyExclusionListCallees: [
      ...(generateOptions.protocolHelpers?.keyExclusionListCallees ?? []),
    ],
    keyReadCallees: [
      ...(generateOptions.protocolHelpers?.keyReadCallees ?? []),
    ],
  };
  if ((generateOptions.mode ?? "runtime-aware") === "runtime-aware") {
    await generateViteRuntimeAwareExterns({
      captureRoot: input.captureRoot,
      generatedExternFile,
      includeDependencies: generateOptions.includeDependencies,
      materialized: input.materialized,
      modules: [...generateOptions.modules],
      options: input.options,
      postPrebundleMaterialized: input.postPrebundleMaterialized,
      projectRoot: input.projectRoot,
      protocolHelpers,
    });
  } else {
    await generateExterns({
      appEntryFiles: input.materialized.entries,
      includeDependencies: generateOptions.includeDependencies,
      mode: generateOptions.mode ?? "runtime-aware",
      modules: [...generateOptions.modules],
      outputFile: generatedExternFile,
      projectRoot: input.projectRoot,
      protocolHelpers,
      runtimeEntryFiles: input.materialized.runtimeEntries,
      srcDir: input.materialized.srcDir,
    });
  }

  const appendLines = generateOptions.appendLines ?? [];
  if (appendLines.length > 0) {
    const currentText = await fs.readFile(generatedExternFile, "utf8");
    const appendedText = `${currentText.replace(/\s*$/u, "\n")}${appendLines.join("\n")}\n`;
    await writeFileIfChanged(generatedExternFile, appendedText);
  }

  return [...new Set([...explicitExterns, generatedExternFile])];
}

async function generateViteRuntimeAwareExterns(input: {
  captureRoot: string;
  generatedExternFile: string;
  includeDependencies: boolean | undefined;
  materialized: MaterializedGraph;
  modules: string[];
  options: GccTsBundlerVitePluginOptions;
  postPrebundleMaterialized: Promise<MaterializedGraph>;
  projectRoot: string;
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

  // App-side scans read the pre-prebundle graph and start immediately, so they
  // overlap with prebundling; only the dependency scan waits for it.
  const appUsagePromise = analyzeJsUsageMembers(
    input.materialized.authoredFiles,
  );
  const appRuntimeUsagePromise = analyzeRuntimeUsage(
    splitRuntimeModules(input.materialized).appRuntimeFiles,
    input.protocolHelpers,
  );

  const postPrebundle = await input.postPrebundleMaterialized;
  const { dependencyFilesByPackage } = splitRuntimeModules(postPrebundle);
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
          protocolHelpers: input.protocolHelpers,
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

  const runtimeUsage = mergeRuntimeHazards(
    await appRuntimeUsagePromise,
    ...packageHazards,
  );
  const appUsage = await appUsagePromise;
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
    `stringDefined=${runtimeUsage.stringDefined.size} dotDefined=${runtimeUsage.dotDefined.size} stringRead=${runtimeUsage.stringLiteralRead.size} protocol=${runtimeUsage.protocolMembers.size}`,
  );

  const text = [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${input.modules.join(", ")}`,
    "// Mode: runtime-aware",
    `// Scanned 0 type files and ${postPrebundle.runtimeEntries.length} runtime file${postPrebundle.runtimeEntries.length === 1 ? "" : "s"}.`,
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
  protocolHelpers: {
    keyExclusionListCallees: string[];
    keyReadCallees: string[];
  };
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
    protocolHelpers: input.protocolHelpers,
  });
  const cacheFile = path.join(input.cacheRoot, `${cacheKey}.json`);
  const cached = await readJsonIfExists(cacheFile, isCachedRuntimeHazards);
  if (cached) {
    return {
      cacheHit: true,
      value: toRuntimeHazards(cached),
    };
  }

  const analyzed = await analyzeRuntimeUsage(
    input.filePaths,
    input.protocolHelpers,
  );
  const serialized = serializeRuntimeHazards(analyzed);
  await writeJson(cacheFile, serialized);
  return {
    cacheHit: false,
    value: analyzed,
  };
}

/**
 * Splits a materialized graph into app runtime files and dependency files
 * grouped by package. Used twice with different graphs: the pre-prebundle one
 * for app scans, the post-prebundle one for dependency hazards.
 */
function splitRuntimeModules(materialized: MaterializedGraph) {
  const appRuntimeFiles: string[] = [];
  const dependencyFilesByPackage = new Map<string, string[]>();
  for (const module of materialized.modules) {
    if (!isDependencyRuntimeModule(module.sourceModuleIds)) {
      appRuntimeFiles.push(module.filePath);
      continue;
    }
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
  }
  return { appRuntimeFiles, dependencyFilesByPackage };
}

/**
 * How authored app code reads members, split by syntax: a dot read renames
 * with a dot definition, a literal string read does not.
 */
async function analyzeJsUsageMembers(
  filePaths: string[],
): Promise<AppUsageMembers> {
  const dotAccessed = new Set<string>();
  const stringLiteralRead = new Set<string>();

  for (const filePath of filePaths) {
    const sourceText = await fs.readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const add = (target: Set<string>, memberName: string | null) => {
      if (memberName && isRuntimeExternPropertyName(memberName)) {
        target.add(memberName);
      }
    };
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        add(dotAccessed, node.name.text);
      } else if (ts.isElementAccessExpression(node)) {
        add(
          stringLiteralRead,
          getStringLiteralMemberName(node.argumentExpression),
        );
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      ) {
        add(stringLiteralRead, getStringLiteralMemberName(node.left));
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { dotAccessed, stringLiteralRead };
}

const isCachedRuntimeHazards = isObjectOf<CachedRuntimeHazards>({
  dotAccessed: isStringArray,
  dotDefined: isStringArray,
  protocolMembers: isStringArray,
  stringDefined: isStringArray,
  stringLiteralRead: isStringArray,
});

function serializeRuntimeHazards(
  hazards: RuntimeRenameHazards,
): CachedRuntimeHazards {
  const sorted = (values: ReadonlySet<string>) =>
    [...values].sort((left, right) => left.localeCompare(right));
  return {
    dotAccessed: sorted(hazards.dotAccessed),
    dotDefined: sorted(hazards.dotDefined),
    protocolMembers: sorted(hazards.protocolMembers),
    stringDefined: sorted(hazards.stringDefined),
    stringLiteralRead: sorted(hazards.stringLiteralRead),
  };
}

function toRuntimeHazards(hazards: CachedRuntimeHazards): RuntimeRenameHazards {
  return {
    dotAccessed: new Set(hazards.dotAccessed),
    dotDefined: new Set(hazards.dotDefined),
    protocolMembers: new Set(hazards.protocolMembers),
    stringDefined: new Set(hazards.stringDefined),
    stringLiteralRead: new Set(hazards.stringLiteralRead),
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

function isDependencyModuleId(moduleId: string) {
  return stripQuery(moduleId).includes(`${path.sep}node_modules${path.sep}`);
}

function isDependencyRuntimeModule(sourceModuleIds: string[]) {
  return (
    sourceModuleIds.length > 0 &&
    sourceModuleIds.every((moduleId) => isDependencyModuleId(moduleId))
  );
}
