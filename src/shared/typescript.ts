import ts from "@typescript/typescript6";

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return Boolean(
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}
