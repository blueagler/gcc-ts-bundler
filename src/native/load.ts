import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

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

interface NativeResolveGraphOutput {
  entries: NativeEntryExportMetadata[];
  fileHashes: NativeFileHashEntry[];
  filePaths: string[];
  graph: NativeDependencyGraphEntry[];
}

export interface NativeFileStateEntry {
  exists: boolean;
  filePath: string;
  mtimeMs: number;
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
}

interface NativeBinding {
  collectFileStates(filePaths: string[]): NativeFileStateEntry[];
  matchFileStates(expected: NativeFileStateEntry[]): boolean;
  resolveGraph(
    entries: string[],
    srcDir: string,
    workspaceDir: string,
  ): NativeResolveGraphOutput;
  rewriteGccExports(code: string): string;
  transpileSources(
    fileNames: string[],
    outDir: string,
    externsPath: string,
    workspaceDir: string,
  ): NativeTranspileOutput;
  writeEntryShims(entries: NativeShimEntry[]): string[];
}

let cachedBinding: NativeBinding | null = null;

function loadBinding(): NativeBinding {
  if (cachedBinding) {
    return cachedBinding;
  }

  const nativeModulePath = require.resolve("gcc-ts-bundler/native");
  if (!fs.existsSync(nativeModulePath)) {
    throw new Error(
      `Native module not found at ${nativeModulePath}. Run \`bun run build:native\` in gcc-ts-bundler.`,
    );
  }

  cachedBinding = require(nativeModulePath) as NativeBinding;
  return cachedBinding;
}

export function resolveGraph(input: {
  entries: string[];
  srcDir: string;
  workspaceDir: string;
}) {
  const result = loadBinding().resolveGraph(
    input.entries,
    input.srcDir,
    input.workspaceDir,
  );
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(
      result.fileHashes.map((entry) => [entry.filePath, entry.hash]),
    ) as Record<string, string>,
    filePaths: result.filePaths,
    graph: Object.fromEntries(
      result.graph.map((entry) => [entry.filePath, entry.dependencies]),
    ) as Record<string, string[]>,
  };
}

export function rewriteGccExports(code: string) {
  return loadBinding().rewriteGccExports(code);
}

export function transpileSources(input: {
  externsPath: string;
  fileNames: string[];
  outDir: string;
  workspaceDir: string;
}) {
  return loadBinding().transpileSources(
    input.fileNames,
    input.outDir,
    input.externsPath,
    input.workspaceDir,
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

export function matchFileStates(expected: NativeFileStateEntry[]) {
  return loadBinding().matchFileStates(expected);
}
