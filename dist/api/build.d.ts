import { BuildOptions, BuildResult } from "./types";
import { generateExterns } from "./externs";
import { cleanCache } from "../pipeline/build-pipeline";
export { cleanCache };
export declare const build: (options: BuildOptions) => Promise<BuildResult>;
export { generateExterns };
export declare function runCli(args: string[]): Promise<number>;
export declare function main(args: string[]): Promise<number>;
