import { BuildContext, NormalizedBuildOptions, ResolvedBuild } from "../internal/types";
export { normalizeBuildOptions } from "./resolve-build/options";
export { getOptionsSignature, getPackageRoot, getPackageSignature, } from "./resolve-build/signatures";
export declare function createBuildContext(options: NormalizedBuildOptions): Promise<BuildContext>;
export declare function resolveBuild(context: BuildContext): Promise<ResolvedBuild>;
