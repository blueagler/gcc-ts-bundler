import type { PreservedImport } from "../build/types";

export interface NativeEntryExportMetadata {
  exportNames: string[];
  hasDefaultExport: boolean;
  sourcePath: string;
}

export interface NativeFileHashEntry {
  filePath: string;
  hash: string;
}

export interface NativeExternalBoundaryEntry {
  importerFilePath: string;
  specifier: string;
}

export interface NativeDependencyGraphEntry {
  dependencies: string[];
  filePath: string;
}

export interface NativeChunkPlanEntryInput {
  chunkName: string;
  outputName: string;
  sourcePath: string;
}

export interface NativeChunkPlanChunkOutput {
  dependencies: string[];
  entryFiles?: string[];
  files: string[];
  kind?: "base" | "entry" | "lazy" | "shared" | "vendor";
  lazyModuleIds?: string[];
  name: string;
  outputName?: string;
}

export interface NativeClosureCompileJob {
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

export interface NativeGeneratedAsset {
  path: string;
  text: string;
}

export interface NativeGccExportsRewrite {
  code: string;
  /** Structural `globalThis.GCC` member references, excluding string literals. */
  gccReferenceCount: number;
  matchedBootstrapCount: number;
  matchedExportAssignmentCount: number;
  /** Fail-closed telemetry: export slots this rewrite actually converted. */
  rewrittenExportCount: number;
}

export interface NativePostprocessAction {
  inputPath: string;
  /**
   * What postprocess has to do to the chunk beyond publishing it. `"copy"`
   * still goes through the runtime wrapper and base-specifier rewrites; those
   * are decided from the chunk mode, not from the kind. The strip action is
   * capability-derived for one-chunk eager ESM output only.
   */
  kind: "copy" | "rewrite-gcc-exports" | "strip-bundler-runtime";
  outputPath: string;
}

export interface NativePrepareClosureJobsInput {
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
  /** Whether the graph crosses a preserved ESM boundary. */
  hasPreservedModules: boolean;
  nativeExternPath: string;
  /** Whether CSS rows can be attached to the manifest after the compile. */
  needsCssRuntime: boolean;
  outDir: string;
  packageRoot: string;
  publicPath: string;
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
}

export interface NativePrepareClosureJobsOutput {
  bundlerRuntimeBaseInputPath?: string;
  compileJobs: NativeClosureCompileJob[];
  generatedAssets: NativeGeneratedAsset[];
  postprocessActions: NativePostprocessAction[];
  publishedOutputs: string[];
}

export interface NativePackageAliasEntry {
  packageName: string;
  subpath: string;
  targetPath: string;
}

export interface NativeResolvedImportEntry {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

export interface NativeLazyImportEntry {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

/**
 * One Rollup output chunk, as the Vite plugin sees it at `generateBundle`.
 *
 * `fileName` is the identity because Rollup chunk names are not unique, so
 * import edges travel as file names too. `moduleFiles` are materialized source
 * files, already joined from Rollup module ids and absolute.
 */
export interface NativeRollupChunkInput {
  dynamicImportedChunkFileNames: string[];
  fileName: string;
  importedChunkFileNames: string[];
  isEntry: boolean;
  moduleFiles: string[];
  name: string;
}

export interface NativePreservedModuleEntry {
  exportNames: string[];
  filePath: string;
  hasDefaultExport: boolean;
  moduleId: string;
}

export interface NativeResolveGraphOutput {
  entries: NativeEntryExportMetadata[];
  externalBoundaries: NativeExternalBoundaryEntry[];
  fileHashes: NativeFileHashEntry[];
  graph: NativeDependencyGraphEntry[];
  lazyImports: NativeLazyImportEntry[];
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

export interface NativeShimEntry {
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

export interface NativeEmittedTypeDeclaration {
  template: string;
}

export interface NativeEmittedTypeMetadata {
  counts: NativeTypeMetadataCounts;
  declarations: NativeEmittedTypeDeclaration[];
  diagnostics: NativeTypeMetadataDiagnostic[];
  emittedFile: string;
}

export type NativePreservedImportOutput = PreservedImport;

export interface NativeTranspileOutput {
  emittedFiles: string[];
  explicitExternPropertyCount: number;
  externsPath: string;
  preservedImports: NativePreservedImportOutput[];
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  warnings: string[];
}

export interface NativeLazyImportInput {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

export interface NativeTranspilePreservedModule {
  exportNames: string[];
  filePath: string;
  hasDefaultExport: boolean;
  moduleId: string;
  outputRelativePath: string;
}

export interface NativeTranspilePackageAlias {
  packageName: string;
  subpath: string;
  targetPath: string;
}

export interface NativeTranspileChunkInput {
  /** Chunks the loader guarantees have executed before this one. */
  dependencies: string[];
  files: string[];
  name: string;
}

export interface NativeClassMapCallInput {
  argIndex: number;
  callee: string;
  calleeModulePattern?: string | undefined;
  keyExcludePattern?: string | undefined;
  keySource?: string | undefined;
  keyPattern?: string | undefined;
  stringLiteralArgIndex?: number | undefined;
}

export interface ClosureCompilerCapabilities {
  classStaticBlocks: boolean;
  compilerVersion: string;
  prebundleTarget: string;
  privateClassElements: boolean;
  topLevelAwait: boolean;
}

export interface NativeBinding {
  closureCompilerCapabilities(): ClosureCompilerCapabilities;
  resolveViteTargetLanguageOut(target: string): string | null;
  collectFileStates(filePaths: string[]): NativeFileStateEntry[];
  matchFileStates(expected: NativeFileStateEntry[]): boolean;
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
    rollupChunks: NativeRollupChunkInput[],
    shimFiles: string[],
    vendorChunk: boolean,
  ): NativeChunkPlanChunkOutput[];
  minifyJavaScript(filePath: string, source: string): string;
  resolveGraph(
    entries: string[],
    srcDir: string,
    workspaceDir: string,
    packageMode: string,
    externalSpecifiers: string[],
    preservedFilePaths: string[],
  ): NativeResolveGraphOutput;
  rewriteGccExports(code: string): NativeGccExportsRewrite;
  emitPreservedModule(filePath: string, source: string): string;
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
