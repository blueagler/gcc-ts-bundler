import {
  NodePath,
  parse,
  PluginObj,
  types as t,
  transformAsync,
  traverse,
} from "@babel/core";
//@ts-expect-error - Babel plugin not found in types
import syntaxTypescript from "@babel/plugin-syntax-typescript";
import { existsSync, readFileSync } from "fs";
import path from "path";

interface GCCPluginOptions {
  defaultExportIdentifier: string;
  gccIdentifier: string;
}

const exportCache: Map<string, Set<string>> = new Map();

const processingModules: Set<string> = new Set();

export async function customTransform(
  code: string,
  filePath: string,
  isEntryPoint: boolean,
): Promise<string> {
  const plugins: PluginObj[] = [syntaxTypescript];

  if (isEntryPoint) {
    plugins.push(
      addGCCExportsFromESM(filePath, {
        defaultExportIdentifier: "__DEFAULT_EXPORT__",
        gccIdentifier: "GCC",
      }),
    );
  }

  const transformed = await transformAsync(code, {
    babelrc: false,
    filename: filePath,
    plugins,
  });

  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }

  return transformed.code;
}

const addGCCExportsFromESM = (
  filePath: string,
  options: GCCPluginOptions,
): PluginObj => ({
  name: "add-gcc-exports-from-esm",
  visitor: {
    Program(programPath: NodePath<t.Program>): void {
      const { defaultExportIdentifier, gccIdentifier } = options;
      const existingImports = new Map<string, Set<string>>();
      const existingExports = new Set<string>();
      const globalIdentifiers = new Set<string>();
      let defaultExportId: null | string = null;
      programPath.traverse({
        ExportNamedDeclaration(exportPath: NodePath<t.ExportNamedDeclaration>) {
          const { node } = exportPath;
          if (node.specifiers.length > 0) {
            node.specifiers.forEach((specifier) => {
              if (t.isExportSpecifier(specifier)) {
                const exportedName = getExportedName(specifier.exported);
                existingExports.add(exportedName);
                globalIdentifiers.add(exportedName);
              }
            });
          } else if (node.declaration) {
            const declarationIds = getDeclarationIdentifiers(node.declaration);
            declarationIds.forEach((id) => {
              existingExports.add(id);
              globalIdentifiers.add(id);
            });
          }
        },
        ImportDeclaration(importPath: NodePath<t.ImportDeclaration>) {
          const source = importPath.node.source.value;
          const specifiers = importPath.node.specifiers;
          const importedNames =
            existingImports.get(source) || new Set<string>();
          specifiers.forEach((specifier) => {
            if (t.isImportSpecifier(specifier)) {
              const importedName = getImportedName(specifier.imported);
              importedNames.add(importedName);
            }
          });
          existingImports.set(source, importedNames);
        },
      });
      programPath.traverse({
        ExportDefaultDeclaration(
          exportPath: NodePath<t.ExportDefaultDeclaration>,
        ) {
          const defaultExportNode = exportPath.node;
          defaultExportId = handleDefaultExport(
            programPath,
            defaultExportNode,
            defaultExportIdentifier,
          );
          exportPath.remove();
        },
      });
      programPath.traverse({
        ExportAllDeclaration(exportAllPath: NodePath<t.ExportAllDeclaration>) {
          const source = exportAllPath.node.source.value;
          let modulePath: string;
          try {
            modulePath = resolveModulePath(source, filePath);
          } catch (error) {
            console.error(
              error instanceof Error
                ? error.message
                : "Unknown error during module resolution.",
            );
            exportAllPath.remove();
            return;
          }
          let collectedExports: string[];
          try {
            collectedExports = collectExportsFromModule(modulePath);
          } catch (error) {
            console.error(
              error instanceof Error
                ? error.message
                : "Unknown error during export collection.",
            );
            exportAllPath.remove();
            return;
          }
          const newImports = collectedExports.filter(
            (name) => !existingImports.get(source)?.has(name),
          );
          if (newImports.length > 0) {
            const importDeclaration = t.importDeclaration(
              newImports.map((name) =>
                t.importSpecifier(t.identifier(name), t.identifier(name)),
              ),
              t.stringLiteral(source),
            );
            exportAllPath.replaceWith(importDeclaration);
            const importedNames =
              existingImports.get(source) || new Set<string>();
            newImports.forEach((name) => importedNames.add(name));
            existingImports.set(source, importedNames);
            collectedExports.forEach((name) => {
              globalIdentifiers.add(name);
              existingExports.add(name);
            });
          } else {
            exportAllPath.remove();
          }
        },
      });
      if (globalIdentifiers.size > 0 || defaultExportId) {
        addGCCDeclarations(
          programPath,
          Array.from(globalIdentifiers),
          defaultExportId,
          gccIdentifier,
        );
        addGCCAssignments(
          programPath,
          Array.from(globalIdentifiers),
          defaultExportId,
          gccIdentifier,
        );
        addMissingExports(
          programPath,
          Array.from(globalIdentifiers),
          existingExports,
        );
      }
    },
  },
});

