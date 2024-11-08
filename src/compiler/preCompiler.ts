import { NodePath, PluginObj, transformSync, types } from "@babel/core";
// @ts-expect-error Missing types
import typescriptSyntaxPlugin from "@babel/plugin-syntax-typescript";

export async function customTransform(
  code: string,
  isEntryPoint: boolean,
): Promise<string> {
  const plugins = [typescriptSyntaxPlugin];
  if (isEntryPoint) {
    plugins.push(addGCCExportsFromESM);
  }
  const transformed = transformSync(code, {
    babelrc: false,
    plugins,
  });
  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }
  return transformed.code;
}

const addGCCExportsFromESM = (): PluginObj => {
  return {
    visitor: {
      Program(path: NodePath<types.Program>) {
        const identifiers = new Set<string>();
        path.traverse({
          ExportNamedDeclaration(exportPath) {
            if (exportPath.node.specifiers.length > 0) {
              exportPath.node.specifiers.forEach((specifier) => {
                if (
                  types.isExportSpecifier(specifier) &&
                  types.isIdentifier(specifier.exported)
                ) {
                  identifiers.add(specifier.exported.name);
                }
              });
            } else if (exportPath.node.declaration) {
              const declaration = exportPath.node.declaration;
              if (types.isVariableDeclaration(declaration)) {
                declaration.declarations.forEach((decl) => {
                  if (types.isIdentifier(decl.id)) {
                    identifiers.add(decl.id.name);
                  }
                });
              } else if (
                types.isFunctionDeclaration(declaration) ||
                types.isClassDeclaration(declaration)
              ) {
                if (types.isIdentifier(declaration.id)) {
                  identifiers.add(declaration.id.name);
                }
              }
            }
          },
        });
        const gccIdentifier = types.identifier("GCC");
        gccIdentifier.typeAnnotation = types.tsTypeAnnotation(
          types.tsTypeLiteral(
            Array.from(identifiers).map((name) =>
              types.tsPropertySignature(
                types.identifier(name),
                types.tsTypeAnnotation(
                  types.tsTypeQuery(types.identifier(name)),
                ),
              ),
            ),
          ),
        );
        const gccVariableDeclaration = types.variableDeclaration("var", [
          types.variableDeclarator(gccIdentifier),
        ]);
        const gccDeclaration = types.tsModuleDeclaration(
          types.identifier("globalThis"),
          types.tsModuleBlock([gccVariableDeclaration]),
        );
        gccDeclaration.declare = true;
        path.unshiftContainer("body", gccDeclaration);
        const gccAssignments = Array.from(identifiers).map((name) =>
          types.expressionStatement(
            types.assignmentExpression(
              "=",
              types.memberExpression(
                types.memberExpression(
                  types.identifier("globalThis"),
                  types.identifier("GCC"),
                ),
                types.identifier(name),
              ),
              types.identifier(name),
            ),
          ),
        );
        path.pushContainer("body", gccAssignments);
      },
    },
  };
};
