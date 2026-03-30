import { CacheMode } from "../api/types";
export interface CacheStore {
    cleanup(): Promise<void>;
    mode: CacheMode;
    projectCacheDir: string;
    rootDir: string;
    workspaceDir: string;
}
export declare function getDefaultPersistentCacheRoot(): string;
export declare function createCacheStore({ cacheDir, mode, projectRoot, }: {
    cacheDir?: string;
    mode: CacheMode;
    projectRoot: string;
}): Promise<CacheStore>;
export declare function readJsonIfExists<T>(filePath: string): Promise<T | null>;
export declare function writeJson(filePath: string, value: unknown): Promise<void>;
