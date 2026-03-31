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
export interface NativeFileStateEntry {
    exists: boolean;
    filePath: string;
    mtimeMs: number;
    size: number;
}
interface NativeTranspileOutput {
    emittedFiles: string[];
    externsPath: string;
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
    packageAliases: NativePackageAliasEntry[];
    packageJsonFiles: string[];
    sourceFiles: string[];
    trackedFiles: string[];
};
export declare function rewriteGccExports(code: string): string;
export declare function transpileSources(input: {
    externsPath: string;
    fileNames: string[];
    outDir: string;
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
export declare function matchFileStates(expected: NativeFileStateEntry[]): boolean;
export {};
