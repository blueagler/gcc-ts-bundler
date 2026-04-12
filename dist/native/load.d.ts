interface NativeEntryExportMetadata {
    exportNames: string[];
    hasDefaultExport: boolean;
    sourcePath: string;
}
interface NativeDependencyGraphEntry {
    dependencies: string[];
    filePath: string;
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
    kind?: "base" | "entry" | "lazy" | "shared";
    lazyModuleIds?: string[];
    name: string;
}
interface NativeClosureCompileJob {
    assumeFunctionWrapper: boolean;
    chunk?: string[];
    chunkOutputPathPrefix?: string;
    compilationLevel: string;
    dependencyMode?: string;
    entryPoint?: string[];
    externs: string[];
    js: string[];
    jsOutputFile?: string;
    languageIn: string;
    languageOut: string;
    propertyRenamingReportPath?: string;
    rewritePolyfills: boolean;
    warningLevel: string;
}
interface NativeGeneratedAsset {
    path: string;
    text: string;
}
interface NativeEs5HelperRewriteOutput {
    code: string;
    helperKeys: string[];
}
interface NativePostprocessAction {
    inputPath: string;
    kind: "copy" | "rewrite-decorator-metadata" | "rewrite-gcc-exports" | "rewrite-gcc-exports-and-decorator-metadata";
    outputPath: string;
    propertyRenamingReportPath?: string;
}
interface NativePrepareClosureJobsInput {
    chunkLoader: string;
    chunkMode: string;
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
    outDir: string;
    packageRoot: string;
    publicPath: string;
    supportFiles: string[];
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
interface NativeLazyImportEntry {
    importerFilePath: string;
    moduleId: string;
    specifier: string;
    targetPath: string;
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
interface NativeTranspileOutput {
    emittedFiles: string[];
    explicitExternPropertyCount: number;
    externsPath: string;
    preservedPropertyCount: number;
    supportFiles: string[];
}
interface NativeLazyImportInput {
    importerFilePath: string;
    moduleId: string;
    specifier: string;
    targetPath: string;
}
interface NativeTranspilePackageAlias {
    packageName: string;
    subpath: string;
    targetPath: string;
}
export declare function resolveGraph(input: {
    entries: string[];
    packageMode: string;
    srcDir: string;
    workspaceDir: string;
}): {
    entries: NativeEntryExportMetadata[];
    fileHashes: Record<string, string>;
    graph: Record<string, string[]>;
    lazyImports: NativeLazyImportEntry[];
    packageAliases: NativePackageAliasEntry[];
    packageJsonFiles: string[];
    sourceFiles: string[];
    trackedFiles: string[];
};
export declare function planChunks(input: {
    baseChunkName: string;
    chunkMode: string;
    entryFiles: NativeChunkPlanEntryInput[];
    graphEntries: NativeDependencyGraphEntry[];
    lazyImports: NativeLazyImportEntry[];
    shimFiles: string[];
    workspaceDir: string;
}): NativeChunkPlanChunkOutput[];
export declare function rewriteGccExports(code: string): string;
export declare function rewriteDecoratorMetadata(code: string, propertyRenamingReport: string): string;
export declare function transpileSources(input: {
    chunkMode: string;
    explicitExternPaths?: string[];
    externsPath: string;
    fileNames: string[];
    metadataPath: string;
    outDir: string;
    packageAliases?: NativeTranspilePackageAlias[];
    packageJsonFiles?: string[];
    lazyImports?: NativeLazyImportInput[];
    workspaceDir: string;
}): NativeTranspileOutput;
export declare function prepareClosureJobs(input: NativePrepareClosureJobsInput): NativePrepareClosureJobsOutput;
export declare function rewriteBundlerRuntimeEs5Helpers(code: string): NativeEs5HelperRewriteOutput;
export declare function writeEntryShims(input: {
    entries: Array<{
        exportNames: string[];
        hasDefaultExport: boolean;
        importPath: string;
        shimPath: string;
    }>;
}): string[];
export declare function collectFileStates(filePaths: string[]): NativeFileStateEntry[];
export declare function collectPublishedOutputStats(filePaths: string[]): NativePublishedOutputEntry[];
export declare function matchFileStates(expected: NativeFileStateEntry[]): boolean;
export declare function publishedOutputSnapshotMatches(publishedOutputs: NativePublishedOutputEntry[], outDir: string): boolean;
export declare function publishedOutputsMatch(outputFiles: string[], outDir: string): boolean;
export {};
