import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

import type {
  BuildDiagnostic,
  BuildFailure,
  BuildResult,
  CleanCacheOptions,
} from "../api/types";
import {
  acquireProjectCacheLock,
  getDefaultPersistentCacheRoot,
  getProjectCacheDir,
  readJsonIfExists,
  writeJson,
} from "../shared/cache-store";
import {
  collectFileContentSnapshot,
  collectPublishedOutputStats,
  fileContentSnapshotMatches,
  type FileContentSnapshot,
  filesExist,
  publishedOutputsMatchSnapshot,
} from "../shared/file-state";
import { logInternalDetail, withInternalTiming } from "../shared/timing";
import type {
  BuildContext,
  InternalBuildOptions,
  ResolvedBuild,
} from "./types";
import {
  hasErrorCode,
  arrayOf,
  isNumber,
  isObjectOf,
  isString,
  isStringArray,
  recordOf,
} from "../shared/validation";
import { ensureParentDirectory } from "../shared/files";
import { generateExterns } from "../externs";
import { writeEntryShims } from "../native/load";
import { runClosureStage } from "./closure/run-closure";
import { emitNativeStage } from "./transpile/emit";
import {
  createBuildDiagnostic,
  removeProjectCacheDir,
  toBuildDiagnostics,
  toImportPath,
  toPublishedOutputPaths,
} from "./helpers";
import {
  createBuildContext,
  normalizeBuildOptions,
  resolveBuild,
} from "./resolve";
import { resolveChunkOutputType } from "./resolve/options";

interface FinalCacheMetadata {
  artifacts: FileContentSnapshot;
  finalKey: string;
  optionsSignature: string;
  outputFiles: string[];
  packageSignature: string;
  typeMetadataDependencies: FileContentSnapshot;
}

interface FinalFastSnapshot {
  finalKey: string;
  optionsSignature: string;
  packageSignature: string;
  publishedOutputs: Array<{ digest: string; name: string; size: number }>;
  typeMetadataDependencies: FileContentSnapshot;
}

interface FinalCachePaths {
  fastSnapshotPath: string;
  metadataPath: string;
}

interface InvocationStaging {
  finalCacheDir: string;
  outDir: string;
}

