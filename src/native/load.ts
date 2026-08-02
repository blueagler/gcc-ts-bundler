import { toRecord } from "../shared/records";
import { isRecord } from "../shared/validation";
import nativeBinding from "./index";

interface NativeEntryExportMetadata {
  exportNames: string[];
  hasDefaultExport: boolean;
  sourcePath: string;
}

interface NativeFileHashEntry {
  filePath: string;
  hash: string;
}

interface NativeExternalBoundaryEntry {
  importerFilePath: string;
  specifier: string;
}

interface NativeDependencyGraphEntry {
  dependencies: string[];
  filePath: string;
}

interface NativeModuleKindEntry {
  filePath: string;
  kind: "compiled" | "preserved";
}

interface NativeChunkPlanEntryInput {
  chunkName: string;
  outputName: string;
  sourcePath: string;
}

interface NativeChunkPlanChunkOutput {
  dependencies: string[];
  entryFiles?: string[];
  files: string[];
  kind?: "base" | "entry" | "lazy" | "shared" | "vendor";
  lazyModuleIds?: string[];
  name: string;
}

interface NativeClosureCompileJob {
  assumeFunctionWrapper: boolean;
  chunk?: string[];
  chunkOutputPathPrefix?: string;
  /** Closure `--chunk_output_type`; omitted for GLOBAL_NAMESPACE (default). */
  chunkOutputType?: string;
  compilationLevel: string;
  dependencyMode?: string;
  entryPoint?: string[];
  externs: string[];
  js: string[];
  jsOutputFile?: string;
  languageIn: string;
  languageOut: string;
  propertyRenamingReportPath?: string;
  renamePrefixNamespace?: string;
  rewritePolyfills: boolean;
  warningLevel: string;
  hasTypeMetadata: boolean;
  typeMetadataCounts: NativeTypeMetadataCounts;
}

interface NativeGeneratedAsset {
  path: string;
  text: string;
}

interface NativeGccExportsRewrite {
  code: string;
  /** Fail-closed telemetry: export slots this rewrite actually converted. */
  rewrittenExportCount: number;
}

interface NativePostprocessAction {
  inputPath: string;
  /**
   * What postprocess has to do to the chunk beyond publishing it. `"copy"`
   * still goes through the runtime wrapper and base-specifier rewrites; those
   * are decided from the chunk mode, not from the kind.
   */
  kind: "copy" | "rewrite-gcc-exports";
  outputPath: string;
}

interface NativePrepareClosureJobsInput {
  chunkLoader: string;
  chunkMode: string;
  /** Resolved `"script" | "esm"`; never `"auto"`. */
  chunkOutputType: string;
  chunkPlan: NativeChunkPlanChunkOutput[];
  compilationLevel: string;
  diagnosticsVerbose: boolean;
  emittedOutDir: string;
  explicitExternPaths: string[];
  explicitJsInputs: string[];
  finalCacheDir: string;
  generatedExternPaths: string[];
  languageOut: string;
  manifestFile: string;
  nativeExternPath: string;
  /** Whether CSS rows can be attached to the manifest after the compile. */
  needsCssRuntime: boolean;
  outDir: string;
  packageRoot: string;
  publicPath: string;
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
}

interface NativePrepareClosureJobsOutput {
  bundlerRuntimeBaseInputPath?: string;
  compileJobs: NativeClosureCompileJob[];
  generatedAssets: NativeGeneratedAsset[];
  postprocessActions: NativePostprocessAction[];
  publishedOutputs: string[];
}

interface NativePackageAliasEntry {
  packageName: string;
  subpath: string;
  targetPath: string;
}

