import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { loadCompilerOptions } from "./compiler-options";
import { shouldIgnorePreflightDiagnostic } from "./closure-ir/diagnostics";
import { collectClosureIrFiles } from "./closure-ir/metadata";
export type {
  ClosureIrEnumDeclaration,
  ClosureIrFileMetadata,
  ClosureIrTopLevelDoc,
  ClosureIrTypeDeclaration,
} from "./closure-ir/types";

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
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const program = ts.createProgram(fileNames, compilerOptions);
  const preflightDiagnostics =
    preflight === "full"
      ? [...ts.getPreEmitDiagnostics(program)].filter(
          (diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic),
        )
      : [];
  const { diagnostics: closureIrDiagnostics, files } = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program,
  });

  return {
    diagnostics: [...preflightDiagnostics, ...closureIrDiagnostics],
    files,
  };
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
