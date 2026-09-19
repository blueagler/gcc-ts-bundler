import fs from "fs";
import ts from "@typescript/typescript6";

import { uniqueSortedStrings } from "../../../../shared/files";
import {
  countInternalWork,
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
import { collectNativePreflightDiagnostics } from "../../type-metadata/preflight";

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
  countInternalWork("analysisFiles", fileNames.length);
  countInternalWork("boundaryModules", boundaryModuleFileNames.length);
  countInternalWork("analysisExternalSpecifiers", externalSpecifiers.length);
  const authoredFiles = options.authoredFiles
    ? new Set(options.authoredFiles)
    : null;
  if (!canUseJsAnalysisFastPath(fileNames, options.authoredFiles)) {
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
            authoredFiles,
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
    countAnalysisWork(analysis.extractedCounts, analysis.files.length);
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

  const quickScanFiles = await withInternalTiming(
    "native-emit:quick-scan",
    () => scanNativeFilesQuickly(fileNames, typeWorld?.program),
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
  countInternalWork("checkerRequiredFiles", checkerRequiredFileNames.length);
  countInternalWork("trivialJsFiles", trivialJsFiles.length);

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
  countAnalysisWork(
    checkerAnalysis.extractedCounts,
    checkerAnalysis.files.length,
  );
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

function countAnalysisWork(counts: TypeMetadataCounts, files: number): void {
  countInternalWork("metadataFiles", files);
  countInternalWork("annotations", counts.annotationCount);
  countInternalWork("memberAnnotations", counts.memberAnnotationCount);
  countInternalWork("typeDeclarations", counts.typeDeclarationCount);
  countInternalWork("enumDeclarations", counts.enumDeclarationCount);
  countInternalWork(
    "unresolvedTypeReferences",
    counts.unresolvedTypeReferenceCount,
  );
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

async function scanNativeFilesQuickly(
  fileNames: string[],
  program: ts.Program | undefined,
) {
  const files = await Promise.all(
    fileNames.map(async (fileName) => {
      const sourceFile =
        program?.getSourceFile(fileName) ??
        ts.createSourceFile(
          fileName,
          await fs.promises.readFile(fileName, "utf8"),
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
  authoredFiles: readonly string[] | undefined,
) {
  if (!authoredFiles) {
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