export async function build(
  options: InternalBuildOptions,
): Promise<BuildResult> {
  const normalizedOptions = normalizeBuildOptions(options);
  let context: Awaited<ReturnType<typeof createBuildContext>>;
  try {
    context = await createBuildContext(normalizedOptions);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  }

  let releaseCacheLock: (() => Promise<void>) | null = null;
  if (context.options.cache.mode === "persistent") {
    try {
      releaseCacheLock = await acquireProjectCacheLock(context.projectCacheDir);
    } catch (error) {
      return failedBuild([createBuildDiagnostic(error)]);
    }
  }

  let resolved: ResolvedBuild | null = null;
  let staging: InvocationStaging | null = null;
  try {
    resolved = await withInternalTiming("resolve-build", () =>
      resolveBuild(context),
    );
    const cachePaths = getFinalCachePaths(context, resolved);
    const cachedResult = await restoreCachedBuild(
      context,
      resolved,
      cachePaths,
    );
    if (cachedResult) {
      return cachedResult;
    }

    const validationFailure = validateBuildShape(context, resolved);
    if (validationFailure) {
      return validationFailure;
    }

    writeBuildEntryShims(context, resolved);
    const externalExternPlan = await deriveExternalExternPlan({
      options: context.options,
      specifiers: resolved.externalBoundaries.map(
        (boundary) => boundary.specifier,
      ),
    });
    const preservedModules = resolved.preservedModules;
    const preservedFilePaths = new Set(
      preservedModules.map((module) => module.filePath),
    );
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolved.nativeEmitCacheDir,
      chunkPlan: resolved.chunkPlan,
      externalBoundaries: resolved.externalBoundaries,
      fileNames:
        context.options.chunks.mode === "off"
          ? [
              ...resolved.sourceFiles.filter(
                (filePath) => !preservedFilePaths.has(filePath),
              ),
              ...resolved.shimFiles,
            ]
          : resolved.sourceFiles.filter(
              (filePath) => !preservedFilePaths.has(filePath),
            ),
      lazyImports: resolved.lazyImports,
      metadataPath: path.join(resolved.nativeEmitCacheDir, "meta.json"),
      opaqueExternalSpecifiers: externalExternPlan.opaqueSpecifiers,
      options: context.options,
      optionsSignature: context.optionsSignature,
      packageAliases: resolved.packageAliases,
      packageJsonFiles: resolved.packageJsonFiles,
      preservedModules,
      resolvedImports: resolved.resolvedImports,
      tsConfigPath: resolved.tsConfigPath,
      tsxRuntimeSourceFiles: resolved.tsxRuntimeSourceFiles,
      typeInferenceDisabled:
        context.closureCompilerEnvironment.typeInferenceDisabled,
      workspaceDir: resolved.workspaceDir,
    });
    if (nativeEmitResult.emitSkipped || nativeEmitResult.diagnostics.length) {
      return failedBuild(
        toBuildDiagnostics(
          nativeEmitResult.diagnostics,
          createAuthoredPathMapper(context, resolved),
        ),
      );
    }

    await appendExternalTypedExterns({
      externsPath: nativeEmitResult.externsPath,
      imports: nativeEmitResult.preservedImports,
      typedResolutions: externalExternPlan.typedResolutions,
    });

    staging = await createInvocationStaging(
      context.options.outDir,
      resolved.finalCacheDir,
    );
    const closureResult = await runClosureStage({
      chunkPlan: resolved.chunkPlan,
      closureCompilerEnvironment: context.closureCompilerEnvironment,
      emittedOutDir: nativeEmitResult.outDir,
      entryShebangs:
        context.options.target === "node"
          ? await collectEntryShebangs(resolved.entryFiles)
          : [],
      explicitExternPaths: context.options.externs,
      finalCacheDir: staging.finalCacheDir,
      generatedExternPaths: context.options.typedExterns,
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: staging.outDir,
      preservedImports: [
        ...nativeEmitResult.preservedImports,
        ...resolved.entryFiles.flatMap((entry) => {
          const preserved = preservedModules.find(
            (module) => module.filePath === entry.sourcePath,
          );
          return preserved
            ? [
                {
                  boundaryExports: [],
                  boundaryNames: [],
                  importClause: "",
                  importerFilePath: entry.sourcePath,
                  targetModuleId: preserved.moduleId,
                },
              ]
            : [];
        }),
      ],
      preservedModules,
      packageRoot: context.packageRoot,
      projectCacheDir: path.dirname(path.dirname(resolved.finalCacheDir)),
      supportFiles: nativeEmitResult.supportFiles,
      typeMetadata: nativeEmitResult.typeMetadata,
    });
    if (closureResult.exitCode !== 0) {
      return failedBuild([
        createBuildDiagnostic(
          `Closure compilation failed with exit code ${closureResult.exitCode}.`,
        ),
      ]);
    }

    const publishedResult = await publishStagedClosureResult(
      closureResult,
      staging,
      resolved.finalCacheDir,
      context.options.outDir,
    );
    await persistFinalCache(
      context,
      resolved,
      cachePaths,
      publishedResult,
      nativeEmitResult.typeMetadataDependencies,
    );
    return successfulBuild(publishedResult.outputFiles, false);
  } catch (error) {
    return failedBuild([createBuildDiagnostic(error)]);
  } finally {
    if (staging) {
      await cleanupInvocationStaging(staging);
    }
    try {
      await resolved?.cleanup();
    } finally {
      await releaseCacheLock?.();
    }
  }
}

/**
 * Diagnostics reference the workspace overlay (workspace/src/...), which
 * mirrors srcDir. Map them back so callers see paths they can open.
 */
function createAuthoredPathMapper(
  context: BuildContext,
  resolved: ResolvedBuild,
) {
  const sourceRoot = path.join(resolved.workspaceDir, "src");
  return (filePath: string) =>
    filePath.startsWith(sourceRoot)
      ? path.join(context.options.srcDir, path.relative(sourceRoot, filePath))
      : filePath;
}

function getFinalCachePaths(
  context: BuildContext,
  resolved: ResolvedBuild,
): FinalCachePaths {
  return {
    fastSnapshotPath: path.join(context.projectCacheDir, "final-fast.json"),
    metadataPath: path.join(resolved.finalCacheDir, "meta.json"),
  };
}

