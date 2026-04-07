interface NativeEntryExportMetadata {
    exportNames: string[];
    hasDefaultExport: boolean;
    sourcePath: string;
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
    externsPath: string;
    supportFiles: string[];
}
interface NativeLazyImportInput {
    importerFilePath: string;
    moduleId: string;
    preloadBindingName?: string;
    runtimeBindingName?: string;
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
export declare function rewriteGccExports(code: string): string;
export declare function transpileSources(input: {
    externsPath: string;
    fileNames: string[];
    metadataPath: string;
    outDir: string;
    packageAliases?: NativeTranspilePackageAlias[];
    packageJsonFiles?: string[];
    lazyImports?: NativeLazyImportInput[];
    workspaceDir: string;
}): NativeTranspileOutput;
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
