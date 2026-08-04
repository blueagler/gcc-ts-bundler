import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin } from "esbuild";

import { closureCompilerCapabilities } from "../../native/load";
import { writeJson } from "../../shared/cache-store";
import { syncDirectoryEntries } from "../../shared/files";
import type {
  CapturedRuntimeModule,
  MaterializedGraph,
} from "../internal-types";
import {
  hashTypeMetadataValue,
  parseRuntimeExportGraph,
  shouldBypassTypeMetadataFusion,
  withOneToOneTypeProvenance,
} from "../type-metadata";
import type { PrebundleExportFacade } from "../type-metadata";
import { createBarrelFlattener } from "./barrels";
import { rewriteDirectEsmImports } from "./direct-esm";
import {
  canonicalizeDuplicateLazyEntryOutputs,
  collectCollapsibleBundleEntryOutputs,
  rewriteAuthoredModules,
} from "./entry-outputs";
import { loadEsbuildBuild } from "./esbuild";
import type { EsbuildBuild } from "./esbuild";
import { createModuleParser } from "./parse";
import {
  assignRegionLabels,
  groupBundleRequests,
  renderBundleEntrySource,
  resolveEntryOutputsByRequest,
  sanitizeEntryName,
  sanitizeRegionKey,
} from "./regions";
import type {
  RegionBundleRequest,
  WrittenRegionBundleRequest,
} from "./regions";
import {
  DEP_BUNDLE_INPUT_DIR,
  DEP_BUNDLE_OUTPUT_DIR,
  EAGER_REGION_LABEL,
  hashText,
  normalizePath,
  toPathIndependentKey,
} from "./shared";
import type { ParsedMaterializedModule } from "./shared";

const MATERIALIZED_DEPENDENCY_BUNDLE_MARKER =
  ".gcc-ts-bundler-materialized-dependency-bundles.json";

interface PrebundleContext {
  authoredFiles: Set<string>;
  materialized: MaterializedGraph;
  moduleByFilePath: Map<string, CapturedRuntimeModule>;
  moduleBySourceId: Map<string, CapturedRuntimeModule>;
  parseModule: (filePath: string) => Promise<ParsedMaterializedModule>;
  runtimeSrcDir: string;
}

interface MaterializedDependencyBundleMarker {
  files: Array<{ path: string; sha256: string }>;
  kind: "gcc-ts-bundler-materialized-dependency-bundles";
  version: 1;
}

interface DependencyBundleSet {
  canonicalizedEntryOutputs: Awaited<
    ReturnType<typeof canonicalizeDuplicateLazyEntryOutputs>
  >;
  collapsedEntryOutputByPath: Awaited<
    ReturnType<typeof collectCollapsibleBundleEntryOutputs>
  >;
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
  requestGroupKeyByTarget: Map<string, string>;
  writtenRequests: WrittenRegionBundleRequest[];
}

