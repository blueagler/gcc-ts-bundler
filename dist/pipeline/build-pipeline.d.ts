import { BuildOptions, BuildResult, CleanCacheOptions } from "../api/types";
export declare function build(options: BuildOptions): Promise<BuildResult>;
export declare function cleanCache(options?: CleanCacheOptions): Promise<void>;
