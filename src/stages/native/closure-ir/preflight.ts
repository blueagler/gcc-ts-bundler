import ts from "typescript";

import { DiagnosticsPreflight } from "../../../api/types";
import { logInternalDetail } from "../../../internal/timing";
import { shouldIgnorePreflightDiagnostic } from "./diagnostics";
import type { ClosureIrScanResult } from "./metadata/scan";

export function collectNativePreflightDiagnostics({
  preflight,
  program,
  scan,
}: {
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
    ...collectSyntacticDiagnostics(program),
    ...collectSemanticDiagnostics({ program, scan }),
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
  program,
  scan,
}: {
  program: ts.Program;
  scan: ClosureIrScanResult;
}) {
  const diagnostics: ts.Diagnostic[] = [];
  const semanticFiles = scan.files.filter(
    ({ features }) => features.needsSemanticPreflight,
  );

  logInternalDetail(
    "native-emit:preflight:files",
    `${semanticFiles.length}/${scan.scannedFileCount}`,
  );

  for (const { sourceFile } of semanticFiles) {
    diagnostics.push(...program.getSemanticDiagnostics(sourceFile));
  }

  return diagnostics;
}