export async function prebundleMaterializedDependencies(input: {
  dynamicRootModuleIds: string[];
  materialized: MaterializedGraph;
  outputSrcDir?: string;
}): Promise<MaterializedGraph> {
  let context = createPrebundleContext(input);
  // ponytail: preserve the whole graph until symbol-level fusion can keep typed
  // dependency-source bindings exact; narrow this to typed regions when needed.
  if (
    context.materialized.modules.some(
      (module) =>
        !context.authoredFiles.has(normalizePath(module.filePath)) &&
        shouldBypassTypeMetadataFusion(module),
    )
  ) {
    return mirrorGraphWithoutBundles(context);
  }
  const dependencyRouting = await classifyDependencyRouting(context);
  await rewriteDirectEsmImports({
    directDependencyFilePaths: dependencyRouting.directFilePaths,
    materialized: context.materialized,
  });
  context = createPrebundleContext(input);
  const {
    bundleRequests,
    dynamicRootRequestKeyByTargetFilePath,
    regionLabelsByAuthoredFile,
  } = await collectBundleRequests(
    context,
    input.dynamicRootModuleIds,
    dependencyRouting.prebundleFilePaths,
  );
  if (bundleRequests.size === 0) {
    return mirrorGraphWithoutBundles(context);
  }

  const bundles = await buildDependencyBundles(
    context,
    bundleRequests,
    new Set(dynamicRootRequestKeyByTargetFilePath.values()),
  );
  if (!bundles) {
    return context.materialized;
  }

  const authoredEntries = await rewriteAuthoredModules({
    collapsedEntryOutputByPath: bundles.collapsedEntryOutputByPath,
    dynamicRootRequestKeyByTargetFilePath,
    materialized: context.materialized,
    outputByRequestKey: bundles.canonicalizedEntryOutputs.outputByRequestKey,
    regionLabelsByAuthoredFile,
    requestGroupKeyByTarget: bundles.requestGroupKeyByTarget,
    runtimeSrcDir: context.runtimeSrcDir,
  });
  return await assembleGraph(
    context,
    bundles,
    authoredEntries,
    dependencyRouting.directFilePaths,
  );
}

function createMaterializedDependencyResolverPlugin(
  sourceByMaterializedFile: Record<string, string> | undefined,
): Plugin | undefined {
  if (!sourceByMaterializedFile) {
    return undefined;
  }
  const sourceByFile = new Map(
    Object.entries(sourceByMaterializedFile).map(([filePath, sourceFile]) => [
      normalizePath(filePath),
      normalizePath(sourceFile),
    ]),
  );
  if (sourceByFile.size === 0) {
    return undefined;
  }
  const materializedBySourceFile = new Map(
    [...sourceByFile].map(([materializedFile, sourceFile]) => [
      sourceFile,
      materializedFile,
    ]),
  );

  return {
    name: "gcc-ts-bundler-materialized-dependency-resolution",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isBarePackageSpecifier(args.path)) {
          return undefined;
        }
        const sourceFile = sourceByFile.get(normalizePath(args.importer));
        if (!sourceFile) {
          return undefined;
        }
        try {
          const resolvedSourceFile = normalizePath(
            createRequire(sourceFile).resolve(args.path),
          );
          // Keep a dependency already retained by Vite in the same esbuild
          // instance as the graph entry that imported it. Origin-context
          // resolution remains the fallback for true transitives such as
          // react-dom's scheduler under Bun's isolated store.
          return {
            path:
              materializedBySourceFile.get(resolvedSourceFile) ??
              resolvedSourceFile,
          };
        } catch {
          return undefined;
        }
      });
    },
  };
}

async function writeMaterializedDependencyBundleMarker(input: {
  bundleDir: string;
  files: string[];
}) {
  const files = await Promise.all(
    [...new Set(input.files)]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        path: path.relative(input.bundleDir, filePath).replace(/\\/g, "/"),
        sha256: hashText(await fs.readFile(filePath, "utf8")),
      })),
  );
  await writeJson(
    path.join(input.bundleDir, MATERIALIZED_DEPENDENCY_BUNDLE_MARKER),
    {
      files,
      kind: "gcc-ts-bundler-materialized-dependency-bundles",
      version: 1,
    } satisfies MaterializedDependencyBundleMarker,
  );
}

function isBarePackageSpecifier(specifier: string) {
  return (
    !specifier.startsWith(".") &&
    !path.isAbsolute(specifier) &&
    !specifier.includes(":")
  );
}

function createPrebundleContext(input: {
  materialized: MaterializedGraph;
  outputSrcDir?: string | undefined;
}): PrebundleContext {
  const authoredFiles = new Set(
    input.materialized.authoredFiles.map((filePath) => normalizePath(filePath)),
  );
  const moduleByFilePath = new Map(
    input.materialized.modules.map((module) => [
      normalizePath(module.filePath),
      module,
    ]),
  );
  const moduleBySourceId = new Map<string, CapturedRuntimeModule>();
  for (const module of input.materialized.modules) {
    for (const sourceModuleId of module.sourceModuleIds) {
      moduleBySourceId.set(sourceModuleId, module);
    }
  }

  return {
    authoredFiles,
    materialized: input.materialized,
    moduleByFilePath,
    moduleBySourceId,
    parseModule: createModuleParser({
      authoredFiles,
      moduleFilePaths: new Set(moduleByFilePath.keys()),
    }),
    runtimeSrcDir: input.outputSrcDir ?? input.materialized.srcDir,
  };
}

