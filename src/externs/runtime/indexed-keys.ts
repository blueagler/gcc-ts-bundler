import ts from "@typescript/typescript6";

import { addMember, type RuntimeRenameHazards } from "./types";

/**
 * Resolve small local helpers that read object keys from indexed characters of
 * literal arguments, for example `matchFormat("hsv")` implemented as
 * `str[0] in input && str[1] in input && str[2] in input`.
 *
 * Closure can rename `{ h, s, v }` while those runtime string characters stay
 * fixed. Requiring a direct local function declaration, numeric character
 * indices, and direct string-literal calls keeps this a proof rather than a
 * name-based protocol guess.
 */
export function collectLiteralIndexedKeyReaders(
  sourceFile: ts.SourceFile,
  hazards: RuntimeRenameHazards,
) {
  type Reader = {
    characterIndicesByParameter: Map<number, Set<number>>;
    declarationCount: number;
  };
  const readers = new Map<string, Reader>();

  const collectDeclarations = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const characterIndicesByParameter = new Map<number, Set<number>>();
      const parameterIndexByName = new Map<string, number>();
      for (const [index, parameter] of node.parameters.entries()) {
        if (ts.isIdentifier(parameter.name)) {
          parameterIndexByName.set(parameter.name.text, index);
        }
      }
      const inspect = (child: ts.Node) => {
        if (
          ts.isBinaryExpression(child) &&
          child.operatorToken.kind === ts.SyntaxKind.InKeyword &&
          ts.isElementAccessExpression(child.left) &&
          ts.isIdentifier(child.left.expression) &&
          child.left.argumentExpression &&
          ts.isNumericLiteral(child.left.argumentExpression)
        ) {
          const parameterIndex = parameterIndexByName.get(
            child.left.expression.text,
          );
          const characterIndex = Number(child.left.argumentExpression.text);
          if (
            parameterIndex !== undefined &&
            Number.isSafeInteger(characterIndex) &&
            characterIndex >= 0
          ) {
            const indices =
              characterIndicesByParameter.get(parameterIndex) ??
              new Set<number>();
            indices.add(characterIndex);
            characterIndicesByParameter.set(parameterIndex, indices);
          }
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node.body);
      if (characterIndicesByParameter.size > 0) {
        const previous = readers.get(node.name.text);
        readers.set(node.name.text, {
          characterIndicesByParameter,
          declarationCount: (previous?.declarationCount ?? 0) + 1,
        });
      }
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(sourceFile);

  const collectCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const reader = readers.get(node.expression.text);
      if (reader?.declarationCount === 1) {
        for (const [
          parameterIndex,
          characterIndices,
        ] of reader.characterIndicesByParameter) {
          const argument = node.arguments[parameterIndex];
          if (!argument || !ts.isStringLiteralLike(argument)) continue;
          for (const characterIndex of characterIndices) {
            addMember(hazards.stringLiteralRead, argument.text[characterIndex]);
          }
        }
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);
}
