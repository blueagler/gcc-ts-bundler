import type {
  NativeClassMapCallInput,
  NativeExternalBoundaryEntry,
  NativeLazyImportInput,
  NativeResolvedImportEntry,
  NativeTranspileChunkInput,
  NativeTranspilePackageAlias,
  NativeTranspilePreservedModule,
  NativeTranspileSourcesInput,
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
  const nativeInput: NativeTranspileSourcesInput = {
    fileNames: input.fileNames,
    explicitExternPaths: input.explicitExternPaths,
    outDir: input.outDir,
    externsPath: input.externsPath,
    metadataPath: input.metadataPath,
    chunkMode: input.chunkMode,
    target: input.target,
    runtimeModuleSourceMapFile: input.runtimeModuleSourceMapFile,
    workspaceDir: input.workspaceDir,
    packageAliases: input.packageAliases.map((alias) => ({
      packageName: alias.packageName,
      subpath: alias.subpath,
      targetPath: alias.targetPath,
    })),
    resolvedImports: input.resolvedImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    externalBoundaries: input.externalBoundaries.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      specifier: entry.specifier,
    })),
    opaqueExternalSpecifiers: input.opaqueExternalSpecifiers,
    packageJsonFiles: input.packageJsonFiles,
    preservedModules: input.preservedModules.map((module) => ({
      exportNames: module.exportNames,
      filePath: module.filePath,
      hasDefaultExport: module.hasDefaultExport,
      moduleId: module.moduleId,
      outputRelativePath: module.outputRelativePath,
    })),
    lazyImports: input.lazyImports.map((entry) => ({
      importerFilePath: entry.importerFilePath,
      moduleId: entry.moduleId,
      specifier: entry.specifier,
      targetPath: entry.targetPath,
    })),
    chunkGraph: input.chunkGraph.map((chunk) => ({
      dependencies: chunk.dependencies,
      files: chunk.files,
      name: chunk.name,
    })),
    classMapCalls: input.classMapCalls.map((call) => ({
      argIndex: call.argIndex,
      callee: call.callee,
      calleeModulePattern: call.calleeModulePattern,
      keyExcludePattern: call.keyExcludePattern,
      keySource: call.keySource,
      keyPattern: call.keyPattern,
      stringLiteralArgIndex: call.stringLiteralArgIndex,
    })),
    pureCallees: input.pureCallees,
    typeInferenceDisabled: input.typeInferenceDisabled,
  };
  return loadBinding().transpileSources(nativeInput);
}