async function collectBundleRequests(
  context: PrebundleContext,
  dynamicRootModuleIds: string[],
  prebundleFilePaths: Set<string>,
) {
  const entryFilePaths = context.materialized.entries.map((entry) =>
    normalizePath(path.resolve(context.materialized.srcDir, entry)),
  );
  const dynamicRootModulesByFilePath = new Map<string, CapturedRuntimeModule>();
  for (const moduleId of dynamicRootModuleIds) {
    const module = context.moduleBySourceId.get(moduleId);
    if (module) {
      dynamicRootModulesByFilePath.set(normalizePath(module.filePath), module);
    }
  }
  const dynamicRootFilePaths = [...dynamicRootModulesByFilePath.keys()]
    .filter((filePath) => context.authoredFiles.has(filePath))
    .sort((left, right) => left.localeCompare(right));

  const regionLabelsByAuthoredFile = await assignRegionLabels({
    authoredFiles: context.authoredFiles,
    dynamicRootFilePaths,
    entryFilePaths,
    parseModule: context.parseModule,
  });

  const bundleRequests = new Map<string, RegionBundleRequest>();
  for (const filePath of context.materialized.authoredFiles) {
    const normalizedFilePath = normalizePath(filePath);
    const regionKey = regionLabelsByAuthoredFile.get(normalizedFilePath);
    if (!regionKey) {
      continue;
    }

    const parsed = await context.parseModule(normalizedFilePath);
    for (const dependencyImport of parsed.dependencyImports) {
      const targetModule = context.moduleByFilePath.get(
        normalizePath(dependencyImport.targetFilePath),
      );
      if (
        !targetModule ||
        !prebundleFilePaths.has(normalizePath(targetModule.filePath))
      ) {
        continue;
      }

      const requestKey = `${regionKey}\u0000${normalizePath(targetModule.filePath)}`;
      const existing = bundleRequests.get(requestKey);
      if (existing) {
        existing.needsDefault ||= dependencyImport.hasDefault;
        existing.needsExportAll ||= dependencyImport.hasNamespace;
        existing.needsSideEffectOnly ||= dependencyImport.isSideEffectOnly;
        for (const namedExport of dependencyImport.namedExports) {
          existing.usedNamedExports.add(namedExport);
        }
        continue;
      }

      const parsedTarget = await context.parseModule(targetModule.filePath);
      bundleRequests.set(requestKey, {
        exportedNames: parsedTarget.exportedNames,
        hasDefaultExport: parsedTarget.hasDefaultExport,
        needsDefault: dependencyImport.hasDefault,
        needsExportAll: dependencyImport.hasNamespace,
        needsSideEffectOnly: dependencyImport.isSideEffectOnly,
        regionKey,
        sourceModuleIds: [...targetModule.sourceModuleIds],
        targetFilePath: normalizePath(targetModule.filePath),
        targetModule,
        usedNamedExports: new Set(dependencyImport.namedExports),
      });
    }
  }

  const dynamicRootRequestKeyByTargetFilePath = new Map<string, string>();
  for (const [targetFilePath, targetModule] of [
    ...dynamicRootModulesByFilePath.entries(),
  ].sort(([left], [right]) => left.localeCompare(right))) {
    if (
      context.authoredFiles.has(targetFilePath) ||
      !prebundleFilePaths.has(targetFilePath)
    ) {
      continue;
    }
    const regionKey = `dynamic:${targetFilePath}`;
    const requestKey = `${regionKey}\u0000${targetFilePath}`;
    const parsedTarget = await context.parseModule(targetFilePath);
    bundleRequests.set(requestKey, {
      exportedNames: parsedTarget.exportedNames,
      hasDefaultExport: parsedTarget.hasDefaultExport,
      needsDefault: parsedTarget.hasDefaultExport,
      needsExportAll: true,
      needsSideEffectOnly: false,
      regionKey,
      sourceModuleIds: [...targetModule.sourceModuleIds],
      targetFilePath,
      targetModule,
      usedNamedExports: new Set<string>(),
    });
    dynamicRootRequestKeyByTargetFilePath.set(targetFilePath, requestKey);
  }

  return {
    bundleRequests,
    dynamicRootRequestKeyByTargetFilePath,
    regionLabelsByAuthoredFile,
  };
}

