import { toRecord } from "../../shared/records";
import type {
  NativeChunkPlanEntryInput,
  NativeDependencyGraphEntry,
  NativeFileStateEntry,
  NativeLazyImportEntry,
  NativePrepareClosureJobsInput,
  NativeResolveGraphOutput,
  NativeRollupChunkInput,
} from "../abi";
import { loadBinding } from "./binding";

export { transpileSources } from "./transpile";

type NativeResolvedGraphOutput = Omit<
  NativeResolveGraphOutput,
  "fileHashes" | "graph"
> & {
  fileHashes: Record<string, string>;
  graph: Record<string, string[]>;
};

export function closureCompilerCapabilities() {
  return loadBinding().closureCompilerCapabilities();
}

export function resolveViteTargetLanguageOut(target: string) {
  return loadBinding().resolveViteTargetLanguageOut(target);
}

export function resolveGraph(input: {
  entries: string[];
  externalSpecifiers?: string[] | undefined;
  packageMode: string;
  preservedFilePaths?: string[] | undefined;
  srcDir: string;
  target?: string | undefined;
  workspaceDir: string;
}): NativeResolvedGraphOutput {
  const result = loadBinding().resolveGraph(
    input.entries,
    input.srcDir,
    input.workspaceDir,
    input.target && input.target !== "browser"
      ? `${input.packageMode}:${input.target}`
      : input.packageMode,
    input.externalSpecifiers ?? [],
    input.preservedFilePaths ?? [],
  );
  return {
    entries: result.entries,
    externalBoundaries: result.externalBoundaries,
    fileHashes: toRecord(
      result.fileHashes.map((entry): readonly [string, string] => [
        entry.filePath,
        entry.hash,
      ]),
    ),
    graph: toRecord(
      result.graph.map((entry): readonly [string, string[]] => [
        entry.filePath,
        entry.dependencies,
      ]),
    ),
    lazyImports: result.lazyImports,
    packageAliases: result.packageAliases,
    resolvedImports: result.resolvedImports,
    packageJsonFiles: result.packageJsonFiles,
    preservedModules: result.preservedModules,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles,
  };
}

export function planChunks(input: {
  baseChunkName: string;
  chunkMode: string;
  entryFiles: NativeChunkPlanEntryInput[];
  graphEntries: NativeDependencyGraphEntry[];
  lazyImports: NativeLazyImportEntry[];
  /** Rollup's own chunk graph; present only under Vite, and mirrored when it is. */
  rollupChunks: NativeRollupChunkInput[];
  shimFiles: string[];
  /** Already gated by `resolveVendorChunk`; native ignores it off bundler-runtime. */
  vendorChunk: boolean;
  workspaceDir: string;
}) {
  // Spelled out rather than rest-spread: these keys reach the native addon,
  // and only a literal written against the boundary type keeps its property
  // names through the self-build's renaming.
  return loadBinding().planChunks(
    input.chunkMode,
    input.baseChunkName,
    input.workspaceDir,
    input.entryFiles.map((entry) => ({
      chunkName: entry.chunkName,
      outputName: entry.outputName,
      sourcePath: entry.sourcePath,
    })),
    input.graphEntries.map((entry) => ({
      dependencies: entry.dependencies,
      filePath: entry.filePath,
    })),
    input.lazyImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    input.rollupChunks.map((chunk) => ({
      dynamicImportedChunkFileNames: chunk.dynamicImportedChunkFileNames,
      fileName: chunk.fileName,
      importedChunkFileNames: chunk.importedChunkFileNames,
      isEntry: chunk.isEntry,
      moduleFiles: chunk.moduleFiles,
      name: chunk.name,
    })),
    input.shimFiles,
    input.vendorChunk,
  );
}

export function minifyJavaScript(filePath: string, source: string) {
  return loadBinding().minifyJavaScript(filePath, source);
}

export function rewriteGccExports(code: string) {
  return loadBinding().rewriteGccExports(code);
}

export function emitPreservedModule(filePath: string, source: string) {
  return loadBinding().emitPreservedModule(filePath, source);
}

export function prepareClosureJobs(input: NativePrepareClosureJobsInput) {
  return loadBinding().prepareClosureJobs(input);
}

export function writeEntryShims(input: {
  entries: Array<{
    exportNames: string[];
    hasDefaultExport: boolean;
    importPath: string;
    shimPath: string;
  }>;
}) {
  return loadBinding().writeEntryShims(input.entries);
}

export function collectFileStates(filePaths: string[]) {
  return loadBinding().collectFileStates(filePaths);
}

export function matchFileStates(expected: NativeFileStateEntry[]) {
  return loadBinding().matchFileStates(
    expected.map((state) => ({
      // Spelled out rather than rest-spread: these keys reach the native addon,
      // and only a literal written against the boundary type keeps its property
      // names through the self-build's renaming.
      exists: state.exists,
      filePath: state.filePath,
      mtimeMs: state.mtimeMs,
      size: state.size,
    })),
  );
}