function getDeclarationIdentifiers(declaration: t.Declaration): string[] {
  const identifiers: string[] = [];
  if (t.isVariableDeclaration(declaration)) {
    declaration.declarations.forEach((decl) => {
      if (t.isIdentifier(decl.id)) {
        identifiers.push(decl.id.name);
      }
    });
  } else if (
    t.isFunctionDeclaration(declaration) ||
    t.isClassDeclaration(declaration)
  ) {
    if (declaration.id) {
      identifiers.push(declaration.id.name);
    }
  }
  return identifiers;
}

function resolveModulePath(source: string, filePath: string): string {
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const resolvedPath = path.resolve(path.dirname(filePath), source + ext);
    if (existsSync(resolvedPath)) return resolvedPath;
  }
  throw new Error(`Module not found: ${source} from ${filePath}`);
}

function collectExportsFromModule(modulePath: string): string[] {
  if (exportCache.has(modulePath)) {
    return Array.from(exportCache.get(modulePath)!);
  }
  if (processingModules.has(modulePath)) {
    throw new Error(`Circular dependency detected: ${modulePath}`);
  }
  if (!existsSync(modulePath)) {
    throw new Error(`Module not found: ${modulePath}`);
  }
  processingModules.add(modulePath);
  const code = readFileSync(modulePath, "utf-8");
  const ast = parseCode(code, modulePath);
  const exports = new Set<string>();
  traverse(ast, {
    ExportAllDeclaration(exportAllPath: NodePath<t.ExportAllDeclaration>) {
      const nestedSource = exportAllPath.node.source.value;
      let nestedModulePath: string;
      try {
        nestedModulePath = resolveModulePath(nestedSource, modulePath);
      } catch (error) {
        console.error(
          error instanceof Error
            ? error.message
            : "Unknown error during nested module resolution.",
        );
        return;
      }
      let nestedExports: string[];
      try {
        nestedExports = collectExportsFromModule(nestedModulePath);
      } catch (error) {
        console.error(
          error instanceof Error
            ? error.message
            : "Unknown error during nested export collection.",
        );
        return;
      }
      nestedExports.forEach((name) => exports.add(name));
    },
    ExportNamedDeclaration(exportPath: NodePath<t.ExportNamedDeclaration>) {
      const { node } = exportPath;
      if (node.specifiers.length > 0) {
        node.specifiers.forEach((specifier) => {
          if (t.isExportSpecifier(specifier)) {
            const exportedName = getExportedName(specifier.exported);
            exports.add(exportedName);
          }
        });
      } else if (node.declaration) {
        const ids = getDeclarationIdentifiers(node.declaration);
        ids.forEach((id) => exports.add(id));
      }
    },
  });

  processingModules.delete(modulePath);
  exportCache.set(modulePath, exports);
  return Array.from(exports);
}

function parseCode(code: string, filePath: string): t.File {
  return parse(code, {
    plugins: [syntaxTypescript],
    sourceFileName: filePath,
  })!;
}

function handleDefaultExport(
  programPath: NodePath<t.Program>,
  defaultExportNode: t.ExportDefaultDeclaration,
  defaultExportIdentifier: string,
): string {
  let defaultIdentifierName = defaultExportIdentifier;
  if (t.isFunctionDeclaration(defaultExportNode.declaration)) {
    if (defaultExportNode.declaration.id) {
      defaultIdentifierName = defaultExportNode.declaration.id.name;
      programPath.unshiftContainer("body", defaultExportNode.declaration);
    } else {
      const funcExpr = t.functionExpression(
        null,
        defaultExportNode.declaration.params,
        defaultExportNode.declaration.body,
        defaultExportNode.declaration.generator,
        defaultExportNode.declaration.async,
      );
      const defaultVariableDeclaration = t.variableDeclaration("const", [
        t.variableDeclarator(t.identifier(defaultExportIdentifier), funcExpr),
      ]);
      programPath.pushContainer("body", defaultVariableDeclaration);
    }
  } else if (t.isClassDeclaration(defaultExportNode.declaration)) {
    if (defaultExportNode.declaration.id) {
      defaultIdentifierName = defaultExportNode.declaration.id.name;
      programPath.unshiftContainer("body", defaultExportNode.declaration);
    } else {
      const classExpr = t.classExpression(
        null,
        defaultExportNode.declaration.superClass,
        defaultExportNode.declaration.body,
        defaultExportNode.declaration.decorators || [],
      );
      const defaultVariableDeclaration = t.variableDeclaration("const", [
        t.variableDeclarator(t.identifier(defaultExportIdentifier), classExpr),
      ]);
      programPath.pushContainer("body", defaultVariableDeclaration);
    }
  } else if (t.isTSDeclareFunction(defaultExportNode.declaration)) {
    throw new Error("Unsupported default export: TSDeclareFunction");
  } else if (t.isExpression(defaultExportNode.declaration)) {
    const defaultVariableDeclaration = t.variableDeclaration("const", [
      t.variableDeclarator(
        t.identifier(defaultExportIdentifier),
        defaultExportNode.declaration,
      ),
    ]);
    programPath.pushContainer("body", defaultVariableDeclaration);
  } else {
    throw new Error("Unsupported default export type");
  }
  return defaultIdentifierName;
}