async function classifyDependencyRouting(context: PrebundleContext) {
  const dependencyFilePaths = new Set(
    context.materialized.modules
      .map((module) => normalizePath(module.filePath))
      .filter((filePath) => !context.authoredFiles.has(filePath)),
  );
  const adjacentFilePaths = new Map<string, Set<string>>(
    [...dependencyFilePaths].map((filePath) => [filePath, new Set<string>()]),
  );
  const unsafeFilePaths = new Set<string>();

  for (const filePath of dependencyFilePaths) {
    const module = context.moduleByFilePath.get(filePath);
    if (
      !module ||
      module.format !== "esm" ||
      module.requiresDependencyPrebundle !== false
    ) {
      unsafeFilePaths.add(filePath);
    }
    const parsed = await context.parseModule(filePath);
    if (parsed.staticAuthoredImports.length > 0) {
      unsafeFilePaths.add(filePath);
    }
    for (const targetFilePath of parsed.dependencyFilePaths) {
      const normalizedTarget = normalizePath(targetFilePath);
      if (!dependencyFilePaths.has(normalizedTarget)) {
        unsafeFilePaths.add(filePath);
        continue;
      }
      adjacentFilePaths.get(filePath)?.add(normalizedTarget);
      adjacentFilePaths.get(normalizedTarget)?.add(filePath);
    }
  }

  const directFilePaths = new Set<string>();
  const prebundleFilePaths = new Set<string>();
  const visited = new Set<string>();
  for (const rootFilePath of [...dependencyFilePaths].sort((left, right) =>
    left.localeCompare(right),
  )) {
    if (visited.has(rootFilePath)) {
      continue;
    }
    const component = new Set<string>();
    const pending = [rootFilePath];
    let isEsmClean = true;
    while (pending.length > 0) {
      const filePath = pending.pop();
      if (!filePath || visited.has(filePath)) {
        continue;
      }
      visited.add(filePath);
      component.add(filePath);
      isEsmClean &&= !unsafeFilePaths.has(filePath);
      pending.push(...(adjacentFilePaths.get(filePath) ?? []));
    }
    // A one-file package gives no graph evidence that it is source-granular;
    // treat it as a potentially fused distribution artifact and fail closed.
    const destination =
      isEsmClean && component.size > 1 ? directFilePaths : prebundleFilePaths;
    for (const filePath of component) {
      destination.add(filePath);
    }
  }

  return { directFilePaths, prebundleFilePaths };
}

