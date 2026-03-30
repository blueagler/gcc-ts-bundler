import { ChunkPlanChunk, NormalizedBuildOptions } from "../../internal/types";
export interface ClosureStageResult {
    cacheOutputFiles: string[];
    exitCode: number;
    outputFiles: string[];
}
export declare function runClosureStage({ chunkPlan, emittedOutDir, externPaths, finalCacheDir, options, outDir, packageRoot, }: {
    chunkPlan: ChunkPlanChunk[];
    emittedOutDir: string;
    externPaths: string[];
    finalCacheDir: string;
    options: NormalizedBuildOptions;
    outDir: string;
    packageRoot: string;
}): Promise<ClosureStageResult>;
