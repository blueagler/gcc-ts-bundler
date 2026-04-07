import { ChunkPlanChunk, LazyImport, NormalizedBuildOptions } from "../../internal/types";
export interface ClosureStageResult {
    cacheOutputFiles: string[];
    exitCode: number;
    outputFiles: string[];
}
export declare function runClosureStage({ chunkPlan, emittedOutDir, externPaths, finalCacheDir, options, outDir, supportFiles, lazyImports, packageRoot, }: {
    chunkPlan: ChunkPlanChunk[];
    emittedOutDir: string;
    externPaths: string[];
    finalCacheDir: string;
    lazyImports: LazyImport[];
    options: NormalizedBuildOptions;
    outDir: string;
    supportFiles: string[];
    packageRoot: string;
}): Promise<ClosureStageResult>;
