export type CompilationLevel = "WHITESPACE_ONLY" | "SIMPLE" | "ADVANCED";
export type LanguageOut = "ECMASCRIPT3" | "ECMASCRIPT5" | "ECMASCRIPT6" | "ECMASCRIPT_NEXT";
export type CacheMode = "off" | "temp" | "persistent";
export type DiagnosticsPreflight = "off" | "errors-only" | "full";
export interface CacheOptions {
    dir?: string;
    mode?: CacheMode;
}
export interface DiagnosticsOptions {
    fatalWarnings?: boolean;
    preflight?: DiagnosticsPreflight;
    verbose?: boolean;
}
export interface BuildOptions {
    cache?: CacheOptions;
    compilationLevel?: CompilationLevel;
    diagnostics?: DiagnosticsOptions;
    entries: string[];
    externs?: string[];
    js?: string[];
    languageOut?: LanguageOut;
    outDir?: string;
    outputNames?: string[];
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
    projectRoot: "";
    srcDir: "";
}>;
