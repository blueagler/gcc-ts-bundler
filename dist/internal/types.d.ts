import type { BuildOptions, CacheOptions, CompilationLevel, DiagnosticsOptions, LanguageOut } from "../api/types";
import type { FileStateSnapshot } from "./file-state";
export interface NormalizedBuildOptions {
    cache: Required<CacheOptions>;
    compilationLevel: CompilationLevel;
    diagnostics: Required<DiagnosticsOptions>;
    entries: string[];
    externs: string[];
    js: string[];
    languageOut: LanguageOut;
    outDir: string;
    outputNames: string[];
    projectRoot: string;
    srcDir: string;
}
export interface CliParseResult {
    options: BuildOptions;
    showHelp: boolean;
}
export interface BuildEntry {
    chunkName: string;
    exportNames: string[];
    hasDefaultExport: boolean;
    outputName: string;
    sourcePath: string;
    sourceRelativePath: string;
}
export interface ChunkPlanChunk {
    dependencies: string[];
    files: string[];
    name: string;
}
export interface BuildContext {
    options: NormalizedBuildOptions;
    optionsSignature: string;
    packageRoot: string;
    packageSignature: string;
    projectCacheDir: string;
}
export interface ResolvedBuild {
    cleanup(): Promise<void>;
    chunkPlan: ChunkPlanChunk[];
    entryFiles: BuildEntry[];
    filePaths: string[];
    finalCacheDir: string;
    finalKey: string;
    nativeEmitCacheDir: string;
    shimDir: string;
    shimFiles: string[];
    trackedFiles: Record<string, FileStateSnapshot>;
    tsConfigPath: string;
    workspaceDir: string;
}
