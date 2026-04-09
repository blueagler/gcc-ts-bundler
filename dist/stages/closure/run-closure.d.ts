import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
export interface ClosureStageResult {
    cacheOutputFiles: string[];
    exitCode: number;
    outputFiles: string[];
}
export declare function runClosureStage({ chunkPlan, emittedOutDir, explicitExternPaths, finalCacheDir, generatedExternPaths, nativeExternPath, options, outDir, projectCacheDir, supportFiles, packageRoot, }: {
    chunkPlan: ChunkPlanChunk[];
    emittedOutDir: string;
    explicitExternPaths: string[];
    finalCacheDir: string;
    generatedExternPaths: string[];
    nativeExternPath: string;
    options: NormalizedBuildOptions;
    outDir: string;
    projectCacheDir: string;
    supportFiles: string[];
    packageRoot: string;
}): Promise<ClosureStageResult>;
