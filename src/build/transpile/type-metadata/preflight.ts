import ts from "@typescript/typescript6";

import type { DiagnosticsPreflight } from "../../../api/types";
import { logInternalDetail } from "../../../shared/timing";
import { shouldIgnorePreflightDiagnostic } from "./diagnostics";
import type { ClosureIrScanResult } from "./metadata/scan";

export function collectNativePreflightDiagnostics({
  authoredFiles,
  additionalSyntacticDiagnostics,
  preflight,
  program,
  scan,
}: {
  authoredFiles?: Set<string> | null;
  additionalSyntacticDiagnostics?: ts.Diagnostic[];
  preflight: DiagnosticsPreflight;
  program: ts.Program;
  scan: ClosureIrScanResult;
}): ts.Diagnostic[] {
  if (preflight === "off") {
    return [];
  }

  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...(additionalSyntacticDiagnostics ?? collectSyntacticDiagnostics(program)),
    ...collectSemanticDiagnostics({
      authoredFiles: authoredFiles ?? null,
      program,
      scan,
    }),
  ].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic));

  if (preflight === "errors-only") {
    return diagnostics.filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
  }

  return diagnostics;
}

function collectSyntacticDiagnostics(program: ts.Program) {
  const diagnostics: ts.Diagnostic[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile));
  }

  return diagnostics;
}

function collectSemanticDiagnostics({
  authoredFiles,
  program,
  scan,
}: {
  authoredFiles: Set<string> | null;
  program: ts.Program;
  scan: ClosureIrScanResult;
}) {
  const diagnostics: ts.Diagnostic[] = [];
  const semanticFiles = scan.files.filter(({ features, sourceFile }) => {
    if (!features.needsSemanticPreflight) {
      return false;
    }
    if (!authoredFiles) {
      return true;
    }
    return authoredFiles.has(sourceFile.fileName);
  });

  logInternalDetail(
    "native-emit:preflight:files",
    `${semanticFiles.length}/${scan.scannedFileCount}`,
  );

  for (const { sourceFile } of semanticFiles) {
    diagnostics.push(...program.getSemanticDiagnostics(sourceFile));
  }

  return diagnostics;
}