interface NativeResolvedImportEntry {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

interface NativeLazyImportEntry {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

export interface NativePreservedModuleEntry {
  exportNames: string[];
  filePath: string;
  hasDefaultExport: boolean;
  moduleId: string;
}

interface NativeResolveGraphOutput {
  entries: NativeEntryExportMetadata[];
  externalBoundaries: NativeExternalBoundaryEntry[];
  fileHashes: NativeFileHashEntry[];
  graph: NativeDependencyGraphEntry[];
  lazyImports: NativeLazyImportEntry[];
  moduleKinds: NativeModuleKindEntry[];
  packageAliases: NativePackageAliasEntry[];
  resolvedImports: NativeResolvedImportEntry[];
  packageJsonFiles: string[];
  preservedModules: NativePreservedModuleEntry[];
  sourceFiles: string[];
  trackedFiles: string[];
}

export interface NativeFileStateEntry {
  exists: boolean;
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface NativePublishedOutputEntry {
  name: string;
  size: number;
}

interface NativeShimEntry {
  exportNames: string[];
  hasDefaultExport: boolean;
  importPath: string;
  shimPath: string;
}

export interface NativeTypeMetadataCounts {
  annotationCount: number;
  enumDeclarationCount: number;
  memberAnnotationCount: number;
  typeDeclarationCount: number;
  unresolvedTypeReferenceCount: number;
}

export interface NativeTypeMetadataDiagnostic {
  declarationFilePath?: string;
  phase: string;
  reason: string;
  sourceFilePath: string;
  symbolId?: string;
  symbolName?: string;
  target?: string;
}

export interface NativeEmittedTypeMetadata {
  counts: NativeTypeMetadataCounts;
  diagnostics: NativeTypeMetadataDiagnostic[];
  emittedFile: string;
  hasTypeMetadata: boolean;
}

interface NativePreservedImportOutput {
  boundaryExports: string[];
  boundaryNames: string[];
  externalSpecifier?: string | undefined;
  importClause: string;
  importerFilePath: string;
  targetModuleId: string;
}

interface NativeTranspileOutput {
  emittedFiles: string[];
  explicitExternPropertyCount: number;
  externsPath: string;
  preservedImports: NativePreservedImportOutput[];
  preservedPropertyCount: number;
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
}

interface NativeLazyImportInput {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

interface NativeTranspilePreservedModule {
  exportNames: string[];
  filePath: string;
  hasDefaultExport: boolean;
  moduleId: string;
  outputRelativePath: string;
}

interface NativeTranspilePackageAlias {
  packageName: string;
  subpath: string;
  targetPath: string;
}

interface NativeTranspileChunkInput {
  /** Chunks the loader guarantees have executed before this one. */
  dependencies: string[];
  files: string[];
  name: string;
}

interface NativeClassMapCallInput {
  argIndex: number;
  callee: string;
  calleeModulePattern?: string | undefined;
  keyExcludePattern?: string | undefined;
  keySource?: string | undefined;
  keyPattern?: string | undefined;
  stringLiteralArgIndex?: number | undefined;
}

interface NativeBinding {
  collectFileStates(filePaths: string[]): NativeFileStateEntry[];
  collectPublishedOutputStats(
    filePaths: string[],
  ): NativePublishedOutputEntry[];
  matchFileStates(expected: NativeFileStateEntry[]): boolean;
  publishedOutputSnapshotMatches(
    publishedOutputs: NativePublishedOutputEntry[],
    outDir: string,
  ): boolean;
  publishedOutputsMatch(outputFiles: string[], outDir: string): boolean;
  prepareClosureJobs(
    input: NativePrepareClosureJobsInput,
  ): NativePrepareClosureJobsOutput;
  planChunks(
    chunkMode: string,
    baseChunkName: string,
    workspaceDir: string,
    entryFiles: NativeChunkPlanEntryInput[],
    graphEntries: NativeDependencyGraphEntry[],
    lazyImports: NativeLazyImportEntry[],
    shimFiles: string[],
    vendorChunk: boolean,
  ): NativeChunkPlanChunkOutput[];
  resolveGraph(
    entries: string[],
    srcDir: string,
    workspaceDir: string,
    packageMode: string,
    externalSpecifiers: string[],
    preservedFilePaths: string[],
  ): NativeResolveGraphOutput;
  rewriteGccExports(code: string): NativeGccExportsRewrite;
  transpileSources(
    fileNames: string[],
    explicitExternPaths: string[],
    outDir: string,
    externsPath: string,
    metadataPath: string,
    chunkMode: string,
    target: string,
    runtimeModuleSourceMapFile: string | null,
    workspaceDir: string,
    packageAliases: NativeTranspilePackageAlias[],
    resolvedImports: NativeResolvedImportEntry[],
    externalBoundaries: NativeExternalBoundaryEntry[],
    opaqueExternalSpecifiers: string[],
    packageJsonFiles: string[],
    preservedModules: NativeTranspilePreservedModule[],
    lazyImports: NativeLazyImportInput[],
    chunkGraph: NativeTranspileChunkInput[],
    classMapCalls: NativeClassMapCallInput[],
    pureCallees: string[],
    typeInferenceDisabled: boolean,
  ): NativeTranspileOutput;
  writeEntryShims(entries: NativeShimEntry[]): string[];
}

let cachedBinding: NativeBinding | null = null;

// Record<keyof NativeBinding, true> makes this exhaustive: adding a method
// to NativeBinding without listing it here is a compile error, so a stale
// addon can never validate as complete.
const NATIVE_BINDING_METHOD_FLAGS: Record<keyof NativeBinding, true> = {
  collectFileStates: true,
  collectPublishedOutputStats: true,
  matchFileStates: true,
  planChunks: true,
  prepareClosureJobs: true,
  publishedOutputSnapshotMatches: true,
  publishedOutputsMatch: true,
  resolveGraph: true,
  rewriteGccExports: true,
  transpileSources: true,
  writeEntryShims: true,
};

const NATIVE_BINDING_METHODS = Object.keys(NATIVE_BINDING_METHOD_FLAGS);

function loadBinding(): NativeBinding {
  if (cachedBinding) {
    return cachedBinding;
  }
  if (!isNativeBinding(nativeBinding)) {
    throw new TypeError("Loaded native addon has an invalid API surface.");
  }

  cachedBinding = nativeBinding;
  return cachedBinding;
}

function isNativeBinding(value: unknown): value is NativeBinding {
  return (
    isRecord(value) &&
    NATIVE_BINDING_METHODS.every(
      (methodName) => typeof value[methodName] === "function",
    )
  );
}

export function resolveGraph(input: {
  entries: string[];
  externalSpecifiers?: string[] | undefined;
  packageMode: string;
  preservedFilePaths?: string[] | undefined;
  srcDir: string;
  target?: string | undefined;
  workspaceDir: string;
}) {
  const result = loadBinding().resolveGraph(
    input.entries,
    input.srcDir,
    input.workspaceDir,
    input.target && input.target !== "browser"
      ? `${input.packageMode}:${input.target}`
      : input.packageMode,
    input.externalSpecifiers ?? [],
    input.preservedFilePaths ?? [],
  );
  return {
    entries: result.entries,
    externalBoundaries: result.externalBoundaries,
    fileHashes: toRecord(
      result.fileHashes.map((entry): readonly [string, string] => [
        entry.filePath,
        entry.hash,
      ]),
    ),
    graph: toRecord(
      result.graph.map((entry): readonly [string, string[]] => [
        entry.filePath,
        entry.dependencies,
      ]),
    ),
    lazyImports: result.lazyImports,
    moduleKinds: result.moduleKinds,
    packageAliases: result.packageAliases,
    resolvedImports: result.resolvedImports,
    packageJsonFiles: result.packageJsonFiles,
    preservedModules: result.preservedModules,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles,
  };
}

export function planChunks(input: {
  baseChunkName: string;
  chunkMode: string;
  entryFiles: NativeChunkPlanEntryInput[];
  graphEntries: NativeDependencyGraphEntry[];
  lazyImports: NativeLazyImportEntry[];
  shimFiles: string[];
  /** Already gated by `resolveVendorChunk`; native ignores it off bundler-runtime. */
  vendorChunk: boolean;
  workspaceDir: string;
}) {
  return loadBinding().planChunks(
    input.chunkMode,
    input.baseChunkName,
    input.workspaceDir,
    input.entryFiles,
    input.graphEntries,
    input.lazyImports,
    input.shimFiles,
    input.vendorChunk,
  );
}

export function rewriteGccExports(code: string) {
  return loadBinding().rewriteGccExports(code);
}

export function transpileSources(input: {
  chunkGraph: NativeTranspileChunkInput[];
  chunkMode: string;
  classMapCalls: NativeClassMapCallInput[];
  pureCallees: string[];
  typeInferenceDisabled: boolean;
  explicitExternPaths: string[];
  externsPath: string;
  fileNames: string[];
  metadataPath: string;
  outDir: string;
  target: string;
  packageAliases: NativeTranspilePackageAlias[];
  resolvedImports: NativeResolvedImportEntry[];
  externalBoundaries: NativeExternalBoundaryEntry[];
  opaqueExternalSpecifiers: string[];
  packageJsonFiles: string[];
  preservedModules: NativeTranspilePreservedModule[];
  lazyImports: NativeLazyImportInput[];
  runtimeModuleSourceMapFile: string | undefined;
  workspaceDir: string;
}) {
  return loadBinding().transpileSources(
    input.fileNames,
    input.explicitExternPaths,
    input.outDir,
    input.externsPath,
    input.metadataPath,
    input.chunkMode,
    input.target,
    input.runtimeModuleSourceMapFile ?? null,
    input.workspaceDir,
    input.packageAliases,
    input.resolvedImports,
    input.externalBoundaries,
    input.opaqueExternalSpecifiers,
    input.packageJsonFiles,
    input.preservedModules,
    input.lazyImports,
    input.chunkGraph,
    input.classMapCalls,
    input.pureCallees,
    input.typeInferenceDisabled,
  );
}

export function prepareClosureJobs(input: NativePrepareClosureJobsInput) {
  return loadBinding().prepareClosureJobs(input);
}

export function writeEntryShims(input: {
  entries: Array<{
    exportNames: string[];
    hasDefaultExport: boolean;
    importPath: string;
    shimPath: string;
  }>;
}) {
  return loadBinding().writeEntryShims(input.entries);
}

export function collectFileStates(filePaths: string[]) {
  return loadBinding().collectFileStates(filePaths);
}

export function collectPublishedOutputStats(filePaths: string[]) {
  return loadBinding().collectPublishedOutputStats(filePaths);
}

export function matchFileStates(expected: NativeFileStateEntry[]) {
  return loadBinding().matchFileStates(expected);
}

export function publishedOutputSnapshotMatches(
  publishedOutputs: NativePublishedOutputEntry[],
  outDir: string,
) {
  return loadBinding().publishedOutputSnapshotMatches(publishedOutputs, outDir);
}

export function publishedOutputsMatch(outputFiles: string[], outDir: string) {
  return loadBinding().publishedOutputsMatch(outputFiles, outDir);
}
