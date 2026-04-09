import { BuildOptions, BuildResult } from "./types";
import { generateExterns } from "./externs";
export declare function cleanCache(options: {
    cacheDir?: string;
    projectRoot?: string;
}): Promise<void>;
export declare const build: (options: BuildOptions) => Promise<BuildResult>;
export { generateExterns };
export declare function runCli(args: string[]): Promise<number>;
export declare function main(args: string[]): Promise<number>;
