export type CompilationLevel = "WHITESPACE_ONLY" | "SIMPLE" | "ADVANCED";
export type LanguageOut = "ECMASCRIPT3" | "ECMASCRIPT5" | "ECMASCRIPT6" | "ECMASCRIPT_NEXT";
export type CacheMode = "off" | "temp" | "persistent";
export type DiagnosticsPreflight = "off" | "errors-only" | "full";
export type PackageMode = "off" | "esm-only";
export type ChunkMode = "off" | "bundler-runtime";
export type ChunkLoader = "script";
export type ChunkLoaderInput = ChunkLoader | "auto";
export interface CacheOptions {
    dir?: string;
    mode?: CacheMode;
}
export interface DiagnosticsOptions {
    fatalWarnings?: boolean;
    preflight?: DiagnosticsPreflight;
    verbose?: boolean;
}
export interface PackageOptions {
    mode?: PackageMode;
}
export interface ChunkOptions {
    baseChunkName?: string;
    loader?: ChunkLoaderInput;
    manifestFile?: string;
    mode?: ChunkMode;
    publicPath?: string;
}
export interface BuildOptions {
    cache?: CacheOptions;
    compilationLevel?: CompilationLevel;
    diagnostics?: DiagnosticsOptions;
    entries: string[];
    externs?: string[];
    js?: string[];
    languageOut?: LanguageOut;
    chunks?: ChunkOptions;
    outDir?: string;
    outputNames?: string[];
    packages?: PackageOptions;
    projectRoot?: string;
    srcDir?: string;
}
export interface CleanCacheOptions {
    cacheDir?: string;
    projectRoot?: string;
}
export interface BuildResult {
    cacheHit: boolean;
    diagnostics: unknown[];
    emitSkipped: boolean;
    exitCode: number;
    outputFiles: string[];
}
export declare const DEFAULT_BUILD_OPTIONS: Readonly<{
    cache: {
        dir: string;
        mode: CacheMode;
    };
    compilationLevel: CompilationLevel;
    chunks: {
        baseChunkName: string;
        loader: ChunkLoaderInput;
        manifestFile: string;
        mode: ChunkMode;
        publicPath: string;
    };
    diagnostics: {
        fatalWarnings: boolean;
        preflight: DiagnosticsPreflight;
        verbose: boolean;
    };
    entries: string[];
    externs: string[];
    js: string[];
    languageOut: LanguageOut;
    outDir: "";
    outputNames: string[];
    packages: {
        mode: PackageMode;
    };
    projectRoot: "";
    srcDir: "";
}>;
