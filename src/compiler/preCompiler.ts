import {
  NodePath,
  parse,
  PluginObj,
  types as t,
  transformSync,
  traverse,
} from "@babel/core";
//@ts-expect-error - missing types
import syntaxTypescript from "@babel/plugin-syntax-typescript";
import { existsSync, promises as fs } from "fs";
import path from "path";
const modulePathCache = new Map<string, string>();
const fileContentCache = new Map<string, string>();
const parsedASTCache = new Map<string, t.File>();
const DEFAULT_EXPORT_IDENTIFIER = "__DEFAULT_EXPORT__";
const GCC = "GCC";
export async function customTransform(
  code: string,
  filePath: string,
  isEntryPoint: boolean,
): Promise<string> {
  if (code.length === 0) {
    return code;
  }
  await preloadModules(filePath);
  const plugins = [syntaxTypescript];
  if (isEntryPoint) {
    plugins.push(addGCCExportsFromESM(filePath));
  }
  const transformed = transformSync(code, {
    babelrc: false,
    filename: filePath,
    plugins,
  });
  if (!transformed?.code) {
    console.log(transformed);
    throw new Error("Babel transform failed");
  }
  return transformed.code;
}
async function preloadModules(entryFilePath: string) {
  const filesToProcess = new Set<string>();
  await collectModules(entryFilePath, filesToProcess);
  await Promise.all(
    Array.from(filesToProcess).map(async (filePath) => {
      if (!fileContentCache.has(filePath)) {
        const code = await fs.readFile(filePath, "utf-8");
        fileContentCache.set(filePath, code);
        const ast = parse(code, {
          plugins: [syntaxTypescript],
        })!;
        parsedASTCache.set(filePath, ast);
      }
    }),
  );
}
async function collectModules(filePath: string, filesToProcess: Set<string>) {
  if (filesToProcess.has(filePath)) {
    return;
  }
  filesToProcess.add(filePath);
  let ast = parsedASTCache.get(filePath);
  if (!ast) {
    const code = await fs.readFile(filePath, "utf-8");
    fileContentCache.set(filePath, code);
    ast = parse(code, {
      plugins: [syntaxTypescript],
    })!;
    parsedASTCache.set(filePath, ast);
  }
  traverse(ast, {
    ExportAllDeclaration(exportPath) {
      const source = exportPath.node.source.value;
      const resolvedPath = resolveModulePath(source, filePath);
      void collectModules(resolvedPath, filesToProcess);
    },
    ImportDeclaration(importPath) {
      const source = importPath.node.source.value;
      const resolvedPath = resolveModulePath(source, filePath);
      void collectModules(resolvedPath, filesToProcess);
    },
  });
}
function resolveModulePath(source: string, importerFile: string): string {
  const cacheKey = path.resolve(path.dirname(importerFile), source);
  if (modulePathCache.has(cacheKey)) {
    return modulePathCache.get(cacheKey)!;
  }
  const extensions = [".ts", ".d.ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const resolvedPath = path.resolve(
      path.dirname(importerFile),
      `${source}${ext}`,
    );
    if (existsSync(resolvedPath)) {
      modulePathCache.set(cacheKey, resolvedPath);
      return resolvedPath;
    }
  }
  throw new Error(`Module not found: ${source}`);
}
const addGCCExportsFromESM = (filePath: string): PluginObj => {
  return {
    visitor: {
      Program(programPath) {
        const globalIdentifiers = new Set<string>();
        const existingImports = new Map<string, Set<string>>();

        // First pass: collect all exports and imports
        programPath.traverse({
          ExportDefaultDeclaration(
            exportPath: NodePath<t.ExportDefaultDeclaration>,
          ) {
            const { node } = exportPath;
            const name = DEFAULT_EXPORT_IDENTIFIER;
            if (
              t.isIdentifier(node.declaration) &&
              node.declaration.name === DEFAULT_EXPORT_IDENTIFIER
            ) {
              return;
            }
            if (t.isTSDeclareFunction(node.declaration)) {
              return;
            }
            const id = t.identifier(name);
            const declaration = node.declaration;
            if (
              t.isFunctionDeclaration(declaration) ||
              t.isClassDeclaration(declaration)
            ) {
              const expr = t.toExpression(declaration);
              const variableDeclaration = t.variableDeclaration("const", [
                t.variableDeclarator(id, expr),
              ]);
              globalIdentifiers.add(name);
              exportPath.replaceWithMultiple([
                variableDeclaration,
                t.exportDefaultDeclaration(id),
              ]);
            } else {
              const variableDeclaration = t.variableDeclaration("const", [
                t.variableDeclarator(id, declaration),
              ]);
              globalIdentifiers.add(name);
              exportPath.replaceWithMultiple([
                variableDeclaration,
                t.exportDefaultDeclaration(id),
              ]);
            }
          },
          ExportNamedDeclaration(
            exportPath: NodePath<t.ExportNamedDeclaration>,
          ) {
            const { node } = exportPath;

            if (node.source) {
              const source = node.source.value;
              const specifiers = node.specifiers;
              const identifiersToImport = specifiers
                .filter((spec): spec is t.ExportSpecifier =>
                  t.isExportSpecifier(spec),
                )
                .map((spec) => ({
                  exported: t.isIdentifier(spec.exported)
                    ? spec.exported.name
                    : spec.exported.value,
                  local: spec.local.name,
                }));

              if (identifiersToImport.length > 0) {
                exportPath.insertBefore(
                  t.importDeclaration(
                    identifiersToImport.map(({ exported, local }) =>
                      t.importSpecifier(
                        t.identifier(local),
                        t.identifier(exported),
                      ),
                    ),
                    t.stringLiteral(source),
                  ),
                );

                if (!existingImports.has(source)) {
                  existingImports.set(source, new Set());
                }
                identifiersToImport.forEach(({ exported }) => {
                  existingImports.get(source)!.add(exported);
                  globalIdentifiers.add(exported);
                });
              }
            }

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
                if (declaration.id) {
                  globalIdentifiers.add(declaration.id.name);
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

        programPath.traverse({
          ExportAllDeclaration(exportAllPath) {
            const source = exportAllPath.node.source.value;
            const modulePath = resolveModulePath(source, filePath);
            const ast = parsedASTCache.get(modulePath);
            if (!ast) {
              throw new Error(`AST not found for module ${modulePath}`);
            }
            const collectedExports = new Set<string>();
            const exportCollector = {
              ExportAllDeclaration(
                nestedExportAllPath: NodePath<t.ExportAllDeclaration>,
              ) {
                const nestedSource = nestedExportAllPath.node.source.value;
                const nestedModulePath = resolveModulePath(
                  nestedSource,
                  modulePath,
                );
                const nestedAST = parsedASTCache.get(nestedModulePath);
                if (nestedAST) {
                  traverse(nestedAST, exportCollector);
                }
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
            traverse(ast, exportCollector);
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
        const identifiersToAssign = Array.from(globalIdentifiers);
        if (identifiersToAssign.length > 0) {
          const gccIdentifier = t.identifier(GCC);
          gccIdentifier.typeAnnotation = t.tsTypeAnnotation(
            t.tsTypeLiteral(
              identifiersToAssign.map((name) =>
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
          const gccAssignments = identifiersToAssign.map((name) =>
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
        }
      },
    },
  };
};
