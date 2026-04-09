import ts from "typescript";

export function shouldIgnorePreflightDiagnostic(diagnostic: ts.Diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }

  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return (
    message.includes("node_modules") &&
    message.includes("implicitly has an 'any' type")
  );
}
