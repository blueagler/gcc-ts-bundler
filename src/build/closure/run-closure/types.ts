import type { TypeWorld } from "../../../externs/context";
import type { NativeEmittedTypeMetadata } from "../../../native/load";
import type {
  BuildEntry,
  ChunkPlanChunk,
  PreservedImport,
  PreservedModule,
  ResolvedBuildOptions,
} from "../../types";
import type { ClosureCompilerEnvironment } from "../compiler";

export interface ClosureStageResult {
  cacheOutputFiles: string[];
  exitCode: number;
  outputFiles: string[];
}

export type ClosureStageInput = {
  closureCompilerEnvironment: ClosureCompilerEnvironment;
  chunkPlan: ChunkPlanChunk[];
  emittedOutDir: string;
  entryFiles: BuildEntry[];
  entryShebangs: Array<{ shebang: string; sourcePath: string }>;
  explicitExternPaths: string[];
  finalCacheDir: string;
  generatedExternPaths: string[];
  nativeExternPath: string;
  options: ResolvedBuildOptions;
  outDir: string;
  projectCacheDir: string;
  supportFiles: string[];
  typeMetadata: NativeEmittedTypeMetadata[];
  packageRoot: string;
  preservedImports: PreservedImport[];
  preservedModules: PreservedModule[];
  typeWorld?: TypeWorld | undefined;
};
