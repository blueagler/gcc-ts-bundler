import ts from "typescript";

import { collectContracts } from "./contracts/registry";
import { createEmptyContractRegistry, uniqueStrings } from "./shared";
import type { ContractRegistry } from "./shared";

export interface ExternAnalysisContext {
  appEntryFiles: string[];
  checker: ts.TypeChecker;
  compilerOptions: ts.CompilerOptions;
  program: ts.Program;
  projectRoot: string;
  registry: ContractRegistry;
  scannedFiles: string[];
}

export function createExternAnalysisContext({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  scannedFiles,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  projectRoot: string;
  scannedFiles: string[];
}): ExternAnalysisContext {
  const rootNames = uniqueStrings([...scannedFiles, ...appEntryFiles]);
  const program = ts.createProgram(rootNames, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const registry =
    scannedFiles.length === 0
      ? createEmptyContractRegistry()
      : collectContracts({
          checker,
          program,
          scannedFiles,
        });

  return {
    appEntryFiles,
    checker,
    compilerOptions,
    program,
    projectRoot,
    registry,
    scannedFiles,
  };
}
