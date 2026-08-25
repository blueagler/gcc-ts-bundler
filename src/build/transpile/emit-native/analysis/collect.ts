import fs from "fs";
import ts from "@typescript/typescript6";

import { uniqueSortedStrings } from "../../../../shared/files";
import {
  logInternalDetail,
  withInternalTiming,
} from "../../../../shared/timing";
import type { ResolvedBuildOptions } from "../../../types";
import {
  type ClosureTypeMetadataFile,
  type TypeMetadataCounts,
  type TypeMetadataDiagnostic,
  collectNativeTypeMetadataFromContext,
  createNativeTypeAnalysisContext,
  scanNativeTypeAnalysisContext,
} from "../../type-metadata";
import type { TypeWorld } from "../../../../externs/context";
import { classifyClosureIrSourceFile } from "../../type-metadata/metadata/scan";
import {
  collectNativePreflightDiagnostics,
  loadViteAuthoredFiles,
} from "../../type-metadata/preflight";

interface QuickScannedNativeFile {
  fileName: string;
  features: ReturnType<typeof classifyClosureIrSourceFile>;
  parseDiagnostics: ts.Diagnostic[];
}

export async function collectNativeAnalysis({
  boundaryModuleFileNames,
  externalSpecifiers,
  fileNames,
  options,
  tsConfigPath,
  typeWorld,
  workspaceDir,
}: {
  boundaryModuleFileNames: string[];
  externalSpecifiers: string[];
  fileNames: string[];
  options: ResolvedBuildOptions;
  tsConfigPath: string;
  typeWorld?: TypeWorld | undefined;
  workspaceDir: string;
}) {
  if (!canUseJsAnalysisFastPath(fileNames, options.viteAuthoredFilesFile)) {
    const analysisContext = await withInternalTiming(
      "native-emit:analysis-context",
      () =>
        createNativeTypeAnalysisContext({
          fileNames,
          tsConfigPath,
          typeWorld,
          workspaceDir,
        }),
    );
    const analysisScan = await withInternalTiming(
      "native-emit:analysis-scan",
      () =>
        Promise.resolve(
          scanNativeTypeAnalysisContext({ context: analysisContext }),
        ),
    );
    const preflightDiagnostics = await withInternalTiming(
      "native-emit:preflight",
      () =>
        Promise.resolve(
          collectNativePreflightDiagnostics({
            authoredFiles: loadViteAuthoredFiles(options.viteAuthoredFilesFile),
            preflight: options.diagnostics.preflight,
            program: analysisContext.program,
            scan: analysisScan,
          }),
        ),
    );
    const analysis = await withInternalTiming("native-emit:closure-ir", () =>
      Promise.resolve(
        collectNativeTypeMetadataFromContext({
          boundaryModuleFileNames,
          context: analysisContext,
          externalSpecifiers,
          scan: analysisScan,
        }),
      ),
    );
    return {
      dependencies: collectAnalysisDependencies(
        analysisContext.program,
        fileNames,
        tsConfigPath,
      ),
      diagnostics: analysis.diagnostics,
      extractedCounts: analysis.extractedCounts,
      files: analysis.files,
      preflightDiagnostics,
      typeMetadataDiagnostics: analysis.typeMetadataDiagnostics,
    };
  }

  const authoredFiles = loadViteAuthoredFiles(options.viteAuthoredFilesFile);
  const quickScanFiles = await withInternalTiming(
    "native-emit:quick-scan",
    () => scanNativeFilesQuickly(fileNames),
  );
  const checkerRequiredFileNames = quickScanFiles
    .filter(
      ({ features, fileName }) =>
        features.shouldAnalyze ||
        boundaryModuleFileNames.length > 0 ||
        externalSpecifiers.length > 0 ||
        (features.needsSemanticPreflight &&
          (authoredFiles ? authoredFiles.has(fileName) : true)),
    )
    .map(({ fileName }) => fileName);
  const checkerRequiredFileSet = new Set(checkerRequiredFileNames);
  const trivialJsFiles = quickScanFiles.filter(
    ({ fileName }) => !checkerRequiredFileSet.has(fileName),
  );
  logInternalDetail(
    "native-emit:checker-required-files",
    `${checkerRequiredFileNames.length}`,
  );
  logInternalDetail("native-emit:trivial-js-files", `${trivialJsFiles.length}`);

  const analysisContext =
    checkerRequiredFileNames.length > 0 ||
    options.diagnostics.preflight !== "off"
      ? await withInternalTiming("native-emit:analysis-context", () =>
          createNativeTypeAnalysisContext({
            fileNames: checkerRequiredFileNames,
            tsConfigPath,
            typeWorld,
            workspaceDir,
          }),
        )
      : null;
  const analysisScan = analysisContext
    ? await withInternalTiming("native-emit:analysis-scan", () =>
        Promise.resolve(
          scanNativeTypeAnalysisContext({ context: analysisContext }),
        ),
      )
    : null;
  if (!analysisScan) {
    logInternalDetail(
      "native-emit:analysis-scan:files",
      `0/${quickScanFiles.length}`,
    );
  }
  const preflightDiagnostics =
    analysisContext && analysisScan
      ? await withInternalTiming("native-emit:preflight", () =>
          Promise.resolve(
            collectNativePreflightDiagnostics({
              additionalSyntacticDiagnostics: quickScanFiles.flatMap(
                ({ parseDiagnostics }) => parseDiagnostics,
              ),
              authoredFiles,
              preflight: options.diagnostics.preflight,
              program: analysisContext.program,
              scan: analysisScan,
            }),
          ),
        )
      : [];

  const checkerAnalysis: {
    diagnostics: ts.Diagnostic[];
    extractedCounts: TypeMetadataCounts;
    files: ClosureTypeMetadataFile[];
    typeMetadataDiagnostics: TypeMetadataDiagnostic[];
  } =
    analysisContext && analysisScan && checkerRequiredFileNames.length > 0
      ? await withInternalTiming("native-emit:closure-ir", () =>
          Promise.resolve(
            collectNativeTypeMetadataFromContext({
              boundaryModuleFileNames,
              context: analysisContext,
              externalSpecifiers,
              scan: analysisScan,
            }),
          ),
        )
      : {
          diagnostics: [],
          extractedCounts: {
            annotationCount: 0,
            enumDeclarationCount: 0,
            memberAnnotationCount: 0,
            typeDeclarationCount: 0,
            unresolvedTypeReferenceCount: 0,
          },
          files: [],
          typeMetadataDiagnostics: [],
        };
  const checkerFileMap = new Map(
    checkerAnalysis.files.map(
      (file): readonly [string, ClosureTypeMetadataFile] => [
        file.filePath,
        file,
      ],
    ),
  );

  return {
    dependencies: collectAnalysisDependencies(
      analysisContext?.program,
      fileNames,
      tsConfigPath,
    ),
    diagnostics: checkerAnalysis.diagnostics,
    extractedCounts: checkerAnalysis.extractedCounts,
    files: fileNames.map(
      (fileName) =>
        checkerFileMap.get(fileName) ?? createTrivialTypeMetadataFile(fileName),
    ),
    preflightDiagnostics,
    typeMetadataDiagnostics: checkerAnalysis.typeMetadataDiagnostics,
  };
}

