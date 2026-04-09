export interface FileStateSnapshot {
    mtimeMs: number;
    size: number;
}
interface PublishedOutputSnapshot {
    name: string;
    size: number;
}
export declare function collectTrackedFiles(filePaths: string[]): Promise<Record<string, FileStateSnapshot>>;
export declare function trackedFilesMatch(trackedFiles: Record<string, FileStateSnapshot>): Promise<boolean>;
export declare function filesExist(filePaths: string[]): Promise<boolean>;
export declare function publishedOutputsMatch(outputFiles: string[], outDir: string): Promise<boolean>;
export declare function publishedOutputsMatchSnapshot(publishedOutputs: PublishedOutputSnapshot[], outDir: string): Promise<boolean>;
export declare function collectPublishedOutputStats(outputFiles: string[]): Promise<import("../native/load").NativePublishedOutputEntry[]>;
export {};
