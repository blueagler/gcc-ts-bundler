import path from "path";
import * as tsickle from "tsickle";
import ts from "typescript";

import { Settings } from "../settings";
import { getCommonParentDirectory } from "../utils/fileUtils";

const modulePrefix = "_gcc_";

export function toClosureJS(
  options: ts.CompilerOptions,
  fileNames: string[],
  settings: Settings,
  writeFile: ts.WriteFileCallback,
): tsickle.EmitResult {
  const absoluteFileNames = fileNames.map((fileName) => path.resolve(fileName));
  const compilerHost = ts.createCompilerHost(options);
  const program = ts.createProgram(absoluteFileNames, options, compilerHost);

  const rootModulePath =
    options.rootDir || getCommonParentDirectory(absoluteFileNames);
  const filesToProcess = new Set(absoluteFileNames);

  const transformerHost: tsickle.TsickleHost = {
    addDtsClutzAliases: true,
    fileNameToModuleId: (fileName) =>
      modulePrefix + path.relative(rootModulePath, fileName),
    generateExtraSuppressions: true,
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
    rootDirsRelative: (fileName) => fileName,
    shouldIgnoreWarningsForPath: () => !settings.fatalWarnings,
    shouldSkipTsickleProcessing: (fileName) =>
      !filesToProcess.has(path.resolve(fileName)),
    transformDecorators: true,
    transformDynamicImport: "nodejs",
    transformTypesToClosure: true,
    typeBlackListPaths: new Set(),
    untyped: false,
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

  return tsickle.emit(program, transformerHost, writeFile);
}
