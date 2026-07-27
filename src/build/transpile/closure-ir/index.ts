import ts from "typescript";

import { logInternalDetail } from "../../../shared/timing";
import { loadCompilerOptions } from "../compiler-options";
import { collectClosureIrFiles, scanClosureIrFiles } from "./metadata";
import type { ClosureIrScanResult } from "./metadata/scan";
export type {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTopLevelDoc,
  ClosureIrTypeDeclaration,
} from "./types";

interface NativeTypeAnalysisContext {
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
}

type NativeTypeAnalysisScanResult = ClosureIrScanResult;

export async function createNativeTypeAnalysisContext({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeTypeAnalysisContext> {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  return {
    compilerOptions,
    fileNames,
    program: ts.createProgram(fileNames, compilerOptions),
  };
}

export function scanNativeTypeAnalysisContext({
  context,
}: {
  context: NativeTypeAnalysisContext;
}): NativeTypeAnalysisScanResult {
  const { fileNames, program } = context;
  return scanClosureIrFiles({ fileNames, program });
}

export function collectNativeClosureIrFromContext({
  context,
  scan,
}: {
  context: NativeTypeAnalysisContext;
  scan: NativeTypeAnalysisScanResult | undefined;
}) {
  const { compilerOptions, fileNames, program } = context;
  const closureIrScan = scan ?? scanNativeTypeAnalysisContext({ context });
  logInternalDetail(
    "native-emit:analysis-scan:files",
    `${closureIrScan.analyzedFileCount}/${closureIrScan.scannedFileCount}`,
  );
  return collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
    scan: closureIrScan,
  });
}