/** No dependency bundles: mirror the graph into the runtime dir unchanged. */
async function mirrorGraphWithoutBundles(
  context: PrebundleContext,
): Promise<MaterializedGraph> {
  const { materialized, runtimeSrcDir } = context;
  if (runtimeSrcDir === materialized.srcDir) {
    return {
      ...materialized,
      modules: materialized.modules.map(withOneToOneTypeProvenance),
    };
  }
  const runtimeEntries = await Promise.all(
    [
      ...new Set(
        materialized.modules.map((module) => normalizePath(module.filePath)),
      ),
    ]
      .sort((left, right) => left.localeCompare(right))
      .map(async (filePath) => ({
        content: await fs.readFile(filePath, "utf8"),
        relativePath: path
          .relative(materialized.srcDir, filePath)
          .replace(/\\/g, "/"),
      })),
  );
  await syncDirectoryEntries(runtimeSrcDir, runtimeEntries);
  return {
    ...materialized,
    authoredFiles: materialized.authoredFiles
      .map((filePath) =>
        normalizePath(
          path.join(
            runtimeSrcDir,
            path.relative(materialized.srcDir, filePath),
          ),
        ),
      )
      .sort((left, right) => left.localeCompare(right)),
    modules: materialized.modules.map((module) =>
      withOneToOneTypeProvenance(
        remapRuntimeModuleToSrcDir(module, materialized.srcDir, runtimeSrcDir),
      ),
    ),
    srcDir: runtimeSrcDir,
  };
}

/** Write region entries, bundle them with esbuild, and stage the outputs. */
async function buildDependencyBundles(
  context: PrebundleContext,
  bundleRequests: Map<string, RegionBundleRequest>,
  preservedRequestKeys: Set<string>,
): Promise<DependencyBundleSet | null> {
  const { materialized, runtimeSrcDir } = context;
  const { groupedRequests, requestGroupKeyByTarget } = groupBundleRequests([
    ...bundleRequests.values(),
  ]);

  const inputDir = path.join(materialized.srcDir, DEP_BUNDLE_INPUT_DIR);
  const outputDir = path.join(runtimeSrcDir, DEP_BUNDLE_OUTPUT_DIR);
  const barrelFlattener = createBarrelFlattener({
    moduleFilePaths: new Set(context.moduleByFilePath.keys()),
  });

  const writtenRequests: WrittenRegionBundleRequest[] = [];
  const inputEntries: Array<{ content: string; relativePath: string }> = [];
  for (const groupedRequest of groupedRequests) {
    const regionDir = path.join(
      inputDir,
      sanitizeRegionKey(
        groupedRequest.requests[0]?.regionKey ?? EAGER_REGION_LABEL,
      ),
    );
    // Hash a srcDir-relative form of the request key: the absolute
    // materialized path must not decide the bundle's output file name, or
    // the same project built from two directories gets different dep-bundle
    // names (and with them different runtime module ids and chunk hashes).
    const fileName = `${sanitizeEntryName(groupedRequest)}-${hashText(
      toPathIndependentKey(groupedRequest.requestKey, materialized.srcDir),
    ).slice(0, 8)}.js`;
    const entryPoint = path.join(regionDir, fileName);
    const renderedEntry = await renderBundleEntrySource({
      entryPoint,
      requests: groupedRequest.requests,
      resolveDeepExport: (targetFilePath, exportName) =>
        process.env["GCC_DISABLE_BARRELS"] === "1"
          ? Promise.resolve(null)
          : barrelFlattener.resolveDeepExport(targetFilePath, exportName),
    });
    inputEntries.push({
      content: renderedEntry,
      relativePath: path.relative(inputDir, entryPoint).replace(/\\/g, "/"),
    });
    writtenRequests.push({
      entryPoint,
      ...groupedRequest,
    });
  }
  await syncDirectoryEntries(inputDir, inputEntries);

  const esbuildBuild = await loadEsbuildBuild();
  const entryPoints = writtenRequests.map((request) =>
    path.relative(materialized.srcDir, request.entryPoint).replace(/\\/g, "/"),
  );
  const bundleResult = await esbuildBuild({
    absWorkingDir: materialized.srcDir,
    bundle: true,
    chunkNames: "chunks/[name]-[hash]",
    entryNames: "[dir]/[name]",
    // Dependencies with dev/prod CJS wrappers (react, react-dom) branch on
    // process.env.NODE_ENV before requiring per-mode files; only the branch
    // Rollup retained is materialized, so the other require target must be
    // eliminated as dead code here rather than resolved.
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        process.env["NODE_ENV"] ?? "production",
      ),
    },
    entryPoints,
    format: "esm",
    logLevel: "silent",
    metafile: true,
    // Without syntax folding, a define-dead branch keeps its text
    // (`if (false) warn(...)`) while tree shaking still drops the declaration
    // it references, which reaches Closure as an undeclared variable. Folding
    // removes the branch instead. Identifiers and whitespace are untouched.
    minifySyntax: true,
    plugins: [
      createMaterializedDependencyResolverPlugin(
        materialized.dependencySourceFileByMaterializedFile,
      ),
    ].filter((plugin): plugin is Plugin => plugin !== undefined),
    outdir: DEP_BUNDLE_OUTPUT_DIR,
    outbase: DEP_BUNDLE_INPUT_DIR,
    platform: "browser",
    splitting: true,
    // The pinned Closure syntax table owns this target. Lowering here (instead
    // of per captured module) keeps one shared set of esbuild helpers across
    // all dependency bundles.
    target: closureCompilerCapabilities().prebundleTarget,
    treeShaking: true,
    write: false,
  });
  const bundleOutputRoot = path.join(
    materialized.srcDir,
    DEP_BUNDLE_OUTPUT_DIR,
  );
  await syncDirectoryEntries(
    outputDir,
    (bundleResult.outputFiles ?? [])
      .filter((outputFile) => outputFile.path.endsWith(".js"))
      .map((outputFile) => ({
        content: outputFile.contents,
        relativePath: path
          .relative(bundleOutputRoot, outputFile.path)
          .replace(/\\/g, "/"),
      })),
    {
      preserve(relativePath) {
        return relativePath.startsWith("shared/");
      },
    },
  );

  const entryOutputByRequestKey = resolveEntryOutputsByRequest({
    bundleSrcDir: materialized.srcDir,
    metafile: bundleResult.metafile,
    outputSrcDir: runtimeSrcDir,
    writtenRequests,
  });
  if (entryOutputByRequestKey.size === 0) {
    return null;
  }

  const canonicalizedEntryOutputs = await canonicalizeDuplicateLazyEntryOutputs(
    {
      entryOutputByRequestKey,
      outputDir,
      outputSrcDir: runtimeSrcDir,
      writtenRequests,
    },
  );

  const preservedEntryOutputPaths = new Set(
    [...preservedRequestKeys]
      .map((requestKey) =>
        canonicalizedEntryOutputs.outputByRequestKey.get(requestKey),
      )
      .filter((filePath): filePath is string => filePath !== undefined),
  );
  const collapsedEntryOutputByPath = await collectCollapsibleBundleEntryOutputs(
    [...new Set(canonicalizedEntryOutputs.outputByRequestKey.values())].filter(
      (filePath) => !preservedEntryOutputPaths.has(filePath),
    ),
  );

  return {
    canonicalizedEntryOutputs,
    collapsedEntryOutputByPath,
    metafile: bundleResult.metafile,
    requestGroupKeyByTarget,
    writtenRequests,
  };
}