async function createInvocationStaging(
  outDir: string,
  finalCacheDir: string,
): Promise<InvocationStaging> {
  await Promise.all([
    fs.mkdir(path.dirname(outDir), { recursive: true }),
    fs.mkdir(path.dirname(finalCacheDir), { recursive: true }),
  ]);
  return {
    finalCacheDir: await fs.mkdtemp(
      path.join(
        path.dirname(finalCacheDir),
        `.${path.basename(finalCacheDir)}.staging-`,
      ),
    ),
    outDir: await fs.mkdtemp(
      path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`),
    ),
  };
}

async function publishStagedClosureResult(
  closureResult: Awaited<ReturnType<typeof runClosureStage>>,
  staging: InvocationStaging,
  finalCacheDir: string,
  outDir: string,
) {
  await replaceDirectoryAtomically(staging.finalCacheDir, finalCacheDir);
  const cacheOutputFiles = remapStagedFiles(
    closureResult.cacheOutputFiles,
    staging.finalCacheDir,
    finalCacheDir,
  );
  await replaceDirectoryAtomically(staging.outDir, outDir);
  const outputFiles = remapStagedFiles(
    closureResult.outputFiles,
    staging.outDir,
    outDir,
  );
  return { ...closureResult, cacheOutputFiles, outputFiles };
}

async function publishCachedOutputsAtomically(
  outputFiles: string[],
  sourceRoot: string,
  outDir: string,
) {
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingDir = await fs.mkdtemp(
    path.join(path.dirname(outDir), `.${path.basename(outDir)}.staging-`),
  );
  try {
    await copyFilesPreservingRelativePaths(outputFiles, sourceRoot, stagingDir);
    await replaceDirectoryAtomically(stagingDir, outDir);
  } finally {
    await fs.rm(stagingDir, { force: true, recursive: true }).catch(() => {});
  }
}

async function copyFilesPreservingRelativePaths(
  sourceFiles: string[],
  sourceRoot: string,
  targetRoot: string,
) {
  await Promise.all(
    sourceFiles.map(async (sourceFile) => {
      const [targetFile] = remapStagedFiles(
        [sourceFile],
        sourceRoot,
        targetRoot,
      );
      if (!targetFile) {
        return;
      }
      await ensureParentDirectory(targetFile);
      await fs.copyFile(sourceFile, targetFile);
    }),
  );
}

async function replaceDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
) {
  const backupDir = `${targetDir}.backup-${randomUUID()}`;
  let hasBackup = false;
  try {
    await fs.rename(targetDir, backupDir);
    hasBackup = true;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  try {
    await fs.rename(stagingDir, targetDir);
  } catch (error) {
    if (hasBackup) {
      await fs.rename(backupDir, targetDir).catch((restoreError) => {
        throw new AggregateError(
          [error, restoreError],
          `Failed to publish ${targetDir} and restore its previous contents.`,
        );
      });
    }
    throw error;
  }

  if (hasBackup) {
    await fs.rm(backupDir, { force: true, recursive: true }).catch(() => {});
  }
}

function remapStagedFiles(
  filePaths: string[],
  stagingDir: string,
  targetDir: string,
) {
  return filePaths.map((filePath) => {
    const relativePath = path.relative(stagingDir, filePath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Staged output escaped its directory: ${filePath}`);
    }
    return path.join(targetDir, relativePath);
  });
}

async function cleanupInvocationStaging(staging: InvocationStaging) {
  await Promise.all(
    [staging.finalCacheDir, staging.outDir].map((dirPath) =>
      fs.rm(dirPath, { force: true, recursive: true }).catch(() => {}),
    ),
  );
}

async function restoreCachedBuild(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
): Promise<BuildResult | null> {
  if (
    context.options.cache.mode !== "persistent" ||
    resolved.externalBoundaries.length > 0
  ) {
    return null;
  }
  return (
    (await restoreFastSnapshot(
      context,
      resolved,
      cachePaths.fastSnapshotPath,
    )) ?? restoreFinalMetadata(context, resolved, cachePaths.metadataPath)
  );
}

