import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
export interface ClosureStageResult {
    cacheOutputFiles: string[];
    exitCode: number;
    outputFiles: string[];
}
export declare function runClosureStage({ chunkPlan, emittedOutDir, externPaths, finalCacheDir, options, outDir, supportFiles, packageRoot, }: {
    chunkPlan: ChunkPlanChunk[];
    emittedOutDir: string;
    externPaths: string[];
    finalCacheDir: string;
    options: NormalizedBuildOptions;
    outDir: string;
    supportFiles: string[];
    packageRoot: string;
}): Promise<ClosureStageResult>;
