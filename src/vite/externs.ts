import fs from "node:fs/promises";
import path from "node:path";

import ts from "@typescript/typescript6";

import { DEFAULT_BUILD_OPTIONS } from "../api/types";
import { generateExterns } from "../api/build";
import { analyzeCssVariableProtocol } from "../externs/css-variable-protocol";
import { collectRuntimeUsageExternLines } from "../externs/render";
import type { AppUsageMembers } from "../externs/render";
import { classifyModuleId, stripQuery } from "./capture";
import {
  analyzeRuntimeUsage,
  createKeyNameReader,
  mergeRuntimeHazards,
} from "../externs/runtime-analysis";
import type { RuntimeRenameHazards } from "../externs/runtime-analysis";
import { isRuntimeExternPropertyName } from "../externs/shared";
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

export interface CompilerExternArtifacts {
  renameBarriers: string[];
  typedDeclarations: string[];
}

type CachedRuntimeHazards = {
  [Key in keyof RuntimeRenameHazards]: string[];
};

// v3: hazard payload split into evidence classes (see externs/render.ts).
// v5: runtime hazards gained `constructedKeyFragments`.
// v6: runtime hazards gained `selfReferentialKeys`.
// v7: runtime hazards gained `enumeratedKeyNames`.
// v8: `enumeratedKeyNames` resolves const-bound lists and element transforms.
// v9: hyphenated keys also record their underscored identifier alias.
// v10: runtime hazards gained `cssVariableKeyNames`.
// v11: key reads resolve const-bound string literals (`const K = "x"; K in o`).
// v12: element-name keys in selector position of a tainted style object.
const VITE_EXTERN_PACKAGE_CACHE_VERSION = 12;

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
  const explicitTypedExterns = [
    ...(input.options.compiler?.typedExterns ?? []),
  ].map((filePath) => path.resolve(input.projectRoot, filePath));
  const generateOptions = input.options.externs?.generate;
  if (!generateOptions) {
    return {
      renameBarriers: explicitExterns,
      typedDeclarations: explicitTypedExterns,
    } satisfies CompilerExternArtifacts;
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
    const result = await generateExterns({
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
    for (const warning of result.barrierWarnings) {
      console.warn(`gcc-ts-bundler: ${warning.message}`);
    }
    if (result.typedDeclarations.moduleExports.length > 0) {
      throw new Error(
        "Vite-generated external-runtime declarations require a compiled runtime bridge, which the Vite integration does not provide. Generate them separately and add the declaration file through compiler.typedExterns only after supplying that bridge.",
      );
    }
  }

  const appendLines = generateOptions.appendLines ?? [];
  if (appendLines.length > 0) {
    const currentText = await fs.readFile(generatedExternFile, "utf8");
    const appendedText = `${currentText.replace(/\s*$/u, "\n")}${appendLines.join("\n")}\n`;
    await writeFileIfChanged(generatedExternFile, appendedText);
  }

  return {
    renameBarriers: [...new Set([...explicitExterns, generatedExternFile])],
    typedDeclarations: [...new Set(explicitTypedExterns)],
  } satisfies CompilerExternArtifacts;
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
  // The CSS custom-property taint crosses package boundaries — the token
  // literal, the merge and the enumeration each live in a different package —
  // so it cannot be cached per package and runs once over the whole graph.
  const cssVariablePromise = analyzeCssVariableProtocol(
    postPrebundle.modules.map((module) => module.filePath),
  );
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

  const cssVariables = await cssVariablePromise;
  const runtimeUsage = mergeRuntimeHazards(
    await appRuntimeUsagePromise,
    ...packageHazards,
  );
  for (const member of cssVariables.keyNames) {
    runtimeUsage.cssVariableKeyNames.add(member);
  }
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
    `stringDefined=${runtimeUsage.stringDefined.size} dotDefined=${runtimeUsage.dotDefined.size} stringRead=${runtimeUsage.stringLiteralRead.size} protocol=${runtimeUsage.protocolMembers.size} enumeratedKeys=${runtimeUsage.enumeratedKeyNames.size} cssVariableKeys=${runtimeUsage.cssVariableKeyNames.size}`,
  );
  logInternalDetail(
    "vite:extern-css-variable-protocol",
    `names=${cssVariables.keyNames.size} sinks=${cssVariables.sinkSites.length}`,
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
    const readKeyName = createKeyNameReader(sourceFile);
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node)) {
        add(dotAccessed, node.name.text);
      } else if (ts.isElementAccessExpression(node)) {
        add(stringLiteralRead, readKeyName(node.argumentExpression));
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InKeyword
      ) {
        add(stringLiteralRead, readKeyName(node.left));
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return { dotAccessed, stringLiteralRead };
}

const isCachedRuntimeHazards = isObjectOf<CachedRuntimeHazards>({
  constructedKeyFragments: isStringArray,
  constructedKeyPrefixes: isStringArray,
  cssVariableKeyNames: isStringArray,
  dotAccessed: isStringArray,
  dotDefined: isStringArray,
  enumeratedKeyNames: isStringArray,
  protocolMembers: isStringArray,
  selfReferentialKeys: isStringArray,
  stringDefined: isStringArray,
  stringLiteralRead: isStringArray,
});

function serializeRuntimeHazards(
  hazards: RuntimeRenameHazards,
): CachedRuntimeHazards {
  const sorted = (values: ReadonlySet<string>) =>
    [...values].sort((left, right) => left.localeCompare(right));
  return {
    constructedKeyFragments: sorted(hazards.constructedKeyFragments),
    constructedKeyPrefixes: sorted(hazards.constructedKeyPrefixes),
    cssVariableKeyNames: sorted(hazards.cssVariableKeyNames),
    dotAccessed: sorted(hazards.dotAccessed),
    dotDefined: sorted(hazards.dotDefined),
    enumeratedKeyNames: sorted(hazards.enumeratedKeyNames),
    protocolMembers: sorted(hazards.protocolMembers),
    selfReferentialKeys: sorted(hazards.selfReferentialKeys),
    stringDefined: sorted(hazards.stringDefined),
    stringLiteralRead: sorted(hazards.stringLiteralRead),
  };
}

function toRuntimeHazards(hazards: CachedRuntimeHazards): RuntimeRenameHazards {
  return {
    constructedKeyFragments: new Set(hazards.constructedKeyFragments),
    constructedKeyPrefixes: new Set(hazards.constructedKeyPrefixes),
    cssVariableKeyNames: new Set(hazards.cssVariableKeyNames),
    dotAccessed: new Set(hazards.dotAccessed),
    dotDefined: new Set(hazards.dotDefined),
    enumeratedKeyNames: new Set(hazards.enumeratedKeyNames),
    protocolMembers: new Set(hazards.protocolMembers),
    selfReferentialKeys: new Set(hazards.selfReferentialKeys),
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
