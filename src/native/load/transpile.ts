import type {
  NativeClassMapCallInput,
  NativeExternalBoundaryEntry,
  NativeLazyImportInput,
  NativeResolvedImportEntry,
  NativeTranspileChunkInput,
  NativeTranspilePackageAlias,
  NativeTranspilePreservedModule,
} from "../abi";
import { loadBinding } from "./binding";

export function transpileSources(input: {
  chunkGraph: NativeTranspileChunkInput[];
  chunkMode: string;
  classMapCalls: NativeClassMapCallInput[];
  pureCallees: string[];
  typeInferenceDisabled: boolean;
  explicitExternPaths: string[];
  externsPath: string;
  fileNames: string[];
  metadataPath: string;
  outDir: string;
  target: string;
  packageAliases: NativeTranspilePackageAlias[];
  resolvedImports: NativeResolvedImportEntry[];
  externalBoundaries: NativeExternalBoundaryEntry[];
  opaqueExternalSpecifiers: string[];
  packageJsonFiles: string[];
  preservedModules: NativeTranspilePreservedModule[];
  lazyImports: NativeLazyImportInput[];
  runtimeModuleSourceMapFile: string | undefined;
  workspaceDir: string;
}) {
  // Spelled out rather than rest-spread: these keys reach the native addon,
  // and only a literal written against the boundary type keeps its property
  // names through the self-build's renaming.
  return loadBinding().transpileSources(
    input.fileNames,
    input.explicitExternPaths,
    input.outDir,
    input.externsPath,
    input.metadataPath,
    input.chunkMode,
    input.target,
    input.runtimeModuleSourceMapFile ?? null,
    input.workspaceDir,
    input.packageAliases.map((alias) => ({
      packageName: alias.packageName,
      subpath: alias.subpath,
      targetPath: alias.targetPath,
    })),
    input.resolvedImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    input.externalBoundaries.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      specifier: entry.specifier,
    })),
    input.opaqueExternalSpecifiers,
    input.packageJsonFiles,
    input.preservedModules.map((module) => ({
      exportNames: module.exportNames,
      filePath: module.filePath,
      hasDefaultExport: module.hasDefaultExport,
      moduleId: module.moduleId,
      outputRelativePath: module.outputRelativePath,
    })),
    input.lazyImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    input.chunkGraph.map((chunk) => ({
      dependencies: chunk.dependencies,
      files: chunk.files,
      name: chunk.name,
    })),
    input.classMapCalls.map((call) => ({
      argIndex: call.argIndex,
      callee: call.callee,
      calleeModulePattern: call.calleeModulePattern,
      keyExcludePattern: call.keyExcludePattern,
      keySource: call.keySource,
      keyPattern: call.keyPattern,
      stringLiteralArgIndex: call.stringLiteralArgIndex,
    })),
    input.pureCallees,
    input.typeInferenceDisabled,
  );
}
