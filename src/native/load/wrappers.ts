import type {
  NativeFileStateEntry,
  NativePlanChunksInput,
  NativePrepareClosureJobsInput,
  NativeResolveGraphOutput,
  NativeShimEntry,
} from "../abi";
import { loadBinding } from "./binding";

export { transpileSources } from "./transpile";

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
}): NativeResolveGraphOutput {
  return loadBinding().resolveGraph(
    input.entries,
    input.srcDir,
    input.workspaceDir,
    input.target && input.target !== "browser"
      ? `${input.packageMode}:${input.target}`
      : input.packageMode,
    input.externalSpecifiers ?? [],
    input.preservedFilePaths ?? [],
  );
}

export function planChunks(input: NativePlanChunksInput) {
  // Spelled out rather than rest-spread: these keys reach the native addon,
  // and only a literal written against the boundary type keeps its property
  // names through the self-build's renaming.
  const nativeInput: NativePlanChunksInput = {
    chunkMode: input.chunkMode,
    baseChunkName: input.baseChunkName,
    workspaceDir: input.workspaceDir,
    entryFiles: input.entryFiles.map((entry) => ({
      outputName: entry.outputName,
      sourcePath: entry.sourcePath,
      shimPath: entry.shimPath,
    })),
    graphEntries: input.graphEntries.map((entry) => ({
      dependencies: entry.dependencies,
      filePath: entry.filePath,
    })),
    lazyImports: input.lazyImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    rollupChunks: input.rollupChunks.map((chunk) => ({
      fileName: chunk.fileName,
      importedChunkFileNames: chunk.importedChunkFileNames,
      isEntry: chunk.isEntry,
      moduleFiles: chunk.moduleFiles,
      name: chunk.name,
    })),
    vendorChunk: input.vendorChunk,
  };
  return loadBinding().planChunks(nativeInput);
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

export function writeEntryShims(input: { entries: NativeShimEntry[] }) {
  return loadBinding().writeEntryShims(
    input.entries.map((entry) => ({
      constEnumExportNames: entry.constEnumExportNames,
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      importPath: entry.importPath,
      shimPath: entry.shimPath,
    })),
  );
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
