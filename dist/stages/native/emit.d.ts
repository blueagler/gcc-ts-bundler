import ts from "typescript";
import { LazyImport, NormalizedBuildOptions, PackageAlias } from "../../internal/types";
export interface NativeEmitStageResult {
    dependencyModules: string[];
    dependencyRuntimeFiles: string[];
    diagnostics: ts.Diagnostic[];
    emitSkipped: boolean;
    emittedFiles: string[];
    externsPath: string;
    outDir: string;
    supportFiles: string[];
}
export declare function emitNativeStage({ cacheDir, fileNames, lazyImports, metadataPath, options, packageAliases, packageJsonFiles, tsxRuntimeSourceFiles, tsConfigPath, workspaceDir, }: {
    cacheDir: string;
    fileNames: string[];
    lazyImports: LazyImport[];
    metadataPath: string;
    options: NormalizedBuildOptions;
    packageAliases: PackageAlias[];
    packageJsonFiles: string[];
    tsxRuntimeSourceFiles: string[];
    tsConfigPath: string;
    workspaceDir: string;
}): Promise<NativeEmitStageResult>;
