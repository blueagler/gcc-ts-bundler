import ts from "typescript";
import { NormalizedBuildOptions } from "../../internal/types";
export interface NativeEmitStageResult {
    diagnostics: ts.Diagnostic[];
    emitSkipped: boolean;
    emittedFiles: string[];
    externsPath: string;
    outDir: string;
}
export declare function emitNativeStage({ cacheDir, fileNames, metadataPath, options, tsConfigPath, workspaceDir, }: {
    cacheDir: string;
    fileNames: string[];
    metadataPath: string;
    options: NormalizedBuildOptions;
    tsConfigPath: string;
    workspaceDir: string;
}): Promise<NativeEmitStageResult>;
