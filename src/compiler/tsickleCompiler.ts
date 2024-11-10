import path from "path";
import ts from "typescript";

import { Settings } from "../settings";
import * as tsickle from "../tsickle";
import { getCommonParentDirectory } from "../utils/fileUtils";
const modulePrefix = "_gcc_";
export async function toClosureJS(
  options: ts.CompilerOptions,
  fileNames: string[],
  settings: Settings,
  writeFile: ts.WriteFileCallback,
): Promise<tsickle.EmitResult> {
  const absoluteFileNames = fileNames.map((fileName) => path.resolve(fileName));
  const compilerHost = ts.createCompilerHost(options);
  const program = ts.createProgram(absoluteFileNames, options, compilerHost);
  const rootModulePath =
    options.rootDir || getCommonParentDirectory(absoluteFileNames);
  const filesToProcess = new Set(absoluteFileNames);
  const writePromises: Promise<void>[] = [];
  const asyncWriteFile: ts.WriteFileCallback = (
    fileName: string,
    content: string,
    writeByteOrderMark: boolean,
  ) => {
    const writePromise = new Promise<void>((resolve, reject) => {
      try {
        writeFile(fileName, content, writeByteOrderMark);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    writePromises.push(writePromise);
  };
  const transformerHost: tsickle.TsickleHost = {
    addDtsClutzAliases: true,
    fileNameToModuleId: (fileName) =>
      modulePrefix + path.relative(rootModulePath, fileName),
    generateExtraSuppressions: true,
    generateSummary: true,
    generateTsMigrationExportsShim: true,
    googmodule: true,
    logWarning: (warning) => {
      if (settings.verbose) {
        console.error(
          ts.formatDiagnosticsWithColorAndContext([warning], compilerHost),
        );
      } else {
        console.error(
          ts.flattenDiagnosticMessageText(warning.messageText, "\n"),
        );
      }
    },
    options,
    pathToModuleName: (context, fileName) =>
      fileName === "tslib"
        ? "tslib"
        : modulePrefix +
          tsickle.pathToModuleName(rootModulePath, context, fileName),
    provideExternalModuleDtsNamespace: true,
    rootDirsRelative: (fileName) => fileName,
    shouldIgnoreWarningsForPath: () => !settings.fatalWarnings,
    shouldSkipTsickleProcessing: (fileName) =>
      !filesToProcess.has(path.resolve(fileName)),
    transformDecorators: true,
    transformDynamicImport: "closure",
    transformTypesToClosure: true,
    typeBlackListPaths: new Set(),
    untyped: false,
    useDeclarationMergingTransformation: true,
  };
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externs: {},
      fileSummaries: new Map(),
      modulesManifest: new tsickle.ModulesManifest(),
      tsMigrationExportsShimFiles: new Map(),
    };
  }
  return new Promise(async (resolve, reject) => {
    try {
      const result = tsickle.emit(program, transformerHost, asyncWriteFile);
      await Promise.all(writePromises);
      resolve(result);
    } catch (error) {
      reject(error);
    }
  });
}