/** Merge rewritten authored modules and bundle outputs into the final graph. */
async function assembleGraph(
  context: PrebundleContext,
  bundles: DependencyBundleSet,
  authoredEntries: Array<{ content: string; relativePath: string }>,
  directDependencyFilePaths: Set<string>,
): Promise<MaterializedGraph> {
  const { authoredFiles, materialized, runtimeSrcDir } = context;
  const originalSourceIdsByFilePath = new Map(
    materialized.modules.map((module) => [
      normalizePath(module.filePath),
      [...module.sourceModuleIds],
    ]),
  );
  const bundleInputSourceIdsByEntry = new Map(
    bundles.writtenRequests.map((request) => [
      request.entryPoint,
      request.sourceModuleIds,
    ]),
  );
  const directDependencyEntries = await Promise.all(
    materialized.modules
      .filter((module) =>
        directDependencyFilePaths.has(normalizePath(module.filePath)),
      )
      .map(async (module) => ({
        content: await fs.readFile(module.filePath, "utf8"),
        relativePath: module.relativePath,
      })),
  );
  await syncDirectoryEntries(
    runtimeSrcDir,
    [...authoredEntries, ...directDependencyEntries],
    {
      preserve(relativePath) {
        return relativePath.startsWith(`${DEP_BUNDLE_OUTPUT_DIR}/`);
      },
    },
  );

  const bundledModules = await collectBundledModules({
    extraModules: bundles.canonicalizedEntryOutputs.canonicalModules,
    bundleSrcDir: materialized.srcDir,
    exportFacadesByOutputPath: collectExportFacadesByOutputPath(bundles),
    metafile: bundles.metafile,
    omittedFilePaths: new Set([
      ...bundles.collapsedEntryOutputByPath.keys(),
      ...bundles.canonicalizedEntryOutputs.omittedOutputFilePaths,
    ]),
    outputSrcDir: runtimeSrcDir,
    originalSourceIdsByFilePath,
    syntheticSourceIdsByFilePath: bundleInputSourceIdsByEntry,
  });

  await writeMaterializedDependencyBundleMarker({
    bundleDir: path.join(runtimeSrcDir, DEP_BUNDLE_OUTPUT_DIR),
    files: bundledModules.map((module) => module.filePath),
  });

  return {
    ...materialized,
    authoredFiles: authoredEntries
      .map((entry) => path.join(runtimeSrcDir, entry.relativePath))
      .sort((left, right) => left.localeCompare(right)),
    modules: [
      ...materialized.modules
        .filter(
          (module) =>
            authoredFiles.has(normalizePath(module.filePath)) ||
            directDependencyFilePaths.has(normalizePath(module.filePath)),
        )
        .map((module) =>
          withOneToOneTypeProvenance(
            remapRuntimeModuleToSrcDir(
              module,
              materialized.srcDir,
              runtimeSrcDir,
            ),
          ),
        ),
      ...bundledModules,
    ].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    runtimeEntries: [
      ...new Set(
        [
          ...materialized.entries,
          ...authoredEntries.map((entry) => `./${entry.relativePath}`),
          ...directDependencyEntries.map((entry) => `./${entry.relativePath}`),
          ...bundledModules.map((module) => `./${module.relativePath}`),
        ].sort((left, right) => left.localeCompare(right)),
      ),
    ],
    srcDir: runtimeSrcDir,
  } satisfies MaterializedGraph;
}

