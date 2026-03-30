import { BuildOptions } from "../api/types";
import { BuildContext, NormalizedBuildOptions, ResolvedBuild } from "../internal/types";
export declare function createBuildContext(options: NormalizedBuildOptions): Promise<BuildContext>;
export declare function resolveBuild(context: BuildContext): Promise<ResolvedBuild>;
export declare function getPackageRoot(): string;
export declare function getPackageSignature(packageRoot?: string): Promise<string>;
export declare function getOptionsSignature(options: NormalizedBuildOptions): string;
export declare function normalizeBuildOptions(options: BuildOptions): NormalizedBuildOptions;
