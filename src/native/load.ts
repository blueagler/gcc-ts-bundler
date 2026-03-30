import fs from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

interface NativeEntryExportMetadata {
  exportNames: string[];
  hasDefaultExport: boolean;
  sourcePath: string;
}

interface NativeResolveGraphOutput {
  entries: NativeEntryExportMetadata[];
  fileHashes: Record<string, string>;
  filePaths: string[];
  graph: Record<string, string[]>;
}

interface NativeBinding {
  resolveGraphJson(input: string): string;
  rewriteGccExports(code: string): string;
  transpileSourcesJson(input: string): string;
  writeEntryShimsJson(input: string): string;
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
}): NativeResolveGraphOutput {
  return JSON.parse(
    loadBinding().resolveGraphJson(JSON.stringify(input)),
  ) as NativeResolveGraphOutput;
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
  return JSON.parse(
    loadBinding().transpileSourcesJson(JSON.stringify(input)),
  ) as {
    emittedFiles: string[];
    externsPath: string;
  };
}

export function writeEntryShims(input: {
  entries: Array<{
    exportNames: string[];
    hasDefaultExport: boolean;
    importPath: string;
    shimPath: string;
  }>;
}) {
  return JSON.parse(
    loadBinding().writeEntryShimsJson(JSON.stringify(input)),
  ) as string[];
}
