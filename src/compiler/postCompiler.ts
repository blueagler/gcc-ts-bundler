import { NodePath, PluginObj, transformSync, types } from "@babel/core";
import { minify } from "uglify-js";

export async function customTransform(code: string): Promise<string> {
  const plugins = [convertGCCExportsToESM];

  const transformed = transformSync(code, {
    babelrc: false,
    plugins,
  });
  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }
  const minified = minify(transformed.code, {
    compress: {
      passes: 3,
      pure_getters: true,
      toplevel: true,
      unsafe: true,
    },
    module: true,
  });
  if (minified.error) {
    throw new Error(`UglifyJS minify failed: ${minified.error.message}`);
  }
  return minified.code;
}

const convertGCCExportsToESM = (): PluginObj => {
  return {
    visitor: {
      Program(path: NodePath<types.Program>) {
        const exports = new Map<string, string>();
        path.traverse({
          AssignmentExpression(assignPath) {
            const left = assignPath.node.left;
            if (
              types.isMemberExpression(left) &&
              types.isMemberExpression(left.object) &&
              types.isIdentifier(left.object.object) &&
              left.object.object.name === "globalThis" &&
              types.isIdentifier(left.object.property) &&
              left.object.property.name === "GCC" &&
              types.isIdentifier(left.property)
            ) {
              const exportName = left.property.name;
              if (!exports.has(exportName)) {
                const uid = path.scope.generateUidIdentifier("GCC").name;
                exports.set(exportName, uid);
              }
            }
          },
        });
        path.traverse({
          ExpressionStatement(stmtPath) {
            const expr = stmtPath.node.expression;
            if (
              types.isAssignmentExpression(expr) &&
              types.isMemberExpression(expr.left) &&
              types.isMemberExpression(expr.left.object) &&
              types.isIdentifier(expr.left.object.object) &&
              expr.left.object.object.name === "globalThis" &&
              types.isIdentifier(expr.left.object.property) &&
              expr.left.object.property.name === "GCC" &&
              types.isIdentifier(expr.left.property)
            ) {
              const exportName = expr.left.property.name;
              const shortName = exports.get(exportName)!;
              stmtPath.replaceWith(
                types.variableDeclaration("const", [
                  types.variableDeclarator(
                    types.identifier(shortName),
                    expr.right,
                  ),
                ]),
              );
            }
          },
        });
        if (exports.size > 0) {
          const exportSpecifiers = Array.from(exports.entries()).map(
            ([exportName, shortName]) =>
              types.exportSpecifier(
                types.identifier(shortName),
                types.identifier(exportName),
              ),
          );
          const exportDeclaration = types.exportNamedDeclaration(
            null,
            exportSpecifiers,
          );
          path.pushContainer("body", exportDeclaration);
        }
      },
    },
  };
};