function addGCCDeclarations(
  programPath: NodePath<t.Program>,
  identifiers: string[],
  defaultExportIdentifier: null | string,
  gccIdentifier: string,
): void {
  const properties = identifiers.map((name) =>
    t.tsPropertySignature(
      t.identifier(name),
      t.tsTypeAnnotation(t.tsTypeQuery(t.identifier(name))),
    ),
  );
  if (defaultExportIdentifier) {
    properties.push(
      t.tsPropertySignature(
        t.identifier(defaultExportIdentifier),
        t.tsTypeAnnotation(
          t.tsTypeQuery(t.identifier(defaultExportIdentifier)),
        ),
      ),
    );
  }
  const gccId = t.identifier(gccIdentifier);
  gccId.typeAnnotation = t.tsTypeAnnotation(t.tsTypeLiteral(properties));
  const globalDeclaration = t.tsModuleDeclaration(
    t.identifier("globalThis"),
    t.tsModuleBlock([
      t.variableDeclaration("var", [t.variableDeclarator(gccId)]),
    ]),
  );
  globalDeclaration.declare = true;
  let lastVarIndex = -1;
  for (let i = programPath.node.body.length - 1; i >= 0; i--) {
    const node = programPath.node.body[i];
    if (t.isVariableDeclaration(node)) {
      lastVarIndex = i;
      break;
    }
  }
  if (lastVarIndex !== -1) {
    programPath.node.body.splice(lastVarIndex + 1, 0, globalDeclaration);
  } else {
    programPath.pushContainer("body", globalDeclaration);
  }
}

function addGCCAssignments(
  programPath: NodePath<t.Program>,
  identifiers: string[],
  defaultExportIdentifier: null | string,
  gccIdentifier: string,
): void {
  const assignments = identifiers.map((name) =>
    t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(
          t.memberExpression(
            t.identifier("globalThis"),
            t.identifier(gccIdentifier),
          ),
          t.identifier(name),
        ),
        t.identifier(name),
      ),
    ),
  );
  if (defaultExportIdentifier) {
    const defaultAssignment = t.expressionStatement(
      t.assignmentExpression(
        "=",
        t.memberExpression(
          t.memberExpression(
            t.identifier("globalThis"),
            t.identifier(gccIdentifier),
          ),
          t.identifier(defaultExportIdentifier),
        ),
        t.identifier(defaultExportIdentifier),
      ),
    );
    assignments.push(defaultAssignment);
  }
  programPath.pushContainer("body", assignments);
}

function addMissingExports(
  programPath: NodePath<t.Program>,
  identifiers: string[],
  existingExports: Set<string>,
): void {
  const exportsToAdd = identifiers.filter((name) => !existingExports.has(name));
  if (exportsToAdd.length > 0) {
    const exportSpecifiers = exportsToAdd.map((name) =>
      t.exportSpecifier(t.identifier(name), t.identifier(name)),
    );
    const exportNamedDeclaration = t.exportNamedDeclaration(
      null,
      exportSpecifiers,
    );
    programPath.pushContainer("body", exportNamedDeclaration);
  }
}

function getExportedName(exported: t.Identifier | t.StringLiteral): string {
  if (t.isIdentifier(exported)) {
    return exported.name;
  } else if (t.isStringLiteral(exported)) {
    return exported.value;
  }
  throw new Error("Unsupported exported node type");
}

function getImportedName(imported: t.Identifier | t.StringLiteral): string {
  if (t.isIdentifier(imported)) {
    return imported.name;
  } else if (t.isStringLiteral(imported)) {
    return imported.value;
  }
  throw new Error("Unsupported imported node type");
}
