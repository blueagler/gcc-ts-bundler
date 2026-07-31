import path from "path";
import ts from "typescript";

import { logInternalDetail } from "../../../shared/timing";
import {
  loadCompilerOptions,
  loadTsConfigDeclarationFiles,
} from "../compiler-options";
import { collectTypeMetadataFiles, scanTypeMetadataFiles } from "./metadata";
import type { ClosureIrScanResult } from "./metadata/scan";
import type { TypeMetadataTarget } from "./types";
export type {
  ClosureAnnotation,
  ClosureEnumDeclaration,
  ClosureTypeDeclaration,
  ClosureTypeMetadataFile,
  ClosureTypeReference,
  ClosureTypeSymbol,
  NativeTypeAnalysisResult,
  TypeMetadataCounts,
  TypeMetadataDiagnostic,
  TypeMetadataTarget,
} from "./types";
export { countTypeMetadata } from "./types";

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
  // Program parity with `tsc`: the checker must see the same files `tsc`
  // would. Graph roots cover everything reachable by import; ambient
  // declarations are reachable by nobody and come from the config instead.
  // `typeRoots`/`types` packages and triple-slash references are resolved by
  // `ts.createProgram` itself once the roots are right.
  const declarationRoots = await loadTsConfigDeclarationFiles(tsConfigPath);
  const rootNames = [...fileNames];
  const seen = new Set(fileNames.map((fileName) => path.resolve(fileName)));
  for (const declarationFile of declarationRoots) {
    if (seen.has(declarationFile)) {
      continue;
    }
    seen.add(declarationFile);
    rootNames.push(declarationFile);
  }
  if (rootNames.length !== fileNames.length) {
    logInternalDetail(
      "native-emit:program-parity",
      `${rootNames.length - fileNames.length} ambient declaration file(s)`,
    );
  }

  return {
    compilerOptions,
    // `fileNames` stays the analysis set: parity widens what the checker can
    // see, never what we emit metadata for.
    fileNames,
    program: ts.createProgram(rootNames, compilerOptions),
  };
}

export function scanNativeTypeAnalysisContext({
  context,
}: {
  context: NativeTypeAnalysisContext;
}): NativeTypeAnalysisScanResult {
  const { fileNames, program } = context;
  return scanTypeMetadataFiles({ fileNames, program });
}

export function collectNativeTypeMetadataFromContext({
  context,
  scan,
  targets,
}: {
  context: NativeTypeAnalysisContext;
  scan: NativeTypeAnalysisScanResult | undefined;
  targets?: TypeMetadataTarget[] | undefined;
}) {
  const { compilerOptions, fileNames, program } = context;
  const closureIrScan = scan ?? scanNativeTypeAnalysisContext({ context });
  logInternalDetail(
    "native-emit:analysis-scan:files",
    `${closureIrScan.analyzedFileCount}/${closureIrScan.scannedFileCount}`,
  );
  const result = collectTypeMetadataFiles({
    compilerOptions,
    fileNames,
    program,
    scan: closureIrScan,
    targets,
  });
  logInternalDetail(
    "native-emit:type-metadata:counts",
    JSON.stringify(result.extractedCounts),
  );
  return result;
}
