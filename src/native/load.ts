import nativeBinding from "./index";

interface NativeEntryExportMetadata {
  exportNames: string[];
  hasDefaultExport: boolean;
  sourcePath: string;
}

interface NativeFileHashEntry {
  filePath: string;
  hash: string;
}

interface NativeDependencyGraphEntry {
  dependencies: string[];
  filePath: string;
}

interface NativePackageAliasEntry {
  packageName: string;
  subpath: string;
  targetPath: string;
}

interface NativeLazyImportEntry {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

interface NativeResolveGraphOutput {
  entries: NativeEntryExportMetadata[];
  fileHashes: NativeFileHashEntry[];
  graph: NativeDependencyGraphEntry[];
  lazyImports: NativeLazyImportEntry[];
  packageAliases: NativePackageAliasEntry[];
  packageJsonFiles: string[];
  sourceFiles: string[];
  trackedFiles: string[];
}

export interface NativeFileStateEntry {
  exists: boolean;
  filePath: string;
  mtimeMs: number;
  size: number;
}

export interface NativePublishedOutputEntry {
  name: string;
  size: number;
}

interface NativeShimEntry {
  exportNames: string[];
  hasDefaultExport: boolean;
  importPath: string;
  shimPath: string;
}

interface NativeTranspileOutput {
  emittedFiles: string[];
  externsPath: string;
  supportFiles: string[];
}

interface NativeLazyImportInput {
  importerFilePath: string;
  moduleId: string;
  specifier: string;
  targetPath: string;
}

interface NativeTranspilePackageAlias {
  packageName: string;
  subpath: string;
  targetPath: string;
}

interface NativeBinding {
  collectFileStates(filePaths: string[]): NativeFileStateEntry[];
  collectPublishedOutputStats(
    filePaths: string[],
  ): NativePublishedOutputEntry[];
  matchFileStates(expected: NativeFileStateEntry[]): boolean;
  publishedOutputSnapshotMatches(
    publishedOutputs: NativePublishedOutputEntry[],
    outDir: string,
  ): boolean;
  publishedOutputsMatch(outputFiles: string[], outDir: string): boolean;
  resolveGraph(
    entries: string[],
    srcDir: string,
    workspaceDir: string,
    packageMode: string,
  ): NativeResolveGraphOutput;
  rewriteGccExports(code: string): string;
  transpileSources(
    fileNames: string[],
    outDir: string,
    externsPath: string,
    metadataPath: string,
    chunkMode: string,
    workspaceDir: string,
    packageAliases: NativeTranspilePackageAlias[],
    packageJsonFiles: string[],
    lazyImports: NativeLazyImportInput[],
  ): NativeTranspileOutput;
  writeEntryShims(entries: NativeShimEntry[]): string[];
}

let cachedBinding: NativeBinding | null = null;

function loadBinding(): NativeBinding {
  if (cachedBinding) {
    return cachedBinding;
  }

  cachedBinding = nativeBinding as NativeBinding;
  return cachedBinding;
}

export function resolveGraph(input: {
  entries: string[];
  packageMode: string;
  srcDir: string;
  workspaceDir: string;
}) {
  const result = loadBinding().resolveGraph(
    input.entries,
    input.srcDir,
    input.workspaceDir,
    input.packageMode,
  );
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(
      result.fileHashes.map((entry) => [entry.filePath, entry.hash]),
    ) as Record<string, string>,
    graph: Object.fromEntries(
      result.graph.map((entry) => [entry.filePath, entry.dependencies]),
    ) as Record<string, string[]>,
    lazyImports: result.lazyImports,
    packageAliases: result.packageAliases,
    packageJsonFiles: result.packageJsonFiles,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles,
  };
}

export function rewriteGccExports(code: string) {
  return loadBinding().rewriteGccExports(code);
}

export function transpileSources(input: {
  chunkMode: string;
  externsPath: string;
  fileNames: string[];
  metadataPath: string;
  outDir: string;
  packageAliases?: NativeTranspilePackageAlias[];
  packageJsonFiles?: string[];
  lazyImports?: NativeLazyImportInput[];
  workspaceDir: string;
}) {
  return loadBinding().transpileSources(
    input.fileNames,
    input.outDir,
    input.externsPath,
    input.metadataPath,
    input.chunkMode,
    input.workspaceDir,
    input.packageAliases ?? [],
    input.packageJsonFiles ?? [],
    input.lazyImports ?? [],
  );
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

export function collectPublishedOutputStats(filePaths: string[]) {
  return loadBinding().collectPublishedOutputStats(filePaths);
}

export function matchFileStates(expected: NativeFileStateEntry[]) {
  return loadBinding().matchFileStates(expected);
}

export function publishedOutputSnapshotMatches(
  publishedOutputs: NativePublishedOutputEntry[],
  outDir: string,
) {
  return loadBinding().publishedOutputSnapshotMatches(publishedOutputs, outDir);
}

export function publishedOutputsMatch(outputFiles: string[], outDir: string) {
  return loadBinding().publishedOutputsMatch(outputFiles, outDir);
}
