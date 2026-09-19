import ts from "@typescript/typescript6";

import { getClosureIrSyntaxIndex } from "./metadata/scan";

export function shouldIgnorePreflightDiagnostic(diagnostic: ts.Diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (
    message.includes("implicitly has an 'any' type") &&
    diagnostic.file &&
    !fileHasExplicitTypeSignals(diagnostic.file)
  ) {
    return true;
  }

  switch (diagnostic.code) {
    case 7016:
      return (
        message.includes("node_modules") &&
        message.includes("implicitly has an 'any' type")
      );
    case 7017:
      return message.includes("type 'typeof globalThis'");
    case 2307:
      return (
        message.includes("corresponding type declarations") &&
        isBareModuleResolutionDiagnostic(diagnostic)
      );
    case 5097:
      return isLocalTsExtensionImportDiagnostic(diagnostic);
    default:
      return false;
  }
}

function isBareModuleResolutionDiagnostic(diagnostic: ts.Diagnostic) {
  const specifier = getDiagnosticModuleSpecifier(diagnostic);
  if (!specifier) {
    return false;
  }

  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("#")
  );
}

function isLocalTsExtensionImportDiagnostic(diagnostic: ts.Diagnostic) {
  const specifier = getDiagnosticModuleSpecifier(diagnostic);
  return !!specifier && specifier.startsWith(".") && specifier.endsWith(".ts");
}

function getDiagnosticModuleSpecifier(diagnostic: ts.Diagnostic) {
  if (
    !diagnostic.file ||
    diagnostic.start == null ||
    diagnostic.length == null ||
    diagnostic.length <= 0
  ) {
    return null;
  }

  const moduleText = diagnostic.file.text.slice(
    diagnostic.start,
    diagnostic.start + diagnostic.length,
  );
  if (
    moduleText.length < 2 ||
    !(
      (moduleText.startsWith('"') && moduleText.endsWith('"')) ||
      (moduleText.startsWith("'") && moduleText.endsWith("'"))
    )
  ) {
    return null;
  }

  return moduleText.slice(1, -1);
}

function fileHasExplicitTypeSignals(sourceFile: ts.SourceFile) {
  const index = getClosureIrSyntaxIndex(sourceFile);
  return (
    index.docEligibility.hasJsDocText ||
    index.docEligibility.hasTsCheckText ||
    index.hasExplicitTypeSignals
  );
}