function collectAnalysisDependencies(
  program: ts.Program | undefined,
  fileNames: string[],
  tsConfigPath: string,
) {
  return uniqueSortedStrings([
    ...fileNames,
    tsConfigPath,
    ...(program?.getSourceFiles() ?? [])
      .filter((sourceFile) => !program?.isSourceFileDefaultLibrary(sourceFile))
      .map((sourceFile) => sourceFile.fileName),
  ]);
}

async function scanNativeFilesQuickly(fileNames: string[]) {
  const files = await Promise.all(
    fileNames.map(async (fileName) => {
      const text = await fs.promises.readFile(fileName, "utf8");
      const sourceFile = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        true,
        resolveScriptKind(fileName),
      );
      return {
        features: classifyClosureIrSourceFile(sourceFile),
        fileName,
        parseDiagnostics: getSourceFileParseDiagnostics(sourceFile),
      } satisfies QuickScannedNativeFile;
    }),
  );
  return files;
}

function canUseJsAnalysisFastPath(
  fileNames: string[],
  authoredFilesFile: string | undefined,
) {
  if (!authoredFilesFile) {
    return false;
  }
  return fileNames.every((fileName) => /\.(?:[cm]?jsx?)$/u.test(fileName));
}

function createTrivialTypeMetadataFile(
  filePath: string,
): ClosureTypeMetadataFile {
  return {
    annotations: [],
    declarations: [],
    decoratedOutputText: undefined,
    diagnostics: [],
    enums: [],
    filePath,
    sourceFilePath: filePath,
    symbols: [],
  };
}

function resolveScriptKind(fileName: string) {
  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
}

function getSourceFileParseDiagnostics(sourceFile: ts.SourceFile) {
  return hasParseDiagnostics(sourceFile)
    ? [...sourceFile.parseDiagnostics]
    : [];
}

function hasParseDiagnostics(
  sourceFile: ts.SourceFile,
): sourceFile is ts.SourceFile & {
  readonly parseDiagnostics: readonly ts.Diagnostic[];
} {
  return (
    "parseDiagnostics" in sourceFile &&
    Array.isArray(sourceFile.parseDiagnostics)
  );
}
