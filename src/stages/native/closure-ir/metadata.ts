import ts from "typescript";

import { collectClosureIrFileMetadata } from "./metadata/collect";
import { collectUnsafeEnumSymbols } from "./metadata/enums";
import {
  scanClosureIrSourceFiles,
  type ClosureIrScanResult,
} from "./metadata/scan";
import { ClosureIrFileMetadata } from "./types";

export interface ClosureIrCollectionResult {
  diagnostics: ts.Diagnostic[];
  files: ClosureIrFileMetadata[];
  scan: ClosureIrScanResult;
}

export function scanClosureIrFiles({
  fileNames,
  program,
}: {
  fileNames: string[];
  program: ts.Program;
}) {
  return scanClosureIrSourceFiles({ fileNames, program });
}

export function collectClosureIrFiles({
  compilerOptions,
  fileNames,
  program,
  scan = scanClosureIrFiles({ fileNames, program }),
}: {
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
  scan?: ClosureIrScanResult;
}): ClosureIrCollectionResult {
  const files = scan.files.map(({ features, sourceFile }) => ({
    features,
    sourceFile,
  }));
  const needsChecker = files.some(
    ({ features }) =>
      features.hasEnumDeclarations ||
      features.hasTopLevelDocs ||
      features.hasTypeDeclarations,
  );
  const hasDecorators = files.some(({ features }) => features.hasDecorators);
  if (!needsChecker && !hasDecorators) {
    return {
      diagnostics: [],
      files: files.map(({ sourceFile }) => ({
        decoratedOutputText: undefined,
        enumDeclarations: [],
        filePath: sourceFile.fileName,
        topLevelDocs: [],
        typeDeclarations: [],
      })),
      scan,
    };
  }

  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = scan.hasEnumDeclarations
    ? collectUnsafeEnumSymbols(
        scan.files
          .filter(({ features }) => features.hasEnumDeclarations)
          .map(({ sourceFile }) => sourceFile),
        checker,
      )
    : new Set<ts.Symbol>();
  const diagnostics: ts.Diagnostic[] = [];
  const collectedFiles: ClosureIrFileMetadata[] = [];

  for (const { features, sourceFile } of files) {
    if (!features.shouldAnalyze) {
      collectedFiles.push({
        decoratedOutputText: undefined,
        enumDeclarations: [],
        filePath: sourceFile.fileName,
        topLevelDocs: [],
        typeDeclarations: [],
      });
      continue;
    }

    const result = collectClosureIrFileMetadata({
      compilerOptions,
      checker,
      features,
      sourceFile,
      unsafeEnumSymbols,
    });
    diagnostics.push(...result.diagnostics);
    collectedFiles.push(result.file);
  }

  return { diagnostics, files: collectedFiles, scan };
}
