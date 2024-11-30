import { NodePath, PluginObj, types as t, transformAsync } from "@babel/core";
import { minify } from "uglify-js";

export async function customTransform(code: string): Promise<string> {
  if (code.length === 0) {
    return code;
  }
  const plugins = [
    convertGCCExportsToESM({
      defaultExportIdentifier: "__DEFAULT_EXPORT__",
      gccIdentifier: "GCC",
    }),
  ];
  const transformed = await transformAsync(code, {
    babelrc: false,
    plugins,
  });
  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }
  const minified = minify(transformed.code, {
    compress: {
      hoist_vars: true,
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

interface GCCPluginOptions {
  defaultExportIdentifier: string;
  gccIdentifier: string;
}

function getPropertyName(property: t.Node): string | undefined {
  if (t.isIdentifier(property)) {
    return property.name;
  } else if (t.isStringLiteral(property)) {
    return property.value;
  }
  return undefined;
}

const convertGCCExportsToESM = (options: GCCPluginOptions): PluginObj => {
  const gccId = options.gccIdentifier;
  const defaultExportId = options.defaultExportIdentifier;
  return {
    name: "convert-gcc-exports-to-esm",
    visitor: {
      Program(path: NodePath<t.Program>) {
        const exportsMap = new Map<string, string>();
        const processedExports = new Set<string>();
        const existingExportNames = new Set<string>();
        path.node.body.forEach((node) => {
          if (t.isExportNamedDeclaration(node)) {
            node.specifiers.forEach((specifier) => {
              if (t.isExportSpecifier(specifier)) {
                const exportedName = t.isIdentifier(specifier.exported)
                  ? specifier.exported.name
                  : specifier.exported.value;
                existingExportNames.add(exportedName);
              }
            });
          }
        });
        path.traverse({
          AssignmentExpression(assignPath: NodePath<t.AssignmentExpression>) {
            const left = assignPath.node.left;
            if (
              t.isMemberExpression(left) &&
              t.isMemberExpression(left.object) &&
              t.isIdentifier(left.object.object, { name: "globalThis" }) &&
              t.isIdentifier(left.object.property, { name: gccId }) &&
              (t.isIdentifier(left.property) ||
                t.isStringLiteral(left.property))
            ) {
              const exportName = getPropertyName(left.property);
              if (!exportName) return;
              if (processedExports.has(exportName)) {
                assignPath.parentPath.remove();
                return;
              }
              processedExports.add(exportName);
              const variableName =
                exportName === defaultExportId
                  ? "defaultExport"
                  : path.scope.generateUidIdentifier(exportName).name;
              exportsMap.set(exportName, variableName);
              const variableDeclaration = t.variableDeclaration("const", [
                t.variableDeclarator(
                  t.identifier(variableName),
                  assignPath.node.right,
                ),
              ]);
              assignPath.parentPath.replaceWith(variableDeclaration);
            }
          },
        });
        if (exportsMap.size === 0) {
          return;
        }
        const namedExportSpecifiers: t.ExportSpecifier[] = [];
        let defaultExportName: string | undefined;
        exportsMap.forEach((variableName, exportName) => {
          if (exportName === defaultExportId) {
            defaultExportName = variableName;
          } else if (!existingExportNames.has(exportName)) {
            namedExportSpecifiers.push(
              t.exportSpecifier(
                t.identifier(variableName),
                t.identifier(exportName),
              ),
            );
          }
        });
        if (defaultExportName) {
          const hasDefaultExport = path.node.body.some((node) =>
            t.isExportDefaultDeclaration(node),
          );
          if (!hasDefaultExport) {
            const exportDefault = t.exportDefaultDeclaration(
              t.identifier(defaultExportName),
            );
            path.pushContainer("body", exportDefault);
          }
        }
        if (namedExportSpecifiers.length > 0) {
          const exportNamedDeclaration = t.exportNamedDeclaration(
            null,
            namedExportSpecifiers,
          );
          path.pushContainer("body", exportNamedDeclaration);
        }
        path.node.body = path.node.body.filter((node) => {
          if (
            t.isExpressionStatement(node) &&
            t.isAssignmentExpression(node.expression) &&
            t.isMemberExpression(node.expression.left) &&
            t.isMemberExpression(node.expression.left.object) &&
            t.isIdentifier(node.expression.left.object.object, {
              name: "globalThis",
            }) &&
            t.isIdentifier(node.expression.left.object.property, {
              name: gccId,
            })
          ) {
            return false;
          }
          return true;
        });
      },
    },
  };
};