async function collectBundledModules(input: {
  extraModules: CapturedRuntimeModule[];
  bundleSrcDir: string;
  metafile: NonNullable<Awaited<ReturnType<EsbuildBuild>>["metafile"]>;
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
        cacheKey: hashTypeMetadataValue({
          exportFacades: resolvedFacades,
          sourceHash: hashText(sourceText),
          sourceModuleIds: sourceModuleIdsSorted,
        }),
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
          cacheKey: hashTypeMetadataValue({
            exportFacades,
            sourceModuleIds: module.sourceModuleIds,
          }),
          exportFacades,
          kind: "fused" as const,
          sourceMappings: [],
        },
      };
    }),
  );

  return modules.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

function collectExportFacadesByOutputPath(bundles: DependencyBundleSet) {
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
          facadeId: hashTypeMetadataValue({
            originExportName: outputExportName,
            originModuleId: request.targetModule.id,
            outputExportName,
            requestKey: writtenRequest.requestKey,
          }),
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

function remapRuntimeModuleToSrcDir(
  module: CapturedRuntimeModule,
  fromSrcDir: string,
  toSrcDir: string,
): CapturedRuntimeModule {
  return {
    ...module,
    filePath: normalizePath(
      path.join(toSrcDir, path.relative(fromSrcDir, module.filePath)),
    ),
    relativePath: path
      .relative(fromSrcDir, module.filePath)
      .replace(/\\/g, "/"),
  };
}