async function restoreFastSnapshot(
  context: BuildContext,
  resolved: ResolvedBuild,
  snapshotPath: string,
): Promise<BuildResult | null> {
  const snapshot = await readJsonIfExists(snapshotPath, isFinalFastSnapshot);
  const cacheHit = Boolean(
    snapshot &&
    snapshot.finalKey === resolved.finalKey &&
    snapshot.optionsSignature === context.optionsSignature &&
    snapshot.packageSignature === context.packageSignature &&
    (await publishedOutputsMatchSnapshot(
      snapshot.publishedOutputs,
      context.options.outDir,
    )) &&
    (await fileContentSnapshotMatches(snapshot.typeMetadataDependencies)) &&
    (await requiredSidecarFilesExist()),
  );
  logInternalDetail("cache:final-fast", cacheHit ? "hit" : "miss");
  return snapshot && cacheHit
    ? successfulBuild(
        toPublishedOutputPaths(
          snapshot.publishedOutputs,
          context.options.outDir,
        ),
        true,
      )
    : null;
}

async function restoreFinalMetadata(
  context: BuildContext,
  resolved: ResolvedBuild,
  metadataPath: string,
): Promise<BuildResult | null> {
  const metadata = await readJsonIfExists(metadataPath, isFinalCacheMetadata);
  const cacheHit = Boolean(
    metadata &&
    metadata.finalKey === resolved.finalKey &&
    metadata.optionsSignature === context.optionsSignature &&
    metadata.packageSignature === context.packageSignature &&
    (await fileContentSnapshotMatches(
      metadata.artifacts,
      metadata.outputFiles,
    )) &&
    (await fileContentSnapshotMatches(metadata.typeMetadataDependencies)) &&
    (await requiredSidecarFilesExist()),
  );
  logInternalDetail("cache:final-metadata", cacheHit ? "hit" : "miss");
  if (!metadata || !cacheHit) {
    return null;
  }

  const cacheOutputRoot = path.join(resolved.finalCacheDir, "outputs");
  await publishCachedOutputsAtomically(
    metadata.outputFiles,
    cacheOutputRoot,
    context.options.outDir,
  );
  return successfulBuild(
    remapStagedFiles(
      metadata.outputFiles,
      cacheOutputRoot,
      context.options.outDir,
    ),
    true,
  );
}

async function requiredSidecarFilesExist() {
  const runtimeModuleSourceMapFile =
    process.env.GCC_VITE_RUNTIME_SOURCE_MAP_FILE;
  return (
    !runtimeModuleSourceMapFile ||
    (await filesExist([runtimeModuleSourceMapFile]))
  );
}

function validateBuildShape(
  context: BuildContext,
  resolved: ResolvedBuild,
): BuildFailure | null {
  const outputType = resolveChunkOutputType({
    chunkMode: context.options.chunks.mode,
    languageOut: context.options.languageOut,
    outputType: context.options.chunks.outputType,
  });
  if (
    resolved.externalBoundaries.length > 0 &&
    context.options.chunks.mode !== "off"
  ) {
    return failedBuild([
      createBuildDiagnostic(
        "External runtime imports are supported only by the standalone basic build path in this phase.",
      ),
    ]);
  }
  if (resolved.externalBoundaries.length > 0 && outputType !== "esm") {
    return failedBuild([
      createBuildDiagnostic(
        'External runtime imports require ESM output. Set chunks.outputType to "esm".',
      ),
    ]);
  }
  if (resolved.preservedModules.length > 0 && outputType !== "esm") {
    return failedBuild([
      createBuildDiagnostic(
        'Preserved modules require ESM output. Set chunks.outputType to "esm".',
      ),
    ]);
  }
  if (
    context.options.chunks.mode !== "off" &&
    resolved.entryFiles.some(
      (entry) => entry.exportNames.length > 0 || entry.hasDefaultExport,
    )
  ) {
    return failedBuild([
      createBuildDiagnostic(
        "Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.",
      ),
    ]);
  }

  if (
    context.options.chunks.mode === "off" &&
    resolved.lazyImports.length > 0
  ) {
    return failedBuild([
      createBuildDiagnostic(
        'Dynamic import() requires chunks.mode = "bundler-runtime" or "split".',
      ),
    ]);
  }
  return null;
}

