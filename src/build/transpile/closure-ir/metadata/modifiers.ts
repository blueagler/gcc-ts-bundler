import ts from "@typescript/typescript6";

export function getPropertyNameText(
  name: ts.PropertyName | ts.BindingName | undefined,
) {
  if (!name) {
    return null;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return null;
}
