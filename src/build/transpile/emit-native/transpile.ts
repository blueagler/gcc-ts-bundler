import type { CompatClassMapCall } from "../../../api/types";
import type {
  ChunkPlanChunk,
  ExternalBoundary,
  LazyImport,
  PackageAlias,
  PreservedModule,
  ResolvedImport,
} from "../../types";
import { transpileSources } from "../../../native/load";
import type { NativeTranspileOutput } from "../../../native/load";

export function runNativeTranspile({
  chunkMode,
  chunkPlan,
  classMapCalls,
  pureCallees,
  combinedFileNames,
  externalBoundaries,
  explicitExternPaths,
  externsPath,
  lazyImports,
  metadataPath,
  opaqueExternalSpecifiers,
  outDir,
  packageAliases,
  packageJsonFiles,
  preservedModules,
  resolvedImports,
  runtimeModuleSourceMapFile,
  target,
  typeInferenceDisabled,
  workspaceDir,
}: {
  chunkMode: string;
  chunkPlan: ChunkPlanChunk[];
  classMapCalls: CompatClassMapCall[];
  pureCallees: string[];
  combinedFileNames: string[];
  externalBoundaries: ExternalBoundary[];
  explicitExternPaths: string[];
  externsPath: string;
  lazyImports: LazyImport[];
  metadataPath: string;
  opaqueExternalSpecifiers: string[];
  outDir: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  preservedModules: PreservedModule[];
  resolvedImports: ResolvedImport[];
  runtimeModuleSourceMapFile: string | undefined;
  target: string;
  typeInferenceDisabled: boolean;
  workspaceDir: string;
}): NativeTranspileOutput {
  return transpileSources({
    chunkGraph: chunkPlan.map((chunk) => ({
      dependencies: chunk.dependencies,
      files: chunk.files,
      name: chunk.name,
    })),
    chunkMode,
    classMapCalls,
    pureCallees,
    explicitExternPaths,
    externalBoundaries,
    metadataPath,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    opaqueExternalSpecifiers,
    outDir,
    packageAliases,
    packageJsonFiles,
    preservedModules,
    resolvedImports,
    runtimeModuleSourceMapFile,
    target,
    typeInferenceDisabled,
    workspaceDir,
  });
}
