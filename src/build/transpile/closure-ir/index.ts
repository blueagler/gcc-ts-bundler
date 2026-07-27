import ts from "typescript";

import type { DiagnosticsPreflight } from "../../../api/types";
import { logInternalDetail } from "../../../shared/timing";
import { loadCompilerOptions } from "../compiler-options";
import { collectClosureIrFiles, scanClosureIrFiles } from "./metadata";
import type { ClosureIrScanResult } from "./metadata/scan";
import { collectNativePreflightDiagnostics } from "./preflight";
export type {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTopLevelDoc,
  ClosureIrTypeDeclaration,
} from "./types";

export interface NativeTypeAnalysisContext {
  compilerOptions: ts.CompilerOptions;
  fileNames: string[];
  program: ts.Program;
}

export type NativeTypeAnalysisScanResult = ClosureIrScanResult;

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

export function collectNativeTypeAnalysisFromContext({
  context,
  preflight,
  scan,
}: {
  context: NativeTypeAnalysisContext;
  preflight: DiagnosticsPreflight;
  scan: NativeTypeAnalysisScanResult | undefined;
}) {
  const preflightDiagnostics = collectNativePreflightDiagnosticsFromContext({
    context,
    preflight,
    scan,
  });
  const { diagnostics: closureIrDiagnostics, files } =
    collectNativeClosureIrFromContext({ context, scan });
  return {
    diagnostics: [...preflightDiagnostics, ...closureIrDiagnostics],
    files,
  };
}

export function collectNativePreflightDiagnosticsFromContext({
  context,
  preflight,
  scan,
}: {
  context: NativeTypeAnalysisContext;
  preflight: DiagnosticsPreflight;
  scan: NativeTypeAnalysisScanResult | undefined;
}) {
  const closureIrScan = scan ?? scanNativeTypeAnalysisContext({ context });
  return collectNativePreflightDiagnostics({
    preflight,
    program: context.program,
    scan: closureIrScan,
  });
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

export async function collectNativeTypeAnalysis({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
  workspaceDir: string;
}) {
  const context = await createNativeTypeAnalysisContext({
    fileNames,
    tsConfigPath,
    workspaceDir,
  });
  return collectNativeTypeAnalysisFromContext({
    context,
    preflight,
    scan: undefined,
  });
}

export async function collectClosureIrMetadata({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}) {
  return collectNativeTypeAnalysis({
    fileNames,
    preflight: "off",
    tsConfigPath,
    workspaceDir,
  });
}
