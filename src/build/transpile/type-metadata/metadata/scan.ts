import ts from "@typescript/typescript6";

import { containsDecorators } from "../decorators";
import { containsExplicitTypeSignal } from "../diagnostics";
import {
  classifyClosureIrDocEligibility,
  type ClosureIrDocEligibility,
} from "./doc-eligibility";

export interface ClosureIrFileFeatures {
  docEligibility: ClosureIrDocEligibility;
  hasDecorators: boolean;
  hasEnumDeclarations: boolean;
  needsSemanticPreflight: boolean;
  hasTopLevelDocs: boolean;
  hasTypeDeclarations: boolean;
  shouldAnalyze: boolean;
}

export interface ClosureIrScanResult {
  analyzedFileCount: number;
  files: Array<{
    features: ClosureIrFileFeatures;
    sourceFile: ts.SourceFile;
  }>;
  hasEnumDeclarations: boolean;
  scannedFileCount: number;
}

export function scanClosureIrSourceFiles({
  fileNames,
  program,
}: {
  fileNames: string[];
  program: ts.Program;
}): ClosureIrScanResult {
  const inputFiles = new Set(fileNames);
  const files: ClosureIrScanResult["files"] = [];
  let analyzedFileCount = 0;
  let hasEnumDeclarations = false;

  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }

    const features = classifyClosureIrSourceFile(sourceFile);
    if (features.shouldAnalyze) {
      analyzedFileCount += 1;
    }
    if (features.hasEnumDeclarations) {
      hasEnumDeclarations = true;
    }

    files.push({ features, sourceFile });
  }

  return {
    analyzedFileCount,
    files,
    hasEnumDeclarations,
    scannedFileCount: files.length,
  };
}

export function classifyClosureIrSourceFile(
  sourceFile: ts.SourceFile,
): ClosureIrFileFeatures {
  let hasEnumDeclarations = false;
  let hasTypeDeclarations = false;

  for (const statement of sourceFile.statements) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      hasTypeDeclarations = true;
      continue;
    }
    if (ts.isEnumDeclaration(statement)) {
      hasEnumDeclarations = true;
      continue;
    }
  }

  const classified = classifyClosureIrDocEligibility(sourceFile);
  const hasExplicitTypeSignals = sourceFile.statements.some(
    containsExplicitTypeSignal,
  );
  const hasTypeDrivenClosureDocs =
    classified.isTypeScriptLike && hasExplicitTypeSignals;
  const hasDecorators =
    sourceFile.text.includes("@") && containsDecorators(sourceFile);
  const needsSemanticPreflight =
    classified.hasJsDocText ||
    classified.hasTsCheckText ||
    hasDecorators ||
    hasEnumDeclarations ||
    hasTypeDeclarations ||
    hasExplicitTypeSignals;
  const hasTopLevelDocs =
    classified.hasTopLevelDocs || hasTypeDrivenClosureDocs;

  return {
    docEligibility: {
      hasJsDocText: classified.hasJsDocText,
      isTypeScriptLike: classified.isTypeScriptLike,
    },
    hasDecorators,
    hasEnumDeclarations,
    needsSemanticPreflight,
    hasTopLevelDocs,
    hasTypeDeclarations,
    shouldAnalyze:
      hasDecorators ||
      hasEnumDeclarations ||
      hasTopLevelDocs ||
      hasTypeDeclarations,
  };
}
