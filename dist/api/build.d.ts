import { BuildOptions, BuildResult } from "./types";
import { cleanCache } from "../pipeline/build-pipeline";
export { cleanCache };
export declare const build: (options: BuildOptions) => Promise<BuildResult>;
export declare function runCli(args: string[]): Promise<number>;
export declare function main(args: string[]): Promise<number>;
