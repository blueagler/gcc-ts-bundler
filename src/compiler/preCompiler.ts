import { NodePath, PluginObj, types as t, transformSync } from "@babel/core";
import { parse } from "@babel/parser";
// @ts-expect-error Missing types
import syntaxTypescript from "@babel/plugin-syntax-typescript";
import traverse from "@babel/traverse";
import { existsSync, readFileSync } from "fs";
import path from "path";

export async function customTransform(
  code: string,
  filePath: string,
  isEntryPoint: boolean,
): Promise<string> {
  const plugins = [syntaxTypescript];
  if (isEntryPoint) {
    plugins.push(addGCCExportsFromESM(filePath));
  }
  const transformed = transformSync(code, {
    babelrc: false,
    filename: filePath, // Added filename for accurate parsing
    plugins,
  });
  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }
  return transformed.code;
}

const GCC = "GCC";
const addGCCExportsFromESM = (filePath: string): PluginObj => {
  return {
    visitor: {
      Program(programPath) {
        const globalIdentifiers = new Set<string>();
        const existingImports = new Map<string, Set<string>>();
        const existingExports = new Set<string>();
        programPath.traverse({
          ExportNamedDeclaration(
            exportPath: NodePath<t.ExportNamedDeclaration>,
          ) {
            const { node } = exportPath;
            if (node.specifiers.length > 0) {
              node.specifiers.forEach((specifier) => {
                if (
                  t.isExportSpecifier(specifier) &&
                  t.isIdentifier(specifier.exported)
                ) {
                  existingExports.add(specifier.exported.name);
                }
              });
            } else if (node.declaration) {
              const declaration = node.declaration;
              if (t.isVariableDeclaration(declaration)) {
                declaration.declarations.forEach((decl) => {
                  if (t.isIdentifier(decl.id)) {
                    existingExports.add(decl.id.name);
                  }
                });
              } else if (
                t.isFunctionDeclaration(declaration) ||
                t.isClassDeclaration(declaration)
              ) {
                if (t.isIdentifier(declaration.id)) {
                  existingExports.add(declaration.id.name);
                }
              }
            }
          },
          ImportDeclaration(importPath: NodePath<t.ImportDeclaration>) {
            const source = importPath.node.source.value;
            const specifiers = importPath.node.specifiers;
            if (!existingImports.has(source)) {
              existingImports.set(source, new Set());
            }
            specifiers.forEach((specifier) => {
              if (
                t.isImportSpecifier(specifier) &&
                t.isIdentifier(specifier.imported)
              ) {
                existingImports.get(source)!.add(specifier.imported.name);
              }
            });
          },
        });
        const resolveModulePath = (source: string): string => {
          const extensions = [".ts", ".tsx", ".js", ".jsx"];
          for (const ext of extensions) {
            const resolvedPath = path.resolve(
              path.dirname(filePath),
              `${source}${ext}`,
            );
            if (existsSync(resolvedPath)) return resolvedPath;
          }
          throw new Error(`Module not found: ${source}`);
        };
        programPath.traverse({
          ExportAllDeclaration(
            exportAllPath: NodePath<t.ExportAllDeclaration>,
          ) {
            const source = exportAllPath.node.source.value;
            const modulePath = resolveModulePath(source);
            const collectedExports = new Set<string>();
            const exportCollector = {
              ExportAllDeclaration(
                nestedExportAllPath: NodePath<t.ExportAllDeclaration>,
              ) {
                const nestedSource = nestedExportAllPath.node.source.value;
                const nestedModulePath = resolveModulePath(nestedSource);
                const nestedCode = readFileSync(nestedModulePath, "utf-8");
                const nestedAST = parse(nestedCode, {
                  plugins: ["typescript"],
                  sourceType: "module",
                });
                traverse(nestedAST, exportCollector);
              },
              ExportNamedDeclaration(
                namedExportPath: NodePath<t.ExportNamedDeclaration>,
              ) {
                const { node } = namedExportPath;
                if (node.specifiers.length > 0) {
                  node.specifiers.forEach((specifier) => {
                    if (
                      t.isExportSpecifier(specifier) &&
                      t.isIdentifier(specifier.exported)
                    ) {
                      collectedExports.add(specifier.exported.name);
                    }
                  });
                } else if (node.declaration) {
                  const declaration = node.declaration;
                  if (t.isVariableDeclaration(declaration)) {
                    declaration.declarations.forEach((decl) => {
                      if (t.isIdentifier(decl.id)) {
                        collectedExports.add(decl.id.name);
                      }
                    });
                  } else if (
                    t.isFunctionDeclaration(declaration) ||
                    t.isClassDeclaration(declaration)
                  ) {
                    if (t.isIdentifier(declaration.id)) {
                      collectedExports.add(declaration.id.name);
                    }
                  }
                }
              },
            };
            try {
              const moduleCode = readFileSync(modulePath, "utf-8");
              const ast = parse(moduleCode, {
                plugins: ["typescript"],
                sourceType: "module",
              });
              traverse(ast, exportCollector);
            } catch (error) {
              throw new Error(
                `Failed to process module ${modulePath}: ${(error as Error).message}`,
              );
            }
            const identifiersToImport = Array.from(collectedExports).filter(
              (name) => {
                return !existingImports.get(source)?.has(name);
              },
            );
            if (identifiersToImport.length > 0) {
              exportAllPath.replaceWithMultiple([
                t.importDeclaration(
                  identifiersToImport.map((name) =>
                    t.importSpecifier(t.identifier(name), t.identifier(name)),
                  ),
                  t.stringLiteral(source),
                ),
              ]);
              if (!existingImports.has(source)) {
                existingImports.set(source, new Set());
              }
              identifiersToImport.forEach((name) =>
                existingImports.get(source)!.add(name),
              );
            } else {
              exportAllPath.remove();
            }
            collectedExports.forEach((name) => globalIdentifiers.add(name));
          },
          ExportNamedDeclaration(
            exportPath: NodePath<t.ExportNamedDeclaration>,
          ) {
            const { node } = exportPath;
            if (node.specifiers.length > 0) {
              node.specifiers.forEach((specifier) => {
                if (
                  t.isExportSpecifier(specifier) &&
                  t.isIdentifier(specifier.exported)
                ) {
                  globalIdentifiers.add(specifier.exported.name);
                }
              });
            } else if (node.declaration) {
              const declaration = node.declaration;
              if (t.isVariableDeclaration(declaration)) {
                declaration.declarations.forEach((decl) => {
                  if (t.isIdentifier(decl.id)) {
                    globalIdentifiers.add(decl.id.name);
                  }
                });
              } else if (
                t.isFunctionDeclaration(declaration) ||
                t.isClassDeclaration(declaration)
              ) {
                if (t.isIdentifier(declaration.id)) {
                  globalIdentifiers.add(declaration.id.name);
                }
              }
            }
          },
        });
        const identifiersToExport = Array.from(globalIdentifiers).filter(
          (name) => {
            return !existingExports.has(name);
          },
        );
        if (identifiersToExport.length > 0) {
          const gccIdentifier = t.identifier(GCC);
          gccIdentifier.typeAnnotation = t.tsTypeAnnotation(
            t.tsTypeLiteral(
              identifiersToExport.map((name) =>
                t.tsPropertySignature(
                  t.identifier(name),
                  t.tsTypeAnnotation(t.tsTypeQuery(t.identifier(name))),
                ),
              ),
            ),
          );
          const globalDeclaration = t.tsModuleDeclaration(
            t.identifier("globalThis"),
            t.tsModuleBlock([
              t.variableDeclaration("var", [
                t.variableDeclarator(gccIdentifier),
              ]),
            ]),
          );
          globalDeclaration.declare = true;
          programPath.unshiftContainer("body", globalDeclaration);
          const gccAssignments = identifiersToExport.map((name) =>
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.memberExpression(
                  t.memberExpression(
                    t.identifier("globalThis"),
                    t.identifier(GCC),
                  ),
                  t.identifier(name),
                ),
                t.identifier(name),
              ),
            ),
          );
          programPath.pushContainer("body", gccAssignments);
          programPath.pushContainer("body", [
            t.exportNamedDeclaration(
              null,
              identifiersToExport.map((name) =>
                t.exportSpecifier(t.identifier(name), t.identifier(name)),
              ),
            ),
          ]);
        }
      },
    },
  };
};
