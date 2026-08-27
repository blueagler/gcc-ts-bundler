import ts from "@typescript/typescript6";

import { collectContracts } from "./contracts/registry";
import { createEmptyContractRegistry, type ContractRegistry } from "./shared";
import { uniqueSortedStrings } from "../shared/files";

export interface ExternAnalysisContext {
  appEntryFiles: string[];
  checker: ts.TypeChecker;
  compilerOptions: ts.CompilerOptions;
  program: ts.Program;
  projectRoot: string;
  registry: ContractRegistry;
  scannedFiles: string[];
}

export interface TypeWorld {
  checker: ts.TypeChecker;
  compilerOptions: ts.CompilerOptions;
  program: ts.Program;
}

export function createTypeWorld(
  fileNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
): TypeWorld {
  const program = ts.createProgram(uniqueSortedStrings([...fileNames]), {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true,
  });
  return {
    checker: program.getTypeChecker(),
    compilerOptions,
    program,
  };
}

export function createExternAnalysisContext({
  appEntryFiles,
  compilerOptions,
  declarationRoots,
  projectRoot,
  scannedFiles,
  typeWorld,
}: {
  appEntryFiles: string[];
  compilerOptions: ts.CompilerOptions;
  declarationRoots?: readonly string[] | undefined;
  projectRoot: string;
  scannedFiles: string[];
  typeWorld?: TypeWorld | undefined;
}): ExternAnalysisContext {
  const program =
    typeWorld?.program ??
    ts.createProgram(
      uniqueSortedStrings([
        ...scannedFiles,
        ...appEntryFiles,
        ...(declarationRoots ?? []),
      ]),
      {
        ...compilerOptions,
        noEmit: true,
        skipLibCheck: true,
      },
    );
  const checker = typeWorld?.checker ?? program.getTypeChecker();
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
    compilerOptions: typeWorld?.compilerOptions ?? compilerOptions,
    program,
    projectRoot,
    registry,
    scannedFiles,
  };
}