type GeneratedExternalExterns = Awaited<ReturnType<typeof generateExterns>>;

interface ExternalExternPlan {
  opaqueSpecifiers: string[];
  typedResolutions: Array<{
    generated: GeneratedExternalExterns;
    specifier: string;
  }>;
}

async function deriveExternalExternPlan(input: {
  options: BuildContext["options"];
  specifiers: string[];
}): Promise<ExternalExternPlan> {
  const specifiers = [...new Set(input.specifiers)].sort((left, right) =>
    left.localeCompare(right),
  );
  const opaqueSpecifiers: string[] = [];
  const typedResolutions: ExternalExternPlan["typedResolutions"] = [];
  for (const specifier of specifiers) {
    try {
      const generated = await generateExterns({
        appEntryFiles: input.options.entries.map((entry) => entry.file),
        mode: "boundary-aware",
        modules: [{ exports: "used", runtime: "external", specifier }],
        projectRoot: input.options.projectRoot,
        srcDir: input.options.srcDir,
        target: input.options.target,
      });
      if (
        !generated.typedDeclarations.moduleExports.some(
          (module) => module.specifier === specifier,
        )
      ) {
        throw new Error("no declaration module surface was produced");
      }
      typedResolutions.push({ generated, specifier });
      for (const warning of generated.warnings) {
        console.warn(`gcc-ts-bundler: ${warning}`);
      }
      for (const warning of generated.barrierWarnings) {
        console.warn(`gcc-ts-bundler: ${warning.message}`);
      }
    } catch (error) {
      opaqueSpecifiers.push(specifier);
      console.warn(
        `gcc-ts-bundler: using opaque externs for external module ${JSON.stringify(specifier)} because declarations could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { opaqueSpecifiers, typedResolutions };
}

async function appendExternalTypedExterns(input: {
  externsPath: string;
  imports: Array<{
    boundaryExports: string[];
    boundaryNames: string[];
    externalSpecifier?: string | undefined;
  }>;
  typedResolutions: ExternalExternPlan["typedResolutions"];
}) {
  const typedTexts = input.typedResolutions.map(({ generated, specifier }) => {
    const moduleSurface = generated.typedDeclarations.moduleExports.find(
      (module) => module.specifier === specifier,
    );
    const boundaryLines = input.imports
      .filter((item) => item.externalSpecifier === specifier)
      .flatMap((item) =>
        item.boundaryExports.flatMap((exportName, index) => {
          const boundaryName = item.boundaryNames[index];
          if (!boundaryName || !moduleSurface) return [];
          if (exportName === "*") {
            return moduleSurface.exports
              .filter(({ exportName: name }) =>
                /^[$A-Z_a-z][$\w]*$/u.test(name),
              )
              .flatMap((exported) =>
                renderTypedBoundaryDeclaration(
                  generated.typedDeclarations.text,
                  exported.qualifiedName,
                  `${boundaryName}.${exported.exportName}`,
                  false,
                ),
              );
          }
          const exported = moduleSurface.exports.find(
            (item) => item.exportName === exportName,
          );
          return exported
            ? renderTypedBoundaryDeclaration(
                generated.typedDeclarations.text,
                exported.qualifiedName,
                boundaryName,
              )
            : [];
        }),
      );
    return `${generated.typedDeclarations.text}\n// Exact typed external boundaries.\n${boundaryLines.join("\n")}\n`;
  });
  if (typedTexts.length > 0) {
    await fs.appendFile(
      input.externsPath,
      `\n// Typed external runtime declarations.\n${typedTexts.join("\n")}`,
      "utf8",
    );
  }
}

function renderTypedBoundaryDeclaration(
  externText: string,
  qualifiedName: string,
  boundaryName: string,
  declareVariable = true,
) {
  const referenceIndex = externText.indexOf(qualifiedName);
  if (referenceIndex < 0) return [];
  const commentIndex = externText.lastIndexOf("/**", referenceIndex);
  const statementEnd = externText.indexOf(";", referenceIndex);
  if (commentIndex < 0 || statementEnd < 0) return [];
  const declaration = externText.slice(commentIndex, statementEnd + 1);
  const replaced = declaration.replaceAll(qualifiedName, boundaryName);
  const bareReference = `${boundaryName};`;
  return [
    declareVariable && replaced.endsWith(bareReference)
      ? `${replaced.slice(0, -bareReference.length)}var ${bareReference}`
      : replaced,
  ];
}

async function collectEntryShebangs(entries: ResolvedBuild["entryFiles"]) {
  const shebangs = await Promise.all(
    entries.map(async (entry) => {
      const source = await fs.readFile(entry.sourcePath, "utf8");
      const shebang = source.match(/^#![^\r\n]*/u)?.[0];
      return shebang ? { shebang, sourcePath: entry.sourcePath } : null;
    }),
  );
  return shebangs.filter(
    (entry): entry is { shebang: string; sourcePath: string } => entry !== null,
  );
}

function writeBuildEntryShims(context: BuildContext, resolved: ResolvedBuild) {
  if (context.options.chunks.mode !== "off") {
    return;
  }
  writeEntryShims({
    entries: resolved.entryFiles.map((entry) => ({
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      importPath: toImportPath(
        path.relative(
          path.dirname(path.join(resolved.shimDir, `${entry.chunkName}.ts`)),
          entry.sourcePath,
        ),
      ),
      shimPath: path.join(resolved.shimDir, `${entry.chunkName}.ts`),
    })),
  });
}

async function persistFinalCache(
  context: BuildContext,
  resolved: ResolvedBuild,
  cachePaths: FinalCachePaths,
  closureResult: Awaited<ReturnType<typeof runClosureStage>>,
  typeMetadataDependencies: FileContentSnapshot,
) {
  if (context.options.cache.mode !== "persistent") {
    return;
  }
  const artifacts = await collectFileContentSnapshot(
    closureResult.cacheOutputFiles,
  );
  await Promise.all([
    writeJson(cachePaths.metadataPath, {
      artifacts,
      finalKey: resolved.finalKey,
      optionsSignature: context.optionsSignature,
      outputFiles: closureResult.cacheOutputFiles,
      packageSignature: context.packageSignature,
      typeMetadataDependencies,
    } satisfies FinalCacheMetadata),
    collectPublishedOutputStats(
      closureResult.outputFiles,
      context.options.outDir,
    ).then((publishedOutputs) =>
      writeJson(cachePaths.fastSnapshotPath, {
        finalKey: resolved.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs,
        typeMetadataDependencies,
      } satisfies FinalFastSnapshot),
    ),
  ]);
}

function successfulBuild(
  outputFiles: readonly string[],
  cacheHit: boolean,
): BuildResult {
  return { cacheHit, ok: true, outputFiles };
}

function failedBuild(diagnostics: readonly BuildDiagnostic[]): BuildFailure {
  return { diagnostics, ok: false };
}

const isContentIdentity = isObjectOf<FileContentSnapshot[string]>({
  digest: isString,
  size: isNumber,
});

const isFinalCacheMetadata = isObjectOf<FinalCacheMetadata>({
  artifacts: recordOf(isContentIdentity),
  finalKey: isString,
  optionsSignature: isString,
  outputFiles: isStringArray,
  packageSignature: isString,
  typeMetadataDependencies: recordOf(isContentIdentity),
});

const isPublishedOutput = isObjectOf<
  FinalFastSnapshot["publishedOutputs"][number]
>({
  digest: isString,
  name: isString,
  size: isNumber,
});

const isFinalFastSnapshot = isObjectOf<FinalFastSnapshot>({
  finalKey: isString,
  optionsSignature: isString,
  packageSignature: isString,
  publishedOutputs: arrayOf(isPublishedOutput),
  typeMetadataDependencies: recordOf(isContentIdentity),
});

export async function cleanCache(options: CleanCacheOptions = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = options.cacheDir
    ? path.resolve(projectRoot, options.cacheDir)
    : getDefaultPersistentCacheRoot();
  const projectCacheDir = getProjectCacheDir(cacheRoot, projectRoot);
  const releaseCacheLock = await acquireProjectCacheLock(projectCacheDir);
  try {
    await removeProjectCacheDir(projectCacheDir);
  } finally {
    await releaseCacheLock();
  }
}
