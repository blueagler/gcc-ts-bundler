import ts from "typescript";
import { NormalizedBuildOptions, PackageAlias } from "../../internal/types";
export interface NativeEmitStageResult {
    diagnostics: ts.Diagnostic[];
    emitSkipped: boolean;
    emittedFiles: string[];
    externsPath: string;
    outDir: string;
    supportFiles: string[];
}
export declare function emitNativeStage({ cacheDir, fileNames, metadataPath, options, packageAliases, packageJsonFiles, tsConfigPath, workspaceDir, }: {
    cacheDir: string;
    fileNames: string[];
    metadataPath: string;
    options: NormalizedBuildOptions;
    packageAliases: PackageAlias[];
    packageJsonFiles: string[];
    tsConfigPath: string;
    workspaceDir: string;
}): Promise<NativeEmitStageResult>;
