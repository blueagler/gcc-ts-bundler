import ts from "@typescript/typescript6";

import { containsDecorators } from "../decorators";
import { containsExplicitTypeSignal } from "../diagnostics";
import { classifyClosureIrDocEligibility } from "./doc-eligibility";

export interface ClosureIrFileFeatures {
  docEligibility: ReturnType<typeof classifyClosureIrDocEligibility>;
  filePath: string;
  hasDecorators: boolean;
  hasEnumDeclarations: boolean;
  hasTypeDrivenClosureDocs: boolean;
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

    const features = classifyClosureIrFile(sourceFile);
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

  const docEligibility = classifyClosureIrDocEligibility(sourceFile);
  const hasExplicitTypeSignals = sourceFile.statements.some(
    containsExplicitTypeSignal,
  );
  const hasTypeDrivenClosureDocs =
    docEligibility.isTypeScriptLike && hasExplicitTypeSignals;
  const hasDecorators =
    sourceFile.text.includes("@") && containsDecorators(sourceFile);
  const needsSemanticPreflight =
    docEligibility.hasJsDocText ||
    docEligibility.hasTsCheckText ||
    hasDecorators ||
    hasEnumDeclarations ||
    hasTypeDeclarations ||
    hasExplicitTypeSignals;
  const hasTopLevelDocs =
    docEligibility.hasTopLevelDocs || hasTypeDrivenClosureDocs;

  return {
    docEligibility,
    filePath: sourceFile.fileName,
    hasDecorators,
    hasEnumDeclarations,
    hasTypeDrivenClosureDocs,
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

function classifyClosureIrFile(
  sourceFile: ts.SourceFile,
): ClosureIrFileFeatures {
  return classifyClosureIrSourceFile(sourceFile);
}
