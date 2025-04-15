#!/usr/bin/env node
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  main: () => main
});
module.exports = __toCommonJS(exports_src);
var import_fs5 = __toESM(require("fs"));
var import_path8 = __toESM(require("path"));
var import_typescript3 = __toESM(require("typescript"));

// src/compiler/closureCompiler.ts
var import_promises = __toESM(require("fs/promises"));
var import_google_closure_compiler = require("google-closure-compiler");
var import_path = __toESM(require("path"));

// src/compiler/postCompiler.ts
var import_core = require("@babel/core");
var import_uglify_js = require("uglify-js");
async function customTransform(code) {
  if (code.length === 0) {
    return code;
  }
  const plugins = [
    convertGCCExportsToESM({
      gccIdentifier: "GCC",
      defaultExportIdentifier: "__DEFAULT_EXPORT__"
    })
  ];
  const transformed = await import_core.transformAsync(code, {
    babelrc: false,
    plugins
  });
  if (!transformed?.code) {
    throw new Error("Babel transform failed");
  }
  const minified = import_uglify_js.minify(transformed.code, {
    compress: {
      hoist_vars: true,
      passes: 3,
      pure_getters: true,
      toplevel: true,
      unsafe: true
    },
    module: true
  });
  if (minified.error) {
    throw new Error(`UglifyJS minify failed: ${minified.error.message}`);
  }
  return minified.code;
}
function getPropertyName(property) {
  if (import_core.types.isIdentifier(property)) {
    return property.name;
  } else if (import_core.types.isStringLiteral(property)) {
    return property.value;
  }
  return;
}
var convertGCCExportsToESM = (options) => {
  const gccId = options.gccIdentifier;
  const defaultExportId = options.defaultExportIdentifier;
  return {
    name: "convert-gcc-exports-to-esm",
    visitor: {
      Program(path) {
        const exportsMap = new Map;
        const processedExports = new Set;
        const existingExportNames = new Set;
        path.node.body.forEach((node) => {
          if (import_core.types.isExportNamedDeclaration(node)) {
            node.specifiers.forEach((specifier) => {
              if (import_core.types.isExportSpecifier(specifier)) {
                const exportedName = import_core.types.isIdentifier(specifier.exported) ? specifier.exported.name : specifier.exported.value;
                existingExportNames.add(exportedName);
              }
            });
          }
        });
        path.traverse({
          AssignmentExpression(assignPath) {
            const left = assignPath.node.left;
            if (import_core.types.isMemberExpression(left) && import_core.types.isMemberExpression(left.object) && import_core.types.isIdentifier(left.object.object, { name: "globalThis" }) && import_core.types.isIdentifier(left.object.property, { name: gccId }) && (import_core.types.isIdentifier(left.property) || import_core.types.isStringLiteral(left.property))) {
              const exportName = getPropertyName(left.property);
              if (!exportName)
                return;
              if (processedExports.has(exportName)) {
                assignPath.parentPath.remove();
                return;
              }
              processedExports.add(exportName);
              const variableName = exportName === defaultExportId ? "defaultExport" : path.scope.generateUidIdentifier(exportName).name;
              exportsMap.set(exportName, variableName);
              const variableDeclaration = import_core.types.variableDeclaration("const", [
                import_core.types.variableDeclarator(import_core.types.identifier(variableName), assignPath.node.right)
              ]);
              assignPath.parentPath.replaceWith(variableDeclaration);
            }
          }
        });
        if (exportsMap.size === 0) {
          return;
        }
        const namedExportSpecifiers = [];
        let defaultExportName;
        exportsMap.forEach((variableName, exportName) => {
          if (exportName === defaultExportId) {
            defaultExportName = variableName;
          } else if (!existingExportNames.has(exportName)) {
            namedExportSpecifiers.push(import_core.types.exportSpecifier(import_core.types.identifier(variableName), import_core.types.identifier(exportName)));
          }
        });
        if (defaultExportName) {
          const hasDefaultExport = path.node.body.some((node) => import_core.types.isExportDefaultDeclaration(node));
          if (!hasDefaultExport) {
            const exportDefault = import_core.types.exportDefaultDeclaration(import_core.types.identifier(defaultExportName));
            path.pushContainer("body", exportDefault);
          }
        }
        if (namedExportSpecifiers.length > 0) {
          const exportNamedDeclaration = import_core.types.exportNamedDeclaration(null, namedExportSpecifiers);
          path.pushContainer("body", exportNamedDeclaration);
        }
        path.node.body = path.node.body.filter((node) => {
          if (import_core.types.isExpressionStatement(node) && import_core.types.isAssignmentExpression(node.expression) && import_core.types.isMemberExpression(node.expression.left) && import_core.types.isMemberExpression(node.expression.left.object) && import_core.types.isIdentifier(node.expression.left.object.object, {
            name: "globalThis"
          }) && import_core.types.isIdentifier(node.expression.left.object.property, {
            name: gccId
          })) {
            return false;
          }
          return true;
        });
      }
    }
  };
};

// src/compiler/closureCompiler.ts
var GCC_ENTRY = "globalThis.GCC";
function unlockGCCAssignments(code) {
  return code.replace(new RegExp(`//${GCC_ENTRY}.([\\w]+)\\s*=\\s*([^;]+);`, "g"), `${GCC_ENTRY}.$1 = $2;`);
}
function lockGCCAssignments(code) {
  return code.replace(new RegExp(`${GCC_ENTRY}.([\\w]+)\\s*=\\s*([^;]+);`, "g"), `//${GCC_ENTRY}.$1 = $2;`);
}
async function prepareEntryPoints(entryPoints) {
  const reads = entryPoints.map(async (path2) => ({
    isLocked: false,
    originalContent: await import_promises.default.readFile(path2, "utf-8"),
    path: path2
  }));
  return Promise.all(reads);
}
async function updateEntryPointStates(states, currentPath) {
  const writes = states.filter((state) => {
    const shouldBeLocked = state.path !== currentPath;
    return shouldBeLocked !== state.isLocked;
  }).map(async (state) => {
    const content = state.path === currentPath ? unlockGCCAssignments(state.originalContent) : lockGCCAssignments(state.originalContent);
    await import_promises.default.writeFile(state.path, content);
    state.isLocked = state.path !== currentPath;
  });
  await Promise.all(writes);
}
async function runClosureCompiler(settings) {
  const options = {
    assumeFunctionWrapper: true,
    compilationLevel: settings.compilationLevel,
    dependencyMode: "PRUNE",
    externs: settings.externs,
    js: settings.js,
    languageIn: "UNSTABLE",
    languageOut: settings.languageOut,
    moduleResolution: "NODE",
    processCommonJsModules: true,
    rewritePolyfills: false,
    warningLevel: settings.verbose ? "VERBOSE" : "DEFAULT"
  };
  let entryPointStates = [];
  try {
    entryPointStates = await prepareEntryPoints(settings.entryPoints);
    for (const entryPoint of settings.entryPoints) {
      const baseName = import_path.default.basename(entryPoint);
      const outputPath = import_path.default.join(settings.outputDir, baseName);
      const tempPath = import_path.default.join(settings.outputDir, `${baseName}.tmp`);
      try {
        await updateEntryPointStates(entryPointStates, entryPoint);
        await new Promise((resolve, reject) => {
          new import_google_closure_compiler.compiler({
            ...options,
            entryPoint,
            jsOutputFile: tempPath
          }).run((exitCode, stdOut, stdErr) => {
            if (exitCode === 0) {
              console.log(`Compilation of ${baseName} successful.`);
              if (stdOut)
                console.log(stdOut);
              import_promises.default.readFile(tempPath, "utf-8").then((compiledCode) => customTransform(compiledCode)).then((transformedCode) => {
                const lockedCode = lockGCCAssignments(transformedCode);
                return import_promises.default.writeFile(outputPath, lockedCode);
              }).then(() => import_promises.default.unlink(tempPath)).then(() => resolve()).catch((error) => reject(new Error(`Failed to write file: ${error}`)));
            } else {
              console.error(`Compilation of ${baseName} failed.`);
              if (stdErr)
                console.error(stdErr);
              reject(new Error(`Compilation failed for ${baseName}`));
            }
          });
        });
      } catch (error) {
        await import_promises.default.unlink(tempPath).catch(() => {});
        throw error;
      }
    }
    const finalRestores = entryPointStates.filter((state) => state.isLocked).map((state) => import_promises.default.writeFile(state.path, state.originalContent));
    await Promise.all(finalRestores);
    return 0;
  } catch (error) {
    console.error("Compilation process encountered an error:", error);
    try {
      await Promise.all(entryPointStates.map((state) => import_promises.default.writeFile(state.path, state.originalContent)));
    } catch (restoreError) {
      console.error("Failed to restore files:", restoreError);
    }
    return 1;
  }
}

// src/compiler/preCompiler.ts
var import_core2 = require("@babel/core");
var import_plugin_syntax_typescript = __toESM(require("@babel/plugin-syntax-typescript"));
var import_fs = require("fs");
var import_path2 = __toESM(require("path"));
var modulePathCache = new Map;
var fileContentCache = new Map;
var parsedASTCache = new Map;
var DEFAULT_EXPORT_IDENTIFIER = "__DEFAULT_EXPORT__";
var GCC = "GCC";
async function customTransform2(code, filePath, isEntryPoint) {
  if (code.length === 0) {
    return code;
  }
  await preloadModules(filePath);
  const plugins = [import_plugin_syntax_typescript.default];
  if (isEntryPoint) {
    plugins.push(addGCCExportsFromESM(filePath));
  }
  const transformed = import_core2.transformSync(code, {
    babelrc: false,
    filename: filePath,
    plugins
  });
  if (!transformed?.code) {
    console.log(transformed);
    throw new Error("Babel transform failed");
  }
  return transformed.code;
}
async function preloadModules(entryFilePath) {
  const filesToProcess = new Set;
  await collectModules(entryFilePath, filesToProcess);
  await Promise.all(Array.from(filesToProcess).map(async (filePath) => {
    if (!fileContentCache.has(filePath)) {
      const code = await import_fs.promises.readFile(filePath, "utf-8");
      fileContentCache.set(filePath, code);
      const ast = import_core2.parse(code, {
        plugins: [import_plugin_syntax_typescript.default]
      });
      parsedASTCache.set(filePath, ast);
    }
  }));
}
async function collectModules(filePath, filesToProcess) {
  if (filesToProcess.has(filePath)) {
    return;
  }
  filesToProcess.add(filePath);
  let ast = parsedASTCache.get(filePath);
  if (!ast) {
    const code = await import_fs.promises.readFile(filePath, "utf-8");
    fileContentCache.set(filePath, code);
    ast = import_core2.parse(code, {
      plugins: [import_plugin_syntax_typescript.default]
    });
    parsedASTCache.set(filePath, ast);
  }
  import_core2.traverse(ast, {
    ExportAllDeclaration(exportPath) {
      const source = exportPath.node.source.value;
      const resolvedPath = resolveModulePath(source, filePath);
      collectModules(resolvedPath, filesToProcess);
    },
    ImportDeclaration(importPath) {
      const source = importPath.node.source.value;
      const resolvedPath = resolveModulePath(source, filePath);
      collectModules(resolvedPath, filesToProcess);
    }
  });
}
function resolveModulePath(source, importerFile) {
  const cacheKey = import_path2.default.resolve(import_path2.default.dirname(importerFile), source);
  if (modulePathCache.has(cacheKey)) {
    return modulePathCache.get(cacheKey);
  }
  const extensions = [".ts", ".d.ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const resolvedPath = import_path2.default.resolve(import_path2.default.dirname(importerFile), `${source}${ext}`);
    if (import_fs.existsSync(resolvedPath)) {
      modulePathCache.set(cacheKey, resolvedPath);
      return resolvedPath;
    }
  }
  throw new Error(`Module not found: ${source}`);
}
var addGCCExportsFromESM = (filePath) => {
  return {
    visitor: {
      Program(programPath) {
        const globalIdentifiers = new Set;
        const existingImports = new Map;
        programPath.traverse({
          ExportDefaultDeclaration(exportPath) {
            const { node } = exportPath;
            const name = DEFAULT_EXPORT_IDENTIFIER;
            if (import_core2.types.isIdentifier(node.declaration) && node.declaration.name === DEFAULT_EXPORT_IDENTIFIER) {
              return;
            }
            if (import_core2.types.isTSDeclareFunction(node.declaration)) {
              return;
            }
            const id = import_core2.types.identifier(name);
            const declaration = node.declaration;
            if (import_core2.types.isFunctionDeclaration(declaration) || import_core2.types.isClassDeclaration(declaration)) {
              const expr = import_core2.types.toExpression(declaration);
              const variableDeclaration = import_core2.types.variableDeclaration("const", [
                import_core2.types.variableDeclarator(id, expr)
              ]);
              globalIdentifiers.add(name);
              exportPath.replaceWithMultiple([
                variableDeclaration,
                import_core2.types.exportDefaultDeclaration(id)
              ]);
            } else {
              const variableDeclaration = import_core2.types.variableDeclaration("const", [
                import_core2.types.variableDeclarator(id, declaration)
              ]);
              globalIdentifiers.add(name);
              exportPath.replaceWithMultiple([
                variableDeclaration,
                import_core2.types.exportDefaultDeclaration(id)
              ]);
            }
          },
          ExportNamedDeclaration(exportPath) {
            const { node } = exportPath;
            if (node.source) {
              const source = node.source.value;
              const specifiers = node.specifiers;
              const identifiersToImport = specifiers.filter((spec) => import_core2.types.isExportSpecifier(spec)).map((spec) => ({
                exported: import_core2.types.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value,
                local: spec.local.name
              }));
              if (identifiersToImport.length > 0) {
                exportPath.insertBefore(import_core2.types.importDeclaration(identifiersToImport.map(({ exported, local }) => import_core2.types.importSpecifier(import_core2.types.identifier(local), import_core2.types.identifier(exported))), import_core2.types.stringLiteral(source)));
                if (!existingImports.has(source)) {
                  existingImports.set(source, new Set);
                }
                identifiersToImport.forEach(({ exported }) => {
                  existingImports.get(source).add(exported);
                  globalIdentifiers.add(exported);
                });
              }
            }
            if (node.specifiers.length > 0) {
              node.specifiers.forEach((specifier) => {
                if (import_core2.types.isExportSpecifier(specifier) && import_core2.types.isIdentifier(specifier.exported)) {
                  globalIdentifiers.add(specifier.exported.name);
                }
              });
            } else if (node.declaration) {
              const declaration = node.declaration;
              if (import_core2.types.isVariableDeclaration(declaration)) {
                declaration.declarations.forEach((decl) => {
                  if (import_core2.types.isIdentifier(decl.id)) {
                    globalIdentifiers.add(decl.id.name);
                  }
                });
              } else if (import_core2.types.isFunctionDeclaration(declaration) || import_core2.types.isClassDeclaration(declaration)) {
                if (declaration.id) {
                  globalIdentifiers.add(declaration.id.name);
                }
              }
            }
          },
          ImportDeclaration(importPath) {
            const source = importPath.node.source.value;
            const specifiers = importPath.node.specifiers;
            if (!existingImports.has(source)) {
              existingImports.set(source, new Set);
            }
            specifiers.forEach((specifier) => {
              if (import_core2.types.isImportSpecifier(specifier) && import_core2.types.isIdentifier(specifier.imported)) {
                existingImports.get(source).add(specifier.imported.name);
              }
            });
          }
        });
        programPath.traverse({
          ExportAllDeclaration(exportAllPath) {
            const source = exportAllPath.node.source.value;
            const modulePath = resolveModulePath(source, filePath);
            const ast = parsedASTCache.get(modulePath);
            if (!ast) {
              throw new Error(`AST not found for module ${modulePath}`);
            }
            const collectedExports = new Set;
            const exportCollector = {
              ExportAllDeclaration(nestedExportAllPath) {
                const nestedSource = nestedExportAllPath.node.source.value;
                const nestedModulePath = resolveModulePath(nestedSource, modulePath);
                const nestedAST = parsedASTCache.get(nestedModulePath);
                if (nestedAST) {
                  import_core2.traverse(nestedAST, exportCollector);
                }
              },
              ExportNamedDeclaration(namedExportPath) {
                const { node } = namedExportPath;
                if (node.specifiers.length > 0) {
                  node.specifiers.forEach((specifier) => {
                    if (import_core2.types.isExportSpecifier(specifier) && import_core2.types.isIdentifier(specifier.exported)) {
                      collectedExports.add(specifier.exported.name);
                    }
                  });
                } else if (node.declaration) {
                  const declaration = node.declaration;
                  if (import_core2.types.isVariableDeclaration(declaration)) {
                    declaration.declarations.forEach((decl) => {
                      if (import_core2.types.isIdentifier(decl.id)) {
                        collectedExports.add(decl.id.name);
                      }
                    });
                  } else if (import_core2.types.isFunctionDeclaration(declaration) || import_core2.types.isClassDeclaration(declaration)) {
                    if (import_core2.types.isIdentifier(declaration.id)) {
                      collectedExports.add(declaration.id.name);
                    }
                  }
                }
              }
            };
            import_core2.traverse(ast, exportCollector);
            const identifiersToImport = Array.from(collectedExports).filter((name) => {
              return !existingImports.get(source)?.has(name);
            });
            if (identifiersToImport.length > 0) {
              exportAllPath.replaceWithMultiple([
                import_core2.types.importDeclaration(identifiersToImport.map((name) => import_core2.types.importSpecifier(import_core2.types.identifier(name), import_core2.types.identifier(name))), import_core2.types.stringLiteral(source))
              ]);
              if (!existingImports.has(source)) {
                existingImports.set(source, new Set);
              }
              identifiersToImport.forEach((name) => existingImports.get(source).add(name));
            } else {
              exportAllPath.remove();
            }
            collectedExports.forEach((name) => globalIdentifiers.add(name));
          },
          ExportNamedDeclaration(exportPath) {
            const { node } = exportPath;
            if (node.specifiers.length > 0) {
              node.specifiers.forEach((specifier) => {
                if (import_core2.types.isExportSpecifier(specifier) && import_core2.types.isIdentifier(specifier.exported)) {
                  globalIdentifiers.add(specifier.exported.name);
                }
              });
            } else if (node.declaration) {
              const declaration = node.declaration;
              if (import_core2.types.isVariableDeclaration(declaration)) {
                declaration.declarations.forEach((decl) => {
                  if (import_core2.types.isIdentifier(decl.id)) {
                    globalIdentifiers.add(decl.id.name);
                  }
                });
              } else if (import_core2.types.isFunctionDeclaration(declaration) || import_core2.types.isClassDeclaration(declaration)) {
                if (import_core2.types.isIdentifier(declaration.id)) {
                  globalIdentifiers.add(declaration.id.name);
                }
              }
            }
          }
        });
        const identifiersToAssign = Array.from(globalIdentifiers);
        if (identifiersToAssign.length > 0) {
          const gccIdentifier = import_core2.types.identifier(GCC);
          gccIdentifier.typeAnnotation = import_core2.types.tsTypeAnnotation(import_core2.types.tsTypeLiteral(identifiersToAssign.map((name) => import_core2.types.tsPropertySignature(import_core2.types.identifier(name), import_core2.types.tsTypeAnnotation(import_core2.types.tsTypeQuery(import_core2.types.identifier(name)))))));
          const globalDeclaration = import_core2.types.tsModuleDeclaration(import_core2.types.identifier("globalThis"), import_core2.types.tsModuleBlock([
            import_core2.types.variableDeclaration("var", [
              import_core2.types.variableDeclarator(gccIdentifier)
            ])
          ]));
          globalDeclaration.declare = true;
          programPath.unshiftContainer("body", globalDeclaration);
          const gccAssignments = identifiersToAssign.map((name) => import_core2.types.expressionStatement(import_core2.types.assignmentExpression("=", import_core2.types.memberExpression(import_core2.types.memberExpression(import_core2.types.identifier("globalThis"), import_core2.types.identifier(GCC)), import_core2.types.identifier(name)), import_core2.types.identifier(name))));
          programPath.pushContainer("body", gccAssignments);
        }
      }
    }
  };
};

// src/compiler/tsickleCompiler.ts
var import_path4 = __toESM(require("path"));
var import_typescript = __toESM(require("typescript"));

// src/tsickle/index.ts
var ts16 = __toESM(require("typescript"));

// src/tsickle/path.ts
var ts = __toESM(require("typescript"));
function isAbsolute(path3) {
  return ts.isRootedDiskPath(path3);
}
function join(p1, p2) {
  return ts.combinePaths(p1, p2);
}
function dirname(path3) {
  return ts.getDirectoryPath(path3);
}
function relative(base, rel) {
  return ts.convertToRelativePath(rel, base, (p) => p);
}
function normalize(path3) {
  return ts.resolvePath(path3);
}

// src/tsickle/cli_support.ts
function assertAbsolute(fileName) {
  if (!isAbsolute(fileName)) {
    throw new Error(`expected ${JSON.stringify(fileName)} to be absolute`);
  }
}
function pathToModuleName(rootModulePath, context, fileName) {
  fileName = fileName.replace(/(\.d)?\.[tj]s$/, "");
  if (fileName[0] === ".") {
    fileName = join(dirname(context), fileName);
  }
  if (!isAbsolute(fileName))
    fileName = join(rootModulePath, fileName);
  if (rootModulePath) {
    fileName = relative(rootModulePath, fileName);
  }
  const moduleName = fileName.replace(/\/|\\/g, ".").replace(/^[^a-zA-Z_$]/, "_").replace(/[^a-zA-Z0-9._$]/g, "_");
  return moduleName;
}

// src/tsickle/clutz.ts
var ts5 = __toESM(require("typescript"));

// src/tsickle/googmodule.ts
var ts3 = __toESM(require("typescript"));

// src/tsickle/transformer_util.ts
var ts2 = __toESM(require("typescript"));
function hasModifierFlag(declaration, flag) {
  return (ts2.getCombinedModifierFlags(declaration) & flag) !== 0;
}
function isAmbient(node) {
  let current = node;
  while (current) {
    if (hasModifierFlag(current, ts2.ModifierFlags.Ambient)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}
function isDtsFileName(fileName) {
  return fileName.endsWith(".d.ts");
}
function getIdentifierText(identifier) {
  return unescapeName(identifier.escapedText);
}
function symbolIsValue(tc, sym) {
  if (sym.flags & ts2.SymbolFlags.Alias)
    sym = tc.getAliasedSymbol(sym);
  return (sym.flags & ts2.SymbolFlags.Value) !== 0;
}
function getEntityNameText(name) {
  if (ts2.isIdentifier(name)) {
    return getIdentifierText(name);
  }
  return getEntityNameText(name.left) + "." + getIdentifierText(name.right);
}
function unescapeName(name) {
  const str = name;
  if (str.startsWith("___"))
    return str.substring(1);
  return str;
}
function createNotEmittedStatementWithComments(sourceFile, original) {
  let replacement = ts2.factory.createNotEmittedStatement(original);
  const leading = ts2.getLeadingCommentRanges(sourceFile.text, original.pos) || [];
  const trailing = ts2.getTrailingCommentRanges(sourceFile.text, original.end) || [];
  replacement = ts2.setSyntheticLeadingComments(replacement, synthesizeCommentRanges(sourceFile, leading));
  replacement = ts2.setSyntheticTrailingComments(replacement, synthesizeCommentRanges(sourceFile, trailing));
  return replacement;
}
function synthesizeCommentRanges(sourceFile, parsedComments) {
  const synthesizedComments = [];
  parsedComments.forEach(({ end, hasTrailingNewLine, kind, pos }) => {
    let commentText = sourceFile.text.substring(pos, end).trim();
    if (kind === ts2.SyntaxKind.MultiLineCommentTrivia) {
      commentText = commentText.replace(/(^\/\*)|(\*\/$)/g, "");
    } else if (kind === ts2.SyntaxKind.SingleLineCommentTrivia) {
      if (commentText.startsWith("///")) {
        return;
      }
      commentText = commentText.replace(/(^\/\/)/g, "");
    }
    synthesizedComments.push({
      end: -1,
      hasTrailingNewLine,
      kind,
      pos: -1,
      text: commentText
    });
  });
  return synthesizedComments;
}
function visitEachChild2(node, visitor, context) {
  if (node.kind === ts2.SyntaxKind.SourceFile) {
    const sf = node;
    return updateSourceFileNode(sf, ts2.visitLexicalEnvironment(sf.statements, visitor, context));
  }
  return ts2.visitEachChild(node, visitor, context);
}
function updateSourceFileNode(sf, statements) {
  if (statements === sf.statements) {
    return sf;
  }
  sf = ts2.factory.updateSourceFile(sf, ts2.setTextRange(statements, sf.statements), sf.isDeclarationFile, sf.referencedFiles, sf.typeReferenceDirectives, sf.hasNoDefaultLib, sf.libReferenceDirectives);
  return sf;
}
function createSingleQuoteStringLiteral(text) {
  const stringLiteral = ts2.factory.createStringLiteral(text);
  stringLiteral["singleQuote"] = true;
  return stringLiteral;
}
function createSingleLineComment(original, text) {
  const comment = {
    end: -1,
    hasTrailingNewLine: true,
    kind: ts2.SyntaxKind.SingleLineCommentTrivia,
    pos: -1,
    text: " " + text
  };
  return ts2.setSyntheticTrailingComments(ts2.factory.createNotEmittedStatement(original), [comment]);
}
function createMultiLineComment(original, text) {
  const comment = {
    end: -1,
    hasTrailingNewLine: true,
    kind: ts2.SyntaxKind.MultiLineCommentTrivia,
    pos: -1,
    text: " " + text
  };
  return ts2.setSyntheticTrailingComments(ts2.factory.createNotEmittedStatement(original), [comment]);
}
function reportDebugWarning(host, node, messageText) {
  if (!host.logWarning)
    return;
  host.logWarning(createDiagnostic(node, messageText, undefined, ts2.DiagnosticCategory.Warning));
}
function reportDiagnostic(diagnostics, node, messageText, textRange, category = ts2.DiagnosticCategory.Error) {
  diagnostics.push(createDiagnostic(node, messageText, textRange, category));
}
function createDiagnostic(node, messageText, textRange, category) {
  let start;
  let length;
  node = ts2.getOriginalNode(node);
  if (textRange) {
    start = textRange.pos;
    length = textRange.end - textRange.pos;
  } else if (node) {
    start = node.pos >= 0 ? node.getStart() : 0;
    length = node.end - node.pos;
  }
  return {
    category,
    code: 0,
    file: node?.getSourceFile(),
    length,
    messageText,
    start
  };
}
function getAllLeadingComments(node) {
  const allRanges = [];
  const nodeText = node.getFullText();
  const cr = ts2.getLeadingCommentRanges(nodeText, 0);
  if (cr)
    allRanges.push(...cr.map((c) => ({ ...c, text: nodeText.substring(c.pos, c.end) })));
  const synthetic = ts2.getSyntheticLeadingComments(node);
  if (synthetic)
    allRanges.push(...synthetic);
  return allRanges;
}
function createGoogCall(methodName, literal) {
  return ts2.factory.createCallExpression(ts2.factory.createPropertyAccessExpression(ts2.factory.createIdentifier("goog"), methodName), undefined, [literal]);
}
function getGoogFunctionName(call) {
  if (!ts2.isPropertyAccessExpression(call.expression)) {
    return null;
  }
  const propAccess = call.expression;
  if (!ts2.isIdentifier(propAccess.expression) || propAccess.expression.escapedText !== "goog") {
    return null;
  }
  return propAccess.name.text;
}
function isGoogCallExpressionOf(n, fnName) {
  return ts2.isCallExpression(n) && getGoogFunctionName(n) === fnName;
}
function isAnyTsmesCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationExportsShim") || isGoogCallExpressionOf(n, "tsMigrationDefaultExportsShim") || isGoogCallExpressionOf(n, "tsMigrationNamedExportsShim");
}
function isTsmesShorthandCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationDefaultExportsShim") || isGoogCallExpressionOf(n, "tsMigrationNamedExportsShim");
}
function isTsmesDeclareLegacyNamespaceCall(n) {
  return isGoogCallExpressionOf(n, "tsMigrationExportsShimDeclareLegacyNamespace");
}
function createGoogLoadedModulesRegistration(moduleId, exports2) {
  return ts2.factory.createExpressionStatement(ts2.factory.createAssignment(ts2.factory.createElementAccessExpression(ts2.factory.createPropertyAccessExpression(ts2.factory.createIdentifier("goog"), ts2.factory.createIdentifier("loadedModules_")), createSingleQuoteStringLiteral(moduleId)), ts2.factory.createObjectLiteralExpression([
    ts2.factory.createPropertyAssignment("exports", exports2),
    ts2.factory.createPropertyAssignment("type", ts2.factory.createPropertyAccessExpression(ts2.factory.createPropertyAccessExpression(ts2.factory.createIdentifier("goog"), ts2.factory.createIdentifier("ModuleType")), ts2.factory.createIdentifier("GOOG"))),
    ts2.factory.createPropertyAssignment("moduleId", createSingleQuoteStringLiteral(moduleId))
  ])));
}
function isMergedDeclaration(decl) {
  return decl.isMergedDecl === true;
}
function markAsMergedDeclaration(decl) {
  decl.isMergedDecl = true;
}
function getTransformedNs(node) {
  node = ts2.getOriginalNode(node);
  let parent = node.parent;
  while (parent) {
    if (ts2.isModuleDeclaration(parent) && isMergedDeclaration(parent)) {
      return parent;
    }
    parent = parent.parent;
  }
  return null;
}
function nodeIsInTransformedNs(node) {
  return getTransformedNs(node) !== null;
}
function getPreviousDeclaration(sym, thisDecl) {
  if (!sym.declarations)
    return null;
  const sf = thisDecl.getSourceFile();
  for (const decl of sym.declarations) {
    if (!isAmbient(decl) && decl.getSourceFile() === sf && decl.pos < thisDecl.pos) {
      return decl;
    }
  }
  return null;
}

// src/tsickle/googmodule.ts
function jsPathToNamespace(host, context, diagnostics, importPath, getModuleSymbol) {
  const namespace = localJsPathToNamespace(host, context, diagnostics, importPath);
  if (namespace)
    return namespace;
  const moduleSymbol = getModuleSymbol();
  if (!moduleSymbol)
    return;
  return getGoogNamespaceFromClutzComments(context, diagnostics, importPath, moduleSymbol);
}
function localJsPathToNamespace(host, context, diagnostics, importPath) {
  if (importPath.match(/^goog:/)) {
    return importPath.substring("goog:".length);
  }
  if (host.jsPathToModuleName) {
    const module2 = host.jsPathToModuleName(importPath);
    if (!module2)
      return;
    if (module2.multipleProvides) {
      reportMultipleProvidesError(context, diagnostics, importPath);
    }
    return module2.name;
  }
  return;
}
function jsPathToStripProperty(host, importPath, getModuleSymbol) {
  if (host.jsPathToStripProperty) {
    return host.jsPathToStripProperty(importPath);
  }
  const moduleSymbol = getModuleSymbol();
  if (!moduleSymbol)
    return;
  const stripDefaultNameSymbol = findLocalInDeclarations(moduleSymbol, "__clutz_strip_property");
  if (!stripDefaultNameSymbol)
    return;
  return literalTypeOfSymbol(stripDefaultNameSymbol);
}
function isPropertyAccess(node, parent, child) {
  if (!ts3.isPropertyAccessExpression(node))
    return false;
  return ts3.isIdentifier(node.expression) && node.expression.escapedText === parent && node.name.escapedText === child;
}
function isUseStrict(node) {
  if (node.kind !== ts3.SyntaxKind.ExpressionStatement)
    return false;
  const exprStmt = node;
  const expr = exprStmt.expression;
  if (expr.kind !== ts3.SyntaxKind.StringLiteral)
    return false;
  const literal = expr;
  return literal.text === "use strict";
}
function isEsModuleProperty(stmt) {
  const expr = stmt.expression;
  if (!ts3.isCallExpression(expr))
    return false;
  if (!isPropertyAccess(expr.expression, "Object", "defineProperty")) {
    return false;
  }
  if (expr.arguments.length !== 3)
    return false;
  const [exp, esM, val] = expr.arguments;
  if (!ts3.isIdentifier(exp) || exp.escapedText !== "exports")
    return false;
  if (!ts3.isStringLiteral(esM) || esM.text !== "__esModule")
    return false;
  if (!ts3.isObjectLiteralExpression(val) || val.properties.length !== 1) {
    return false;
  }
  const prop = val.properties[0];
  if (!ts3.isPropertyAssignment(prop))
    return false;
  const ident = prop.name;
  if (!ident || !ts3.isIdentifier(ident) || ident.text !== "value")
    return false;
  return prop.initializer.kind === ts3.SyntaxKind.TrueKeyword;
}
function checkExportsVoid0Assignment(expr) {
  if (!ts3.isBinaryExpression(expr))
    return false;
  if (expr.operatorToken.kind !== ts3.SyntaxKind.EqualsToken)
    return false;
  if (!ts3.isPropertyAccessExpression(expr.left))
    return false;
  if (!ts3.isIdentifier(expr.left.expression))
    return false;
  if (expr.left.expression.escapedText !== "exports")
    return false;
  if (ts3.isBinaryExpression(expr.right)) {
    return checkExportsVoid0Assignment(expr.right);
  }
  if (!ts3.isVoidExpression(expr.right))
    return false;
  if (!ts3.isNumericLiteral(expr.right.expression))
    return false;
  if (expr.right.expression.text !== "0")
    return false;
  return true;
}
function extractRequire(call) {
  if (call.expression.kind !== ts3.SyntaxKind.Identifier)
    return null;
  const ident = call.expression;
  if (ident.escapedText !== "require")
    return null;
  if (call.arguments.length !== 1)
    return null;
  const arg = call.arguments[0];
  if (arg.kind !== ts3.SyntaxKind.StringLiteral)
    return null;
  return arg;
}
function findLocalInDeclarations(symbol, name) {
  if (!symbol.declarations) {
    return;
  }
  for (const decl of symbol.declarations) {
    const internalDecl = decl;
    const locals = internalDecl.locals;
    if (!locals)
      continue;
    const sym = locals.get(ts3.escapeLeadingUnderscores(name));
    if (sym)
      return sym;
  }
  return;
}
function literalTypeOfSymbol(symbol) {
  if (!symbol.declarations || symbol.declarations.length === 0) {
    return;
  }
  const varDecl = symbol.declarations[0];
  if (!ts3.isVariableDeclaration(varDecl))
    return;
  if (!varDecl.type || !ts3.isLiteralTypeNode(varDecl.type))
    return;
  const literal = varDecl.type.literal;
  if (ts3.isLiteralExpression(literal))
    return literal.text;
  if (literal.kind === ts3.SyntaxKind.TrueKeyword)
    return true;
  if (literal.kind === ts3.SyntaxKind.FalseKeyword)
    return false;
  return;
}
function getOriginalGoogModuleFromComment(sf) {
  const leadingComments = sf.getFullText().substring(sf.getFullStart(), sf.getLeadingTriviaWidth());
  const match = /^\/\/ Original goog.module name: (.*)$/m.exec(leadingComments);
  if (match) {
    return match[1];
  }
  return;
}
function getGoogNamespaceFromClutzComments(context, tsickleDiagnostics, tsImport, moduleSymbol) {
  if (moduleSymbol.valueDeclaration && ts3.isSourceFile(moduleSymbol.valueDeclaration)) {
    return getOriginalGoogModuleFromComment(moduleSymbol.valueDeclaration);
  }
  const actualNamespaceSymbol = findLocalInDeclarations(moduleSymbol, "__clutz_actual_namespace");
  if (!actualNamespaceSymbol)
    return;
  const hasMultipleProvides = findLocalInDeclarations(moduleSymbol, "__clutz_multiple_provides");
  if (hasMultipleProvides) {
    reportMultipleProvidesError(context, tsickleDiagnostics, tsImport);
  }
  const actualNamespace = literalTypeOfSymbol(actualNamespaceSymbol);
  if (actualNamespace === undefined || typeof actualNamespace !== "string") {
    reportDiagnostic(tsickleDiagnostics, context, `referenced module's __clutz_actual_namespace not a variable with a string literal type`);
    return;
  }
  return actualNamespace;
}
function reportMultipleProvidesError(context, diagnostics, importPath) {
  reportDiagnostic(diagnostics, context, `referenced JavaScript module ${importPath} provides multiple namespaces and cannot be imported by path.`);
}
function importPathToGoogNamespace(host, context, diagnostics, file, tsImport, getModuleSymbol) {
  const nsImport = jsPathToNamespace(host, context, diagnostics, tsImport, getModuleSymbol);
  if (nsImport != null) {
    return nsImport;
  }
  return host.pathToModuleName(file.fileName, tsImport);
}
function rewriteModuleExportsAssignment(expr) {
  if (!ts3.isBinaryExpression(expr.expression))
    return null;
  if (expr.expression.operatorToken.kind !== ts3.SyntaxKind.EqualsToken) {
    return null;
  }
  if (!isPropertyAccess(expr.expression.left, "module", "exports"))
    return null;
  return ts3.setOriginalNode(ts3.setTextRange(ts3.factory.createExpressionStatement(ts3.factory.createAssignment(ts3.factory.createIdentifier("exports"), expr.expression.right)), expr), expr);
}
function rewriteCommaExpressions(expr) {
  const isBinaryCommaExpression = (expr2) => ts3.isBinaryExpression(expr2) && expr2.operatorToken.kind === ts3.SyntaxKind.CommaToken;
  const isCommaList = (expr2) => expr2.kind === ts3.SyntaxKind.CommaListExpression;
  if (!isBinaryCommaExpression(expr) && !isCommaList(expr)) {
    return null;
  }
  return visit(expr);
  function visit(expr2) {
    if (isBinaryCommaExpression(expr2)) {
      return visit(expr2.left).concat(visit(expr2.right));
    }
    if (isCommaList(expr2)) {
      return [].concat(...expr2.elements.map(visit));
    }
    return [
      ts3.setOriginalNode(ts3.factory.createExpressionStatement(expr2), expr2)
    ];
  }
}
function getAmbientModuleSymbol(typeChecker, moduleUrl) {
  let moduleSymbol = typeChecker.getSymbolAtLocation(moduleUrl);
  if (!moduleSymbol) {
    const t3 = moduleUrl.text;
    moduleSymbol = typeChecker.tryFindAmbientModuleWithoutAugmentations(t3);
  }
  return moduleSymbol;
}
function getExportedDeclarations(sourceFile, typeChecker) {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol)
    return [];
  const exportSymbols = typeChecker.getExportsOfModule(moduleSymbol);
  const result = [];
  for (const exportSymbol of exportSymbols) {
    const declarationSymbol = exportSymbol.flags & ts3.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(exportSymbol) : exportSymbol;
    const declarationFile = declarationSymbol.valueDeclaration?.getSourceFile();
    if (declarationFile?.fileName !== sourceFile.fileName)
      continue;
    result.push({
      declarationSymbol,
      exportName: exportSymbol.name
    });
  }
  return result;
}
function isClassDecorated(node) {
  if (hasDecorator(node))
    return true;
  const ctor = getFirstConstructorWithBody(node);
  if (!ctor)
    return false;
  return ctor.parameters.some((p) => hasDecorator(p));
}
function getFirstConstructorWithBody(node) {
  return node.members.find((member) => ts3.isConstructorDeclaration(member) && !!member.body);
}
function hasDecorator(node) {
  const decorators = ts3.getDecorators(node);
  return !!decorators && decorators.length > 0;
}
function commonJsToGoogmoduleTransformer(host, modulesManifest, typeChecker) {
  return (context) => {
    const previousOnSubstituteNode = context.onSubstituteNode;
    context.enableSubstitution(ts3.SyntaxKind.PropertyAccessExpression);
    context.onSubstituteNode = (hint, node) => {
      node = previousOnSubstituteNode(hint, node);
      if (!ts3.isPropertyAccessExpression(node))
        return node;
      if (!ts3.isIdentifier(node.expression))
        return node;
      const orig = ts3.getOriginalNode(node.expression);
      let importExportDecl;
      if (ts3.isImportDeclaration(orig) || ts3.isExportDeclaration(orig)) {
        importExportDecl = orig;
      } else {
        const sym = typeChecker.getSymbolAtLocation(node.expression);
        if (!sym)
          return node;
        const decls = sym.getDeclarations();
        if (!decls || !decls.length)
          return node;
        const decl = decls[0];
        if (decl.parent && decl.parent.parent && ts3.isImportDeclaration(decl.parent.parent)) {
          importExportDecl = decl.parent.parent;
        } else {
          return node;
        }
      }
      if (!importExportDecl.moduleSpecifier)
        return node;
      const isDefaultAccess = node.name.text === "default";
      const moduleSpecifier = importExportDecl.moduleSpecifier;
      if (isDefaultAccess && moduleSpecifier.text.startsWith("goog:")) {
        return node.expression;
      }
      const stripPropertyName = jsPathToStripProperty(host, moduleSpecifier.text, () => getAmbientModuleSymbol(typeChecker, moduleSpecifier));
      if (!stripPropertyName)
        return node;
      if (stripPropertyName === node.name.text)
        return node.expression;
      return node;
    };
    return (sf) => {
      if (sf["kind"] !== ts3.SyntaxKind.SourceFile)
        return sf;
      const exportedDeclarations = getExportedDeclarations(sf, typeChecker);
      let moduleVarCounter = 1;
      function nextModuleVar() {
        return `tsickle_module_${moduleVarCounter++}_`;
      }
      const namespaceToModuleVarName = new Map;
      function maybeCreateGoogRequire(original, call, newIdent) {
        const importedUrl = extractRequire(call);
        if (!importedUrl)
          return null;
        const ignoredDiagnostics = [];
        const imp = importPathToGoogNamespace(host, importedUrl, ignoredDiagnostics, sf, importedUrl.text, () => getAmbientModuleSymbol(typeChecker, importedUrl));
        modulesManifest.addReferencedModule(sf.fileName, imp);
        const existingImport = namespaceToModuleVarName.get(imp);
        let initializer;
        if (!existingImport) {
          if (newIdent)
            namespaceToModuleVarName.set(imp, newIdent);
          initializer = createGoogCall("require", createSingleQuoteStringLiteral(imp));
        } else {
          initializer = existingImport;
        }
        if (newIdent && newIdent.escapedText === "goog" && imp === "google3.javascript.closure.goog") {
          return createNotEmittedStatementWithComments(sf, original);
        }
        const useConst = host.options.target !== ts3.ScriptTarget.ES5;
        if (newIdent) {
          const varDecl = ts3.factory.createVariableDeclaration(newIdent, undefined, undefined, initializer);
          const newStmt = ts3.factory.createVariableStatement(undefined, ts3.factory.createVariableDeclarationList([varDecl], useConst ? ts3.NodeFlags.Const : undefined));
          return ts3.setOriginalNode(ts3.setTextRange(newStmt, original), original);
        } else if (!newIdent && !existingImport) {
          const newStmt = ts3.factory.createExpressionStatement(initializer);
          return ts3.setOriginalNode(ts3.setTextRange(newStmt, original), original);
        }
        return createNotEmittedStatementWithComments(sf, original);
      }
      function maybeRewriteDeclareModuleId(original, call) {
        if (!ts3.isPropertyAccessExpression(call.expression)) {
          return null;
        }
        const propAccess = call.expression;
        if (propAccess.name.escapedText !== "declareModuleId") {
          return null;
        }
        if (!ts3.isIdentifier(propAccess.expression) || propAccess.expression.escapedText !== "goog") {
          return null;
        }
        if (call.arguments.length !== 1) {
          return null;
        }
        const arg = call.arguments[0];
        if (!ts3.isStringLiteral(arg)) {
          return null;
        }
        const newStmt = createGoogLoadedModulesRegistration(arg.text, ts3.factory.createIdentifier("exports"));
        return ts3.setOriginalNode(ts3.setTextRange(newStmt, original), original);
      }
      function maybeRewriteDecoratedClassChainInitializer(stmt, decl) {
        const originalNode = ts3.getOriginalNode(stmt);
        if (!originalNode || !ts3.isClassDeclaration(originalNode) || !isClassDecorated(originalNode)) {
          return null;
        }
        if (!ts3.isIdentifier(decl.name) || !decl.initializer || !ts3.isBinaryExpression(decl.initializer) || decl.initializer.operatorToken.kind !== ts3.SyntaxKind.EqualsToken || !ts3.isPropertyAccessExpression(decl.initializer.left) || !ts3.isIdentifier(decl.initializer.left.expression) || decl.initializer.left.expression.text !== "exports") {
          return null;
        }
        const updatedDecl = ts3.factory.updateVariableDeclaration(decl, decl.name, decl.exclamationToken, decl.type, decl.initializer.right);
        const newStmt = ts3.factory.updateVariableStatement(stmt, stmt.modifiers, ts3.factory.updateVariableDeclarationList(stmt.declarationList, [
          updatedDecl
        ]));
        return {
          exports: [
            ts3.factory.createExpressionStatement(ts3.factory.createAssignment(decl.initializer.left, decl.name))
          ],
          statement: newStmt
        };
      }
      function isExportsAssignmentForDecoratedClass(stmt) {
        if (!ts3.isBinaryExpression(stmt.expression) || stmt.expression.operatorToken.kind !== ts3.SyntaxKind.EqualsToken || !ts3.isPropertyAccessExpression(stmt.expression.left) || !ts3.isIdentifier(stmt.expression.left.expression) || stmt.expression.left.expression.escapedText !== "exports" || !ts3.isIdentifier(stmt.expression.right)) {
          return false;
        }
        if (ts3.isVariableStatement(ts3.getOriginalNode(stmt)))
          return false;
        const nameSymbol = typeChecker.getSymbolAtLocation(stmt.expression.right);
        if (!nameSymbol || !nameSymbol.valueDeclaration)
          return false;
        return ts3.isClassDeclaration(nameSymbol.valueDeclaration) && isClassDecorated(nameSymbol.valueDeclaration);
      }
      function maybeRewriteDecoratedClassDecorateCall(stmt) {
        if (!ts3.isBinaryExpression(stmt.expression) || stmt.expression.operatorToken.kind !== ts3.SyntaxKind.EqualsToken || !ts3.isIdentifier(stmt.expression.left)) {
          return null;
        }
        const originalNode = ts3.getOriginalNode(stmt);
        if (!ts3.isClassDeclaration(originalNode) || !isClassDecorated(originalNode)) {
          return null;
        }
        ts3.setEmitFlags(stmt.expression, ts3.EmitFlags.NoSubstitution);
        return stmt;
      }
      function maybeRewriteExportsAssignmentInIifeArguments(stmt) {
        if (!ts3.isCallExpression(stmt.expression))
          return null;
        const call = stmt.expression;
        if (!ts3.isParenthesizedExpression(call.expression) || !ts3.isFunctionExpression(call.expression.expression) || call.arguments.length !== 1) {
          return null;
        }
        const arg = call.arguments[0];
        if (!ts3.isBinaryExpression(arg) || !ts3.isIdentifier(arg.left) || arg.operatorToken.kind !== ts3.SyntaxKind.BarBarToken || !ts3.isParenthesizedExpression(arg.right) || !ts3.isBinaryExpression(arg.right.expression) || arg.right.expression.operatorToken.kind !== ts3.SyntaxKind.EqualsToken || !ts3.isIdentifier(arg.right.expression.left) || !ts3.isObjectLiteralExpression(arg.right.expression.right)) {
          return null;
        }
        const name = arg.right.expression.left;
        const nameSymbol = typeChecker.getSymbolAtLocation(name);
        const matchingExports = exportedDeclarations.filter((decl) => decl.declarationSymbol === nameSymbol);
        if (matchingExports.length === 0)
          return null;
        ts3.setEmitFlags(arg.right.expression, ts3.EmitFlags.NoSubstitution);
        const notAlreadyExported = matchingExports.filter((decl) => !ts3.isClassDeclaration(decl.declarationSymbol.valueDeclaration) && !ts3.isFunctionDeclaration(decl.declarationSymbol.valueDeclaration) && !(host.transformTypesToClosure && ts3.isEnumDeclaration(decl.declarationSymbol.valueDeclaration)));
        const exportNames = notAlreadyExported.map((decl) => decl.exportName);
        return {
          exports: exportNames.map((exportName) => ts3.factory.createExpressionStatement(ts3.factory.createAssignment(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("exports"), ts3.factory.createIdentifier(exportName)), name))),
          statement: stmt
        };
      }
      function maybeRewriteExportStarAsNs(stmt) {
        if (!ts3.isExpressionStatement(stmt))
          return null;
        if (!ts3.isBinaryExpression(stmt.expression))
          return null;
        if (stmt.expression.operatorToken.kind !== ts3.SyntaxKind.EqualsToken) {
          return null;
        }
        if (!ts3.isPropertyAccessExpression(stmt.expression.left))
          return null;
        if (!ts3.isIdentifier(stmt.expression.left.expression))
          return null;
        if (stmt.expression.left.expression.escapedText !== "exports") {
          return null;
        }
        if (!ts3.isCallExpression(stmt.expression.right))
          return null;
        const ident = ts3.factory.createIdentifier(nextModuleVar());
        const require2 = maybeCreateGoogRequire(stmt, stmt.expression.right, ident);
        if (!require2)
          return null;
        const exportedName = stmt.expression.left.name;
        const exportStmt = ts3.setOriginalNode(ts3.setTextRange(ts3.factory.createExpressionStatement(ts3.factory.createAssignment(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("exports"), exportedName), ident)), stmt), stmt);
        ts3.addSyntheticLeadingComment(exportStmt, ts3.SyntaxKind.MultiLineCommentTrivia, "* @const ", true);
        return [require2, exportStmt];
      }
      function rewriteObjectDefinePropertyOnExports(stmt) {
        if (!ts3.isCallExpression(stmt.expression))
          return null;
        const callExpr = stmt.expression;
        if (!ts3.isPropertyAccessExpression(callExpr.expression))
          return null;
        const propAccess = callExpr.expression;
        if (!ts3.isIdentifier(propAccess.expression))
          return null;
        if (propAccess.expression.text !== "Object")
          return null;
        if (propAccess.name.text !== "defineProperty")
          return null;
        if (callExpr.arguments.length !== 3)
          return null;
        const [objDefArg1, objDefArg2, objDefArg3] = callExpr.arguments;
        if (!ts3.isIdentifier(objDefArg1))
          return null;
        if (objDefArg1.text !== "exports")
          return null;
        if (!ts3.isStringLiteral(objDefArg2))
          return null;
        if (!ts3.isObjectLiteralExpression(objDefArg3))
          return null;
        function findPropNamed(name) {
          return (p) => {
            return ts3.isPropertyAssignment(p) && ts3.isIdentifier(p.name) && p.name.text === name;
          };
        }
        const enumerableConfig = objDefArg3.properties.find(findPropNamed("enumerable"));
        if (!enumerableConfig)
          return null;
        if (!ts3.isPropertyAssignment(enumerableConfig))
          return null;
        if (enumerableConfig.initializer.kind !== ts3.SyntaxKind.TrueKeyword) {
          return null;
        }
        const getConfig = objDefArg3.properties.find(findPropNamed("get"));
        if (!getConfig)
          return null;
        if (!ts3.isPropertyAssignment(getConfig))
          return null;
        if (!ts3.isFunctionExpression(getConfig.initializer))
          return null;
        const getterFunc = getConfig.initializer;
        if (getterFunc.body.statements.length !== 1)
          return null;
        const getterReturn = getterFunc.body.statements[0];
        if (!ts3.isReturnStatement(getterReturn))
          return null;
        const realExportValue = getterReturn.expression;
        if (!realExportValue)
          return null;
        const exportStmt = ts3.setOriginalNode(ts3.setTextRange(ts3.factory.createExpressionStatement(ts3.factory.createAssignment(ts3.factory.createPropertyAccessExpression(ts3.factory.createIdentifier("exports"), objDefArg2.text), realExportValue)), stmt), stmt);
        return exportStmt;
      }
      const seenNamespaceOrEnumExports = new Set;
      const delayedDecoratedClassExports = new Map;
      function visitTopLevelStatement(stmts2, sf2, node) {
        switch (node.kind) {
          case ts3.SyntaxKind.ExpressionStatement: {
            const exprStmt = node;
            if (isUseStrict(exprStmt) || isEsModuleProperty(exprStmt)) {
              stmts2.push(createNotEmittedStatementWithComments(sf2, exprStmt));
              return;
            }
            if (checkExportsVoid0Assignment(exprStmt.expression)) {
              stmts2.push(createNotEmittedStatementWithComments(sf2, exprStmt));
              return;
            }
            const modExports = rewriteModuleExportsAssignment(exprStmt);
            if (modExports) {
              stmts2.push(modExports);
              return;
            }
            const commaExpanded = rewriteCommaExpressions(exprStmt.expression);
            if (commaExpanded) {
              stmts2.push(...commaExpanded);
              return;
            }
            const exportStarAsNs = maybeRewriteExportStarAsNs(exprStmt);
            if (exportStarAsNs) {
              stmts2.push(...exportStarAsNs);
              return;
            }
            const exportFromObjDefProp = rewriteObjectDefinePropertyOnExports(exprStmt);
            if (exportFromObjDefProp) {
              stmts2.push(exportFromObjDefProp);
              return;
            }
            const exportInIifeArguments = maybeRewriteExportsAssignmentInIifeArguments(exprStmt);
            if (exportInIifeArguments) {
              stmts2.push(exportInIifeArguments.statement);
              for (const newExport of exportInIifeArguments.exports) {
                const exportName = newExport.expression.left.name.text;
                if (!seenNamespaceOrEnumExports.has(exportName)) {
                  stmts2.push(newExport);
                  seenNamespaceOrEnumExports.add(exportName);
                }
              }
              return;
            }
            if (isExportsAssignmentForDecoratedClass(exprStmt)) {
              delayedDecoratedClassExports.set(exprStmt.expression.left.name.text, exprStmt);
              return;
            }
            const newStmt = maybeRewriteDecoratedClassDecorateCall(exprStmt);
            if (newStmt) {
              stmts2.push(newStmt);
              return;
            }
            const expr = exprStmt.expression;
            if (!ts3.isCallExpression(expr))
              break;
            let callExpr = expr;
            const declaredModuleId = maybeRewriteDeclareModuleId(exprStmt, callExpr);
            if (declaredModuleId) {
              stmts2.push(declaredModuleId);
              return;
            }
            const isExportStar = ts3.isIdentifier(expr.expression) && (expr.expression.text === "__exportStar" || expr.expression.text === "__export");
            let newIdent;
            if (isExportStar) {
              callExpr = expr.arguments[0];
              newIdent = ts3.factory.createIdentifier(nextModuleVar());
            }
            const require2 = maybeCreateGoogRequire(exprStmt, callExpr, newIdent);
            if (!require2)
              break;
            stmts2.push(require2);
            if (isExportStar) {
              const args = [newIdent];
              if (expr.arguments.length > 1)
                args.push(expr.arguments[1]);
              stmts2.push(ts3.factory.createExpressionStatement(ts3.factory.createCallExpression(expr.expression, undefined, args)));
            }
            return;
          }
          case ts3.SyntaxKind.VariableStatement: {
            const varStmt = node;
            if (varStmt.declarationList.declarations.length !== 1)
              break;
            const decl = varStmt.declarationList.declarations[0];
            if (decl.name.kind !== ts3.SyntaxKind.Identifier)
              break;
            if (decl.initializer && ts3.isCallExpression(decl.initializer)) {
              const require2 = maybeCreateGoogRequire(varStmt, decl.initializer, decl.name);
              if (require2) {
                stmts2.push(require2);
                return;
              }
            }
            const declWithChainInitializer = maybeRewriteDecoratedClassChainInitializer(varStmt, decl);
            if (declWithChainInitializer) {
              stmts2.push(declWithChainInitializer.statement);
              for (const newExport of declWithChainInitializer.exports) {
                delayedDecoratedClassExports.set(newExport.expression.left.name.text, newExport);
              }
              return;
            }
            break;
          }
          default:
            break;
        }
        stmts2.push(node);
      }
      const moduleName = host.pathToModuleName("", sf.fileName);
      modulesManifest.addModule(sf.fileName, moduleName);
      function rewriteDynamicRequire(node) {
        if (!ts3.isCallExpression(node) || node.arguments.length !== 1) {
          return null;
        }
        let importedUrl = null;
        if (ts3.isArrowFunction(node.arguments[0]) && ts3.isCallExpression(node.arguments[0].body)) {
          importedUrl = extractRequire(node.arguments[0].body);
        }
        if (ts3.isFunctionExpression(node.arguments[0]) && ts3.isBlock(node.arguments[0].body) && node.arguments[0].body.statements.length === 1 && ts3.isReturnStatement(node.arguments[0].body.statements[0]) && node.arguments[0].body.statements[0].expression != null && ts3.isCallExpression(node.arguments[0].body.statements[0].expression)) {
          importedUrl = extractRequire(node.arguments[0].body.statements[0].expression);
        }
        if (!importedUrl) {
          return null;
        }
        const callee = node.expression;
        if (!ts3.isPropertyAccessExpression(callee) || callee.name.escapedText !== "then" || !ts3.isCallExpression(callee.expression)) {
          return null;
        }
        const resolveCall = callee.expression;
        if (resolveCall.arguments.length !== 0 || !ts3.isPropertyAccessExpression(resolveCall.expression) || !ts3.isIdentifier(resolveCall.expression.expression) || resolveCall.expression.expression.escapedText !== "Promise" || !ts3.isIdentifier(resolveCall.expression.name) || resolveCall.expression.name.escapedText !== "resolve") {
          return null;
        }
        const ignoredDiagnostics = [];
        const imp = importPathToGoogNamespace(host, importedUrl, ignoredDiagnostics, sf, importedUrl.text, () => getAmbientModuleSymbol(typeChecker, importedUrl));
        modulesManifest.addReferencedModule(sf.fileName, imp);
        return createGoogCall("requireDynamic", createSingleQuoteStringLiteral(imp));
      }
      const visitForDynamicImport = (node) => {
        const replacementNode = rewriteDynamicRequire(node);
        if (replacementNode) {
          return replacementNode;
        }
        return ts3.visitEachChild(node, visitForDynamicImport, context);
      };
      if (host.transformDynamicImport === "closure") {
        sf = ts3.visitNode(sf, visitForDynamicImport, ts3.isSourceFile);
      }
      const stmts = [];
      for (const stmt of sf.statements) {
        visitTopLevelStatement(stmts, sf, stmt);
      }
      stmts.push(...delayedDecoratedClassExports.values());
      const headerStmts = [];
      const googModule = ts3.factory.createExpressionStatement(createGoogCall("module", createSingleQuoteStringLiteral(moduleName)));
      headerStmts.push(googModule);
      maybeAddModuleId(host, typeChecker, sf, headerStmts);
      const resolvedModuleNames = [...namespaceToModuleVarName.keys()];
      const tslibModuleName = host.pathToModuleName(sf.fileName, "tslib");
      if (resolvedModuleNames.indexOf(tslibModuleName) === -1) {
        const tslibImport = ts3.factory.createExpressionStatement(createGoogCall("require", createSingleQuoteStringLiteral(tslibModuleName)));
        headerStmts.push(tslibImport);
      }
      const insertionIdx = stmts.findIndex((s) => s.kind !== ts3.SyntaxKind.NotEmittedStatement);
      if (insertionIdx === -1) {
        stmts.push(...headerStmts);
      } else {
        stmts.splice(insertionIdx, 0, ...headerStmts);
      }
      return ts3.factory.updateSourceFile(sf, ts3.setTextRange(ts3.factory.createNodeArray(stmts), sf.statements));
    };
  };
}
function maybeAddModuleId(host, typeChecker, sourceFile, headerStmts) {
  const moduleSymbol = typeChecker.getSymbolsInScope(sourceFile, ts3.SymbolFlags.ModuleMember).find((s) => s.name === "module");
  if (moduleSymbol) {
    const declaration = moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];
    if (sourceFile.fileName === declaration?.getSourceFile().fileName)
      return;
  }
  const moduleId = host.fileNameToModuleId(sourceFile.fileName);
  const moduleVarInitializer = ts3.factory.createBinaryExpression(ts3.factory.createIdentifier("module"), ts3.SyntaxKind.BarBarToken, ts3.factory.createObjectLiteralExpression([
    ts3.factory.createPropertyAssignment("id", createSingleQuoteStringLiteral(moduleId))
  ]));
  const modAssign = ts3.factory.createVariableStatement(undefined, ts3.factory.createVariableDeclarationList([
    ts3.factory.createVariableDeclaration("module", undefined, undefined, moduleVarInitializer)
  ]));
  headerStmts.push(modAssign);
}

// src/tsickle/type_translator.ts
var ts4 = __toESM(require("typescript"));

// src/tsickle/annotator_host.ts
function moduleNameAsIdentifier(host, fileName, context = "") {
  return host.pathToModuleName(context, fileName).replace(/\./g, "$");
}

// src/tsickle/type_translator.ts
function isValidClosurePropertyName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}
function isDeclaredInBuiltinLibDTS(node) {
  const fileName = node?.getSourceFile().fileName;
  return !!fileName && fileName.match(/\blib\.(?:[^/]+\.)?d\.ts$/) != null;
}
function isDeclaredInClutzDts(node) {
  const sourceFile = node?.getSourceFile();
  if (!sourceFile)
    return false;
  const clutz1Header = "//!! generated by clutz.";
  const clutz2Header = "//!! generated by clutz2";
  return sourceFile.text.startsWith(clutz1Header) || sourceFile.text.startsWith(clutz2Header);
}
function typeValueConflictHandled(symbol) {
  return symbol.declarations != null && symbol.declarations.some((n) => isDeclaredInBuiltinLibDTS(n) || isDeclaredInClutzDts(n));
}
function typeToDebugString(type) {
  let debugString = `flags:0x${type.flags.toString(16)}`;
  if (type.aliasSymbol) {
    debugString += ` alias:${symbolToDebugString(type.aliasSymbol)}`;
  }
  if (type.aliasTypeArguments) {
    debugString += ` aliasArgs:<${type.aliasTypeArguments.map(typeToDebugString).join(",")}>`;
  }
  const basicTypes = [
    ts4.TypeFlags.Any,
    ts4.TypeFlags.String,
    ts4.TypeFlags.Number,
    ts4.TypeFlags.Boolean,
    ts4.TypeFlags.Enum,
    ts4.TypeFlags.StringLiteral,
    ts4.TypeFlags.NumberLiteral,
    ts4.TypeFlags.BooleanLiteral,
    ts4.TypeFlags.EnumLiteral,
    ts4.TypeFlags.BigIntLiteral,
    ts4.TypeFlags.ESSymbol,
    ts4.TypeFlags.UniqueESSymbol,
    ts4.TypeFlags.Void,
    ts4.TypeFlags.Undefined,
    ts4.TypeFlags.Null,
    ts4.TypeFlags.Never,
    ts4.TypeFlags.TypeParameter,
    ts4.TypeFlags.Object,
    ts4.TypeFlags.Union,
    ts4.TypeFlags.Intersection,
    ts4.TypeFlags.Index,
    ts4.TypeFlags.IndexedAccess,
    ts4.TypeFlags.Conditional,
    ts4.TypeFlags.Substitution
  ];
  for (const flag of basicTypes) {
    if ((type.flags & flag) !== 0) {
      debugString += ` ${ts4.TypeFlags[flag]}`;
    }
  }
  if (type.flags === ts4.TypeFlags.Object) {
    const objType = type;
    debugString += ` objectFlags:0x${objType.objectFlags.toString(16)}`;
    const objectFlags = [
      ts4.ObjectFlags.Class,
      ts4.ObjectFlags.Interface,
      ts4.ObjectFlags.Reference,
      ts4.ObjectFlags.Tuple,
      ts4.ObjectFlags.Anonymous,
      ts4.ObjectFlags.Mapped,
      ts4.ObjectFlags.Instantiated,
      ts4.ObjectFlags.ObjectLiteral,
      ts4.ObjectFlags.EvolvingArray,
      ts4.ObjectFlags.ObjectLiteralPatternWithComputedProperties
    ];
    for (const flag of objectFlags) {
      if ((objType.objectFlags & flag) !== 0) {
        debugString += ` object:${ts4.ObjectFlags[flag]}`;
      }
    }
  }
  if (type.symbol && type.symbol.name !== "__type") {
    debugString += ` symbol.name:${JSON.stringify(type.symbol.name)}`;
  }
  if (type.pattern) {
    debugString += ` destructuring:true`;
  }
  return `{type ${debugString}}`;
}
function symbolToDebugString(sym) {
  let debugString = `${JSON.stringify(sym.name)} flags:0x${sym.flags.toString(16)}`;
  const symbolFlags = [
    ts4.SymbolFlags.FunctionScopedVariable,
    ts4.SymbolFlags.BlockScopedVariable,
    ts4.SymbolFlags.Property,
    ts4.SymbolFlags.EnumMember,
    ts4.SymbolFlags.Function,
    ts4.SymbolFlags.Class,
    ts4.SymbolFlags.Interface,
    ts4.SymbolFlags.ConstEnum,
    ts4.SymbolFlags.RegularEnum,
    ts4.SymbolFlags.ValueModule,
    ts4.SymbolFlags.NamespaceModule,
    ts4.SymbolFlags.TypeLiteral,
    ts4.SymbolFlags.ObjectLiteral,
    ts4.SymbolFlags.Method,
    ts4.SymbolFlags.Constructor,
    ts4.SymbolFlags.GetAccessor,
    ts4.SymbolFlags.SetAccessor,
    ts4.SymbolFlags.Signature,
    ts4.SymbolFlags.TypeParameter,
    ts4.SymbolFlags.TypeAlias,
    ts4.SymbolFlags.ExportValue,
    ts4.SymbolFlags.Alias,
    ts4.SymbolFlags.Prototype,
    ts4.SymbolFlags.ExportStar,
    ts4.SymbolFlags.Optional,
    ts4.SymbolFlags.Transient
  ];
  for (const flag of symbolFlags) {
    if ((sym.flags & flag) !== 0) {
      debugString += ` ${ts4.SymbolFlags[flag]}`;
    }
  }
  return debugString;
}
function getContainingAmbientModuleDeclaration(declarations) {
  for (const declaration of declarations) {
    let parent = declaration.parent;
    while (parent) {
      if (ts4.isModuleDeclaration(parent) && ts4.isStringLiteral(parent.name)) {
        return parent;
      }
      parent = parent.parent;
    }
  }
  return null;
}
function isTopLevelExternal(declarations) {
  for (const declaration of declarations) {
    if (declaration.parent === undefined)
      continue;
    if (ts4.isSourceFile(declaration.parent) && ts4.isExternalModule(declaration.parent)) {
      return true;
    }
  }
  return false;
}
function isDeclaredInSameFile(a, b) {
  return ts4.getOriginalNode(a).getSourceFile() === ts4.getOriginalNode(b).getSourceFile();
}

class TypeTranslator {
  host;
  typeChecker;
  node;
  pathUnknownSymbolsSet;
  symbolsToAliasedNames;
  symbolToNameCache;
  ensureSymbolDeclared;
  seenTypes = [];
  dropFinalTypeArgument = false;
  isForExterns = false;
  useInternalNamespaceForExterns = false;
  constructor(host, typeChecker, node, pathUnknownSymbolsSet, symbolsToAliasedNames, symbolToNameCache, ensureSymbolDeclared = () => {}) {
    this.host = host;
    this.typeChecker = typeChecker;
    this.node = node;
    this.pathUnknownSymbolsSet = pathUnknownSymbolsSet;
    this.symbolsToAliasedNames = symbolsToAliasedNames;
    this.symbolToNameCache = symbolToNameCache;
    this.ensureSymbolDeclared = ensureSymbolDeclared;
    this.pathUnknownSymbolsSet = new Set(Array.from(this.pathUnknownSymbolsSet.values()).map((p) => normalize(p)));
  }
  convertParams(sig, paramDecls) {
    const paramTypes = [];
    for (let i = 0;i < sig.parameters.length; i++) {
      const param = sig.parameters[i];
      const paramDecl = paramDecls[i];
      const optional = !!paramDecl.questionToken || !!paramDecl.initializer;
      const varArgs = !!paramDecl.dotDotDotToken;
      const paramType = this.typeChecker.getTypeOfSymbolAtLocation(param, this.node);
      let typeStr;
      if (varArgs) {
        const argType = restParameterType(this.typeChecker, paramType);
        if (argType) {
          typeStr = "..." + this.translate(argType);
        } else {
          this.warn("unable to translate rest args type");
          typeStr = "...?";
        }
      } else {
        typeStr = this.translate(paramType);
      }
      if (optional)
        typeStr = typeStr + "=";
      paramTypes.push(typeStr);
    }
    return paramTypes;
  }
  signatureToClosure(sig) {
    if (!sig.declaration) {
      this.warn("signature without declaration");
      return "Function";
    }
    if (sig.declaration.kind === ts4.SyntaxKind.JSDocSignature) {
      this.warn("signature with JSDoc declaration");
      return "Function";
    }
    this.markTypeParameterAsUnknown(this.symbolsToAliasedNames, sig.declaration.typeParameters);
    let typeStr = `function(`;
    let paramDecls = sig.declaration.parameters || [];
    const maybeThisParam = paramDecls[0];
    if (maybeThisParam && maybeThisParam.name.getText() === "this") {
      if (maybeThisParam.type) {
        const thisType = this.typeChecker.getTypeAtLocation(maybeThisParam.type);
        typeStr += `this: (${this.translate(thisType)})`;
        if (paramDecls.length > 1)
          typeStr += ", ";
      } else {
        this.warn("this type without type");
      }
      paramDecls = paramDecls.slice(1);
    }
    const params = this.convertParams(sig, paramDecls);
    typeStr += `${params.join(", ")})`;
    const retType = this.translate(this.typeChecker.getReturnTypeOfSignature(sig));
    if (retType) {
      typeStr += `: ${retType}`;
    }
    return typeStr;
  }
  stripClutzNamespace(name) {
    if (name.startsWith("ಠ_ಠ.clutz."))
      return name.substring("ಠ_ಠ.clutz.".length);
    return name;
  }
  translateAnonymousType(type) {
    this.seenTypes.push(type);
    try {
      if (!type.symbol) {
        this.warn("anonymous type has no symbol");
        return "?";
      }
      if (type.symbol.flags & ts4.SymbolFlags.Function || type.symbol.flags & ts4.SymbolFlags.Method) {
        const sigs = this.typeChecker.getSignaturesOfType(type, ts4.SignatureKind.Call);
        if (sigs.length === 1) {
          return this.signatureToClosure(sigs[0]);
        }
        const declWithBody = type.symbol.declarations?.filter((d) => isFunctionLikeDeclaration(d) && d.body != null);
        if (declWithBody?.length === 1) {
          const sig = this.typeChecker.getSignatureFromDeclaration(declWithBody[0]);
          if (sig) {
            return this.signatureToClosure(sig);
          }
        }
        this.warn("unhandled anonymous type with multiple call signatures");
        return "?";
      }
      let callable = false;
      let indexable = false;
      const fields = [];
      if (!type.symbol.members) {
        this.warn("anonymous type has no symbol");
        return "?";
      }
      const ctors = type.getConstructSignatures();
      if (ctors.length) {
        const decl = ctors[0].declaration;
        if (!decl) {
          this.warn("unhandled anonymous type with constructor signature but no declaration");
          return "?";
        }
        if (decl.kind === ts4.SyntaxKind.JSDocSignature) {
          this.warn("unhandled JSDoc based constructor signature");
          return "?";
        }
        this.markTypeParameterAsUnknown(this.symbolsToAliasedNames, decl.typeParameters);
        const params = this.convertParams(ctors[0], decl.parameters);
        const paramsStr = params.length ? ", " + params.join(", ") : "";
        const constructedType = this.translate(ctors[0].getReturnType());
        let constructedTypeStr = constructedType[0] === "!" ? constructedType.substring(1) : constructedType;
        if (constructedTypeStr === "*") {
          constructedTypeStr = "?";
        }
        return `function(new:${constructedTypeStr}${paramsStr})`;
      }
      for (const field of type.symbol.members.keys()) {
        const fieldName = ts4.unescapeLeadingUnderscores(field);
        switch (field) {
          case ts4.InternalSymbolName.Call:
            callable = true;
            break;
          case ts4.InternalSymbolName.Index:
            indexable = true;
            break;
          default:
            if (!isValidClosurePropertyName(fieldName)) {
              this.warn(`omitting inexpressible property name: ${field}`);
              continue;
            }
            const member = type.symbol.members.get(field);
            const memberType = this.translate(this.typeChecker.getTypeOfSymbolAtLocation(member, this.node));
            fields.push(`${fieldName}: ${memberType}`);
            break;
        }
      }
      if (fields.length === 0) {
        if (callable && !indexable) {
          const sigs = this.typeChecker.getSignaturesOfType(type, ts4.SignatureKind.Call);
          if (sigs.length === 1) {
            return this.signatureToClosure(sigs[0]);
          }
        } else if (indexable && !callable) {
          let keyType = "string";
          let valType = this.typeChecker.getIndexTypeOfType(type, ts4.IndexKind.String);
          if (!valType) {
            keyType = "number";
            valType = this.typeChecker.getIndexTypeOfType(type, ts4.IndexKind.Number);
          }
          if (!valType) {
            this.warn("unknown index key type");
            return `!Object<?,?>`;
          }
          return `!Object<${keyType},${this.translate(valType)}>`;
        } else if (!callable && !indexable) {
          return "*";
        }
      }
      if (!callable && !indexable) {
        return `{${fields.join(", ")}}`;
      }
      this.warn("unhandled anonymous type");
      return "?";
    } finally {
      this.seenTypes.pop();
    }
  }
  translateEnumLiteral(type) {
    const enumLiteralBaseType = this.typeChecker.getBaseTypeOfLiteralType(type);
    if (!enumLiteralBaseType.symbol) {
      this.warn(`EnumLiteralType without a symbol`);
      return "?";
    }
    let symbol = enumLiteralBaseType.symbol;
    if (enumLiteralBaseType === type) {
      const parent = symbol["parent"];
      if (!parent)
        return "?";
      symbol = parent;
    }
    const name = this.symbolToString(symbol);
    if (!name)
      return "?";
    return "!" + name;
  }
  translateObject(type) {
    if (type.symbol && this.isAlwaysUnknownSymbol(type.symbol))
      return "?";
    if (type.objectFlags & ts4.ObjectFlags.Class) {
      if (!type.symbol) {
        this.warn("class has no symbol");
        return "?";
      }
      const name = this.symbolToString(type.symbol);
      if (!name) {
        return "?";
      }
      return "!" + name;
    } else if (type.objectFlags & ts4.ObjectFlags.Interface) {
      if (!type.symbol) {
        this.warn("interface has no symbol");
        return "?";
      }
      if (type.symbol.flags & ts4.SymbolFlags.Value) {
        if (!typeValueConflictHandled(type.symbol)) {
          this.warn(`type/symbol conflict for ${type.symbol.name}, using {?} for now`);
          return "?";
        }
      }
      return "!" + this.symbolToString(type.symbol);
    } else if (type.objectFlags & ts4.ObjectFlags.Reference) {
      const referenceType = type;
      if (referenceType.target.objectFlags & ts4.ObjectFlags.Tuple) {
        return "!Array<?>";
      }
      let typeStr = "";
      if (referenceType.target === referenceType) {
        throw new Error(`reference loop in ${typeToDebugString(referenceType)} ${referenceType.flags}`);
      }
      typeStr += this.translate(referenceType.target);
      if (typeStr === "?")
        return "?";
      let typeArgs = this.typeChecker.getTypeArguments(referenceType) ?? [];
      const outerTypeParameters = referenceType.target.outerTypeParameters;
      if (outerTypeParameters) {
        typeArgs = typeArgs.slice(outerTypeParameters.length);
      }
      if (this.dropFinalTypeArgument) {
        typeArgs = typeArgs.slice(0, typeArgs.length - 1);
      }
      const localTypeParameters = referenceType.target.localTypeParameters;
      const maxExpectedTypeArgs = (localTypeParameters?.length ?? 0) + 1;
      if (typeArgs.length > maxExpectedTypeArgs) {
        this.warn(`more type args (${typeArgs.length}) than expected (${maxExpectedTypeArgs})`);
      }
      if (localTypeParameters && typeArgs.length > 0) {
        typeArgs = typeArgs.slice(0, localTypeParameters.length);
        this.seenTypes.push(referenceType);
        const params = typeArgs.map((t3) => this.translate(t3));
        this.seenTypes.pop();
        typeStr += `<${params.join(", ")}>`;
      }
      return typeStr;
    } else if (type.objectFlags & ts4.ObjectFlags.Anonymous) {
      return this.translateAnonymousType(type);
    }
    this.warn(`unhandled type ${typeToDebugString(type)}`);
    return "?";
  }
  translateUnion(type) {
    return this.translateUnionMembers(type.types);
  }
  translateUnionMembers(types) {
    const parts = new Set(types.map((t3) => this.translate(t3)));
    if (parts.size === 1)
      return parts.values().next().value;
    return `(${Array.from(parts.values()).join("|")})`;
  }
  isAlwaysUnknownSymbol(symbol) {
    return isAlwaysUnknownSymbol(this.pathUnknownSymbolsSet, symbol);
  }
  markTypeParameterAsUnknown(unknownSymbolsMap, decls) {
    if (!decls || !decls.length)
      return;
    for (const tpd of decls) {
      const sym = this.typeChecker.getSymbolAtLocation(tpd.name);
      if (!sym) {
        this.warn(`type parameter with no symbol`);
        continue;
      }
      unknownSymbolsMap.set(sym, "?");
    }
  }
  maybeGetMangledNamePrefix(symbol) {
    if (!symbol.declarations)
      return "";
    const declarations = symbol.declarations;
    let ambientModuleDeclaration = null;
    if (!isTopLevelExternal(declarations)) {
      ambientModuleDeclaration = getContainingAmbientModuleDeclaration(declarations);
      if (!ambientModuleDeclaration)
        return "";
    }
    if (!this.isForExterns && !declarations.every((d) => isDeclaredInSameFile(this.node, d) && isAmbient(d) && hasModifierFlag(d, ts4.ModifierFlags.Export))) {
      return "";
    }
    let fileName;
    let context;
    if (ambientModuleDeclaration) {
      fileName = ambientModuleDeclaration.name.text;
      context = ambientModuleDeclaration.getSourceFile().fileName;
    } else {
      fileName = ts4.getOriginalNode(declarations[0]).getSourceFile().fileName;
      context = "";
    }
    const mangled = moduleNameAsIdentifier(this.host, fileName, context);
    if (this.isForExterns && this.useInternalNamespaceForExterns && !ambientModuleDeclaration && isDeclaredInSameFile(this.node, declarations[0])) {
      return mangled + "_.";
    }
    return mangled + ".";
  }
  symbolToString(sym) {
    const cachedName = this.symbolToNameCache.get(sym);
    if (cachedName)
      return cachedName;
    if (!this.isForExterns && (sym.flags & ts4.SymbolFlags.TypeParameter) === 0) {
      this.ensureSymbolDeclared(sym);
    }
    const context = nodeIsInTransformedNs(this.node) ? this.node.getSourceFile() : this.node;
    const name = this.typeChecker.symbolToEntityName(sym, ts4.SymbolFlags.Type, context, ts4.NodeBuilderFlags.UseFullyQualifiedType | ts4.NodeBuilderFlags.UseOnlyExternalAliasing);
    if (!name)
      return;
    let str = "";
    const writeEntityWithSymbols = (name2) => {
      let identifier;
      if (ts4.isQualifiedName(name2)) {
        writeEntityWithSymbols(name2.left);
        str += ".";
        identifier = name2.right;
      } else {
        identifier = name2;
      }
      let symbol = identifier.symbol;
      if (symbol.flags & ts4.SymbolFlags.Alias) {
        symbol = this.typeChecker.getAliasedSymbol(symbol);
      }
      const alias = this.symbolsToAliasedNames.get(symbol);
      if (alias) {
        str = alias;
        return;
      }
      let text = getIdentifierText(identifier);
      if (str.length === 0) {
        const mangledPrefix = this.maybeGetMangledNamePrefix(symbol);
        text = mangledPrefix + text;
      }
      str += text;
    };
    writeEntityWithSymbols(name);
    str = this.stripClutzNamespace(str);
    this.symbolToNameCache.set(sym, str);
    return str;
  }
  translate(type) {
    if (type.flags === ts4.TypeFlags.NonPrimitive)
      return "!Object";
    if (type.flags === ts4.TypeFlags.TemplateLiteral)
      return "string";
    if (this.seenTypes.indexOf(type) !== -1)
      return "?";
    let isAmbient2 = false;
    let isInUnsupportedNamespace = false;
    let isModule = false;
    if (type.symbol) {
      for (const decl of type.symbol.declarations || []) {
        if (ts4.isExternalModule(decl.getSourceFile()))
          isModule = true;
        if (decl.getSourceFile().isDeclarationFile)
          isAmbient2 = true;
        let current = decl;
        while (current) {
          if (ts4.getCombinedModifierFlags(current) & ts4.ModifierFlags.Ambient)
            isAmbient2 = true;
          if (current.kind === ts4.SyntaxKind.ModuleDeclaration && !isMergedDeclaration(current)) {
            isInUnsupportedNamespace = true;
          }
          current = current.parent;
        }
      }
    }
    if (isInUnsupportedNamespace && !isAmbient2) {
      return "?";
    }
    if (this.isForExterns && isModule && !isAmbient2)
      return "?";
    const lastFlag = ts4.TypeFlags.StringMapping;
    const mask = (lastFlag << 1) - 1;
    switch (type.flags & mask) {
      case ts4.TypeFlags.Any:
        return "?";
      case ts4.TypeFlags.Unknown:
        return "*";
      case ts4.TypeFlags.String:
      case ts4.TypeFlags.StringLiteral:
      case ts4.TypeFlags.StringMapping:
        return "string";
      case ts4.TypeFlags.Number:
      case ts4.TypeFlags.NumberLiteral:
        return "number";
      case ts4.TypeFlags.BigInt:
      case ts4.TypeFlags.BigIntLiteral:
        return "bigint";
      case ts4.TypeFlags.Boolean:
      case ts4.TypeFlags.BooleanLiteral:
        return "boolean";
      case ts4.TypeFlags.Enum:
        if (!type.symbol) {
          this.warn(`EnumType without a symbol`);
          return "?";
        }
        if (type.symbol.flags & ts4.SymbolFlags.EnumMember) {
          return this.translateEnumLiteral(type);
        }
        return this.symbolToString(type.symbol) || "?";
      case ts4.TypeFlags.ESSymbol:
      case ts4.TypeFlags.UniqueESSymbol:
        return "symbol";
      case ts4.TypeFlags.Void:
        return "void";
      case ts4.TypeFlags.Undefined:
        return "undefined";
      case ts4.TypeFlags.Null:
        return "null";
      case ts4.TypeFlags.Never:
        this.warn(`should not emit a 'never' type`);
        return "?";
      case ts4.TypeFlags.TypeParameter:
        if (!type.symbol) {
          this.warn(`TypeParameter without a symbol`);
          return "?";
        }
        let prefix = "";
        if ((type.symbol.flags & ts4.SymbolFlags.TypeParameter) === 0) {
          prefix = "!";
        }
        const name = this.symbolToString(type.symbol);
        if (!name)
          return "?";
        return prefix + name;
      case ts4.TypeFlags.Object:
        return this.translateObject(type);
      case ts4.TypeFlags.Union:
        return this.translateUnion(type);
      case ts4.TypeFlags.Conditional:
      case ts4.TypeFlags.Substitution:
        if (type.aliasSymbol?.escapedName === "NonNullable" && isDeclaredInBuiltinLibDTS(type.aliasSymbol.declarations?.[0])) {
          let innerSymbol = undefined;
          if (type.aliasTypeArguments?.[0]) {
            innerSymbol = this.translate(type.aliasTypeArguments[0]);
          } else {
            const srcFile = this.node.getSourceFile().fileName;
            const start = this.node.getStart();
            const end = this.node.getEnd();
            throw new Error(`NonNullable missing expected type argument:
                ${srcFile}(${start}-${end})`);
          }
          return innerSymbol ?? "?";
        }
        this.warn(`emitting ? for conditional/substitution type`);
        return "?";
      case ts4.TypeFlags.Intersection:
        if (type.aliasSymbol?.escapedName === "NonNullable" && isDeclaredInBuiltinLibDTS(type.aliasSymbol.declarations?.[0])) {
          let innerSymbol = undefined;
          if (type.aliasTypeArguments?.[0]) {
            innerSymbol = this.translate(type.aliasTypeArguments[0]);
          } else {
            const srcFile = this.node.getSourceFile().fileName;
            const start = this.node.getStart();
            const end = this.node.getEnd();
            throw new Error(`NonNullable missing expected type argument:
                ${srcFile}(${start}-${end})`);
          }
          return innerSymbol ?? "?";
        }
        if (type.aliasSymbol?.escapedName === "gbigint") {
          return "!gbigint";
        }
        this.warn(`unhandled type flags: ${ts4.TypeFlags[type.flags]}`);
        return "?";
      case ts4.TypeFlags.Index:
      case ts4.TypeFlags.IndexedAccess:
        this.warn(`unhandled type flags: ${ts4.TypeFlags[type.flags]}`);
        return "?";
      default:
        if (type.flags & ts4.TypeFlags.Union) {
          if (type.flags === (ts4.TypeFlags.EnumLiteral | ts4.TypeFlags.Union) && type.symbol) {
            const name2 = this.symbolToString(type.symbol);
            return name2 ? "!" + name2 : this.translateUnion(type);
          }
          return this.translateUnion(type);
        }
        if (type.flags & ts4.TypeFlags.EnumLiteral) {
          return this.translateEnumLiteral(type);
        }
        throw new Error(`unknown type flags ${type.flags} on ${typeToDebugString(type)}`);
    }
  }
  warn(msg) {}
}
function isAlwaysUnknownSymbol(pathUnknownSymbolsSet, symbol) {
  if (pathUnknownSymbolsSet === undefined)
    return false;
  if (symbol.declarations === undefined)
    return false;
  return symbol.declarations.every((n) => {
    const fileName = normalize(n.getSourceFile().fileName);
    return pathUnknownSymbolsSet.has(fileName);
  });
}
function restParameterType(typeChecker, type) {
  if ((type.flags & ts4.TypeFlags.Object) === 0 && type.flags & ts4.TypeFlags.TypeParameter) {
    const baseConstraint = typeChecker.getBaseConstraintOfType(type);
    if (baseConstraint)
      type = baseConstraint;
  }
  if ((type.flags & ts4.TypeFlags.Object) === 0) {
    return;
  }
  const objType = type;
  if ((objType.objectFlags & ts4.ObjectFlags.Reference) === 0) {
    return;
  }
  const typeRef = objType;
  const typeArgs = typeChecker.getTypeArguments(typeRef);
  if (typeArgs.length < 1) {
    return;
  }
  return typeArgs[0];
}
function isFunctionLikeDeclaration(node) {
  return ts4.isFunctionDeclaration(node) || ts4.isMethodDeclaration(node) || ts4.isConstructorDeclaration(node) || ts4.isGetAccessorDeclaration(node) || ts4.isSetAccessorDeclaration(node) || ts4.isFunctionExpression(node) || ts4.isArrowFunction(node);
}

// src/tsickle/clutz.ts
function makeDeclarationTransformerFactory(typeChecker, host) {
  return (context) => {
    return {
      transformBundle() {
        throw new Error("did not expect to transform a bundle");
      },
      transformSourceFile(file) {
        const options = context.getCompilerOptions();
        const imports = gatherNecessaryClutzImports(host, typeChecker, file);
        let importStmts;
        if (imports.length > 0) {
          importStmts = imports.map((fileName) => {
            fileName = relative(options.rootDir, fileName);
            return ts5.factory.createImportDeclaration(undefined, undefined, ts5.factory.createStringLiteral(fileName));
          });
        }
        const globalBlock = generateClutzAliases(file, host.pathToModuleName("", file.fileName), typeChecker, options);
        if (!importStmts && !globalBlock)
          return file;
        return ts5.factory.updateSourceFile(file, ts5.setTextRange(ts5.factory.createNodeArray([
          ...importStmts ?? [],
          ...file.statements,
          ...globalBlock ? [globalBlock] : []
        ]), file.statements), file.isDeclarationFile, file.referencedFiles.map((f) => fixRelativeReference(f, file, options, host)), []);
      }
    };
  };
}
function fixRelativeReference(reference, origin, options, host) {
  if (!options.outDir || !options.rootDir) {
    return reference;
  }
  const originDir = dirname(origin.fileName);
  const expectedOutDir = join(options.outDir, relative(options.rootDir, originDir));
  const referencedFile = join(expectedOutDir, reference.fileName);
  const actualOutDir = join(options.outDir, host.rootDirsRelative(originDir));
  const fixedReference = relative(actualOutDir, referencedFile);
  reference.fileName = fixedReference;
  return reference;
}
function stringCompare(a, b) {
  if (a < b)
    return -1;
  if (a > b)
    return 1;
  return 0;
}
function generateClutzAliases(sourceFile, moduleName, typeChecker, options) {
  const moduleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
  const moduleExports = moduleSymbol && typeChecker.getExportsOfModule(moduleSymbol);
  if (!moduleExports)
    return;
  const origSourceFile = ts5.getOriginalNode(sourceFile);
  const localExports = moduleExports.filter((e) => {
    if (!e.declarations)
      return false;
    if (e.name === "default")
      return false;
    for (const d of e.declarations) {
      if (d.getSourceFile() !== origSourceFile) {
        return false;
      }
      const isInternalDeclaration2 = ts5.isInternalDeclaration;
      const node = ts5.isVariableDeclaration(d) ? d.parent.parent : d;
      if (options.stripInternal && isInternalDeclaration2(node, origSourceFile)) {
        return false;
      }
      if (!ts5.isExportSpecifier(d)) {
        return true;
      }
      const localSymbol = typeChecker.getExportSpecifierLocalTargetSymbol(d);
      if (!localSymbol)
        return false;
      if (!localSymbol.declarations)
        return false;
      for (const localD of localSymbol.declarations) {
        if (localD.getSourceFile() !== origSourceFile) {
          return false;
        }
      }
    }
    return true;
  });
  if (!localExports.length)
    return;
  localExports.sort((a, b) => stringCompare(a.name, b.name));
  const clutzModuleName = moduleName.replace(/\./g, "$");
  const globalExports = [];
  const nestedExports = [];
  for (const symbol of localExports) {
    let localName = symbol.name;
    const declaration = symbol.declarations?.find((d) => d.getSourceFile() === origSourceFile);
    if (declaration && ts5.isExportSpecifier(declaration) && declaration.propertyName) {
      localName = declaration.propertyName.text;
    }
    const mangledName = `module$contents$${clutzModuleName}_${symbol.name}`;
    globalExports.push(ts5.factory.createExportSpecifier(false, ts5.factory.createIdentifier(localName), ts5.factory.createIdentifier(mangledName)));
    nestedExports.push(ts5.factory.createExportSpecifier(false, localName === symbol.name ? undefined : localName, ts5.factory.createIdentifier(symbol.name)));
  }
  const globalDeclarations = [
    ts5.factory.createExportDeclaration(undefined, false, ts5.factory.createNamedExports(globalExports)),
    ts5.factory.createModuleDeclaration([ts5.factory.createModifier(ts5.SyntaxKind.ExportKeyword)], ts5.factory.createIdentifier(`module$exports$${clutzModuleName}`), ts5.factory.createModuleBlock([
      ts5.factory.createExportDeclaration(undefined, false, ts5.factory.createNamedExports(nestedExports))
    ]), ts5.NodeFlags.Namespace)
  ];
  return ts5.factory.createModuleDeclaration([ts5.factory.createModifier(ts5.SyntaxKind.DeclareKeyword)], ts5.factory.createIdentifier("global"), ts5.factory.createModuleBlock([
    ts5.factory.createModuleDeclaration(undefined, ts5.factory.createIdentifier("ಠ_ಠ.clutz"), ts5.factory.createModuleBlock(globalDeclarations), ts5.NodeFlags.Namespace | ts5.NodeFlags.NestedNamespace)
  ]), ts5.NodeFlags.GlobalAugmentation);
}
function ambientModuleSymbolFromClutz(googmoduleHost, typeChecker, stmt) {
  if (!ts5.isImportDeclaration(stmt) && !ts5.isExportDeclaration(stmt)) {
    return;
  }
  if (!stmt.moduleSpecifier) {
    return;
  }
  const moduleSymbol = typeChecker.getSymbolAtLocation(stmt.moduleSpecifier);
  if (moduleSymbol?.valueDeclaration && ts5.isSourceFile(moduleSymbol.valueDeclaration)) {
    return;
  }
  const ignoredDiagnostics = [];
  const namespace = jsPathToNamespace(googmoduleHost, stmt, ignoredDiagnostics, stmt.moduleSpecifier.text, () => moduleSymbol);
  if (namespace === null)
    return;
  return moduleSymbol;
}
function clutzSymbolFromQualifiedName(typeChecker, name) {
  const node = ts5.isQualifiedName(name) ? name.right : name;
  let sym = typeChecker.getSymbolAtLocation(node);
  if (!sym) {
    sym = node["symbol"];
  }
  if (!sym || !sym.declarations || sym.declarations.length === 0 || !isDeclaredInClutzDts(sym.declarations[0])) {
    return;
  }
  return sym;
}
function clutzSymbolFromNode(typeChecker, node) {
  if (ts5.isTypeReferenceNode(node)) {
    return clutzSymbolFromQualifiedName(typeChecker, node.typeName);
  }
  if (ts5.isTypeQueryNode(node)) {
    return clutzSymbolFromQualifiedName(typeChecker, node.exprName);
  }
  return;
}
function importPathForSymbol(sym) {
  if (!sym.declarations || sym.declarations.length === 0) {
    return;
  }
  const clutzFileName = sym.declarations[0].getSourceFile().fileName;
  if (!clutzFileName.endsWith(".d.ts")) {
    throw new Error(`Expected d.ts file for ${sym} but found ${clutzFileName}`);
  }
  return clutzFileName.substring(0, clutzFileName.length - ".d.ts".length);
}
function gatherNecessaryClutzImports(googmoduleHost, typeChecker, sf) {
  const imports = new Set;
  for (const stmt of sf.statements) {
    ts5.forEachChild(stmt, visit);
    const moduleSymbol = ambientModuleSymbolFromClutz(googmoduleHost, typeChecker, stmt);
    if (!moduleSymbol)
      continue;
    const importPath = importPathForSymbol(moduleSymbol);
    if (importPath)
      imports.add(importPath);
  }
  return Array.from(imports);
  function visit(node) {
    const sym = clutzSymbolFromNode(typeChecker, node);
    if (sym) {
      const importPath = importPathForSymbol(sym);
      if (importPath)
        imports.add(importPath);
    }
    ts5.forEachChild(node, visit);
  }
}

// src/tsickle/decorator_downlevel_transformer.ts
var ts8 = __toESM(require("typescript"));

// src/tsickle/decorators.ts
var ts7 = __toESM(require("typescript"));

// src/tsickle/jsdoc.ts
var ts6 = __toESM(require("typescript"));
var CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT = new Set([
  "abstract",
  "alternateMessageId",
  "author",
  "const",
  "constant",
  "constructor",
  "copyright",
  "define",
  "deprecated",
  "desc",
  "dict",
  "disposes",
  "enhance",
  "enhanceable",
  "enum",
  "export",
  "expose",
  "extends",
  "externs",
  "fileoverview",
  "final",
  "hassoydelcall",
  "hassoydeltemplate",
  "hidden",
  "id",
  "idGenerator",
  "ignore",
  "implements",
  "implicitCast",
  "inheritDoc",
  "interface",
  "jaggerInject",
  "jaggerModule",
  "jaggerProvide",
  "jaggerProvidePromise",
  "lends",
  "license",
  "link",
  "logTypeInCompiler",
  "meaning",
  "modifies",
  "modName",
  "mods",
  "ngInject",
  "noalias",
  "nocollapse",
  "nocompile",
  "noinline",
  "nosideeffects",
  "override",
  "owner",
  "package",
  "param",
  "pintomodule",
  "polymer",
  "polymerBehavior",
  "preserve",
  "preserveTry",
  "private",
  "protected",
  "public",
  "pureOrBreakMyCode",
  "record",
  "requirecss",
  "requires",
  "return",
  "returns",
  "sassGeneratedCssTs",
  "see",
  "struct",
  "suppress",
  "template",
  "this",
  "throws",
  "type",
  "typedef",
  "unrestricted",
  "version",
  "wizaction",
  "wizcallback",
  "wizmodule"
]);
var BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS = new Set(CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT);
BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS.delete("license");
var BANNED_JSDOC_TAGS_INPUT = new Set([
  "augments",
  "class",
  "constructs",
  "constructor",
  "enum",
  "extends",
  "field",
  "function",
  "implements",
  "interface",
  "lends",
  "namespace",
  "private",
  "protected",
  "public",
  "record",
  "static",
  "template",
  "this",
  "type",
  "typedef"
]);
var TAGS_CONFLICTING_WITH_TYPE = new Set(["param", "return"]);
var JSDOC_TAGS_WITH_TYPES = new Set([
  "const",
  "define",
  "export",
  ...TAGS_CONFLICTING_WITH_TYPE
]);
var ONE_LINER_TAGS = new Set([
  "type",
  "typedef",
  "nocollapse",
  "const",
  "enum"
]);
function parse2(comment) {
  if (comment.kind !== ts6.SyntaxKind.MultiLineCommentTrivia)
    return null;
  if (comment.text[0] !== "*")
    return null;
  const text = comment.text.substring(1).trim();
  return parseContents(text);
}
function normalizeLineEndings(input) {
  return input.replace(/\r\n/g, `
`);
}
function parseContents(commentText) {
  commentText = normalizeLineEndings(commentText);
  commentText = commentText.replace(/^\s*\*? ?/gm, "");
  const lines = commentText.split(`
`);
  const tags = [];
  const warnings = [];
  for (const line of lines) {
    let match = line.match(/^\s*@([^\s{]+) *({?.*)/);
    if (match) {
      let [, tagName, text] = match;
      if (tagName === "returns") {
        tagName = "return";
      }
      let type;
      if (BANNED_JSDOC_TAGS_INPUT.has(tagName)) {
        if (tagName !== "template") {
          warnings.push(`@${tagName} annotations are redundant with TypeScript equivalents`);
          continue;
        } else {
          continue;
        }
      } else if (JSDOC_TAGS_WITH_TYPES.has(tagName)) {
        if (text[0] === "{") {
          warnings.push(`the type annotation on @${tagName} is redundant with its TypeScript type, ` + `remove the {...} part`);
          continue;
        }
      } else if (tagName === "suppress") {
        const typeMatch = text.match(/^\{(.*)\}(.*)$/);
        if (typeMatch) {
          [, type, text] = typeMatch;
        } else {
          warnings.push(`malformed @${tagName} tag: "${text}"`);
        }
      } else if (tagName === "dict") {
        warnings.push("use index signatures (`[k: string]: type`) instead of @dict");
        continue;
      }
      let parameterName;
      if (tagName === "param") {
        match = text.match(/^(\S+) ?(.*)/);
        if (match)
          [, parameterName, text] = match;
      }
      const tag = { tagName };
      if (parameterName)
        tag.parameterName = parameterName;
      if (text)
        tag.text = text;
      if (type)
        tag.type = type;
      tags.push(tag);
    } else {
      if (tags.length === 0) {
        tags.push({ tagName: "", text: line });
      } else {
        const lastTag = tags[tags.length - 1];
        lastTag.text = (lastTag.text || "") + `
` + line;
      }
    }
  }
  if (warnings.length > 0) {
    return { tags, warnings };
  }
  return { tags };
}
function tagToString(tag, escapeExtraTags = new Set) {
  let out = "";
  if (tag.tagName) {
    if (!CLOSURE_ALLOWED_JSDOC_TAGS_OUTPUT.has(tag.tagName) || escapeExtraTags.has(tag.tagName)) {
      out += ` \\@${tag.tagName}`;
    } else {
      out += ` @${tag.tagName}`;
    }
  }
  if (tag.type) {
    out += " {";
    if (tag.restParam) {
      out += "...";
    }
    out += tag.type;
    if (tag.optional) {
      out += "=";
    }
    out += "}";
  }
  if (tag.parameterName) {
    out += " " + tag.parameterName;
  }
  if (tag.text) {
    out += " " + tag.text.replace(/@/g, "\\@");
  }
  return out;
}
var SINGLETON_TAGS = new Set(["deprecated"]);
function synthesizeLeadingComments(node) {
  const existing = ts6.getSyntheticLeadingComments(node);
  if (existing && hasLeadingCommentsSuppressed(node))
    return existing;
  const text = ts6.getOriginalNode(node).getFullText();
  const synthComments = getLeadingCommentRangesSynthesized(text, node.getFullStart());
  if (synthComments.length) {
    ts6.setSyntheticLeadingComments(node, synthComments);
    suppressLeadingCommentsRecursively(node);
  }
  return synthComments;
}
function hasLeadingCommentsSuppressed(node) {
  const internalNode = node;
  if (!internalNode.emitNode)
    return false;
  return (internalNode.emitNode.flags & ts6.EmitFlags.NoLeadingComments) === ts6.EmitFlags.NoLeadingComments;
}
function getLeadingCommentRangesSynthesized(text, offset = 0) {
  const comments = ts6.getLeadingCommentRanges(text, 0) || [];
  return comments.map((cr) => {
    const commentText = cr.kind === ts6.SyntaxKind.SingleLineCommentTrivia ? text.substring(cr.pos + 2, cr.end) : text.substring(cr.pos + 2, cr.end - 2);
    return {
      ...cr,
      end: -1,
      originalRange: { end: cr.end + offset, pos: cr.pos + offset },
      pos: -1,
      text: commentText
    };
  });
}
function suppressLeadingCommentsRecursively(node) {
  const originalStart = node.getFullStart();
  function suppressCommentsInternal(node2) {
    ts6.setEmitFlags(node2, ts6.EmitFlags.NoLeadingComments);
    return !!ts6.forEachChild(node2, (child) => {
      if (child.pos !== originalStart)
        return true;
      return suppressCommentsInternal(child);
    });
  }
  suppressCommentsInternal(node);
}
function toSynthesizedComment(tags, escapeExtraTags, hasTrailingNewLine = true) {
  return {
    end: -1,
    hasTrailingNewLine,
    kind: ts6.SyntaxKind.MultiLineCommentTrivia,
    pos: -1,
    text: toStringWithoutStartEnd(tags, escapeExtraTags)
  };
}
function toStringWithoutStartEnd(tags, escapeExtraTags = new Set) {
  return serialize(tags, false, escapeExtraTags);
}
function toString(tags, escapeExtraTags = new Set) {
  return serialize(tags, true, escapeExtraTags);
}
function serialize(tags, includeStartEnd, escapeExtraTags = new Set) {
  if (tags.length === 0)
    return "";
  if (tags.length === 1) {
    const tag = tags[0];
    if (ONE_LINER_TAGS.has(tag.tagName) && (!tag.text || !tag.text.match(`
`))) {
      const text = tagToString(tag, escapeExtraTags);
      return includeStartEnd ? `/**${text} */` : `*${text} `;
    }
  }
  let out = includeStartEnd ? `/**
` : `*
`;
  const emitted = new Set;
  for (const tag of tags) {
    if (emitted.has(tag.tagName) && SINGLETON_TAGS.has(tag.tagName)) {
      continue;
    }
    emitted.add(tag.tagName);
    out += " *";
    out += tagToString(tag, escapeExtraTags).split(`
`).join(`
 * `);
    out += `
`;
  }
  out += includeStartEnd ? ` */
` : " ";
  return out;
}
function merge(tags) {
  const tagNames = new Set;
  const parameterNames = new Set;
  const types = new Set;
  const texts = new Set;
  let optional = false;
  let restParam = false;
  for (const tag2 of tags) {
    tagNames.add(tag2.tagName);
    if (tag2.parameterName !== undefined)
      parameterNames.add(tag2.parameterName);
    if (tag2.type !== undefined)
      types.add(tag2.type);
    if (tag2.text !== undefined)
      texts.add(tag2.text);
    if (tag2.optional)
      optional = true;
    if (tag2.restParam)
      restParam = true;
  }
  if (tagNames.size !== 1) {
    throw new Error(`cannot merge differing tags: ${JSON.stringify(tags)}`);
  }
  const tagName = tagNames.values().next().value;
  const parameterName = parameterNames.size > 0 ? Array.from(parameterNames).join("_or_") : undefined;
  const type = types.size > 0 ? Array.from(types).join("|") : undefined;
  const isTemplateTag = tagName === "template";
  const text = texts.size > 0 ? Array.from(texts).join(isTemplateTag ? "," : " / ") : undefined;
  const tag = { parameterName, tagName, text, type };
  if (restParam) {
    tag.restParam = true;
  } else if (optional) {
    tag.optional = true;
  }
  return tag;
}
function createGeneratedFromComment(file) {
  return `Generated from: ${file}`;
}

class MutableJSDoc {
  node;
  allComments;
  sourceComment;
  tags;
  sanitizedOtherComments = false;
  constructor(node, allComments, sourceComment, tags) {
    this.node = node;
    this.allComments = allComments;
    this.sourceComment = sourceComment;
    this.tags = tags;
  }
  updateComment(escapeExtraTags) {
    if (!this.sanitizedOtherComments) {
      for (let i = 0;i < this.allComments.length; i++) {
        if (i === this.sourceComment)
          continue;
        const comment2 = this.allComments[i];
        const parsed = parse2(comment2);
        if (!parsed)
          continue;
        comment2.text = toStringWithoutStartEnd(parsed.tags, BANNED_JSDOC_TAGS_IN_FREESTANDING_COMMENTS);
      }
      this.sanitizedOtherComments = true;
    }
    const text = toStringWithoutStartEnd(this.tags, escapeExtraTags);
    if (this.sourceComment >= 0) {
      if (!text) {
        this.allComments.splice(this.sourceComment, 1);
        this.sourceComment = -1;
        return;
      }
      this.allComments[this.sourceComment].text = text;
      return;
    }
    if (!text)
      return;
    const comment = {
      end: -1,
      hasTrailingNewLine: true,
      kind: ts6.SyntaxKind.MultiLineCommentTrivia,
      pos: -1,
      text
    };
    this.allComments.push(comment);
    this.sourceComment = this.allComments.length - 1;
    ts6.setSyntheticLeadingComments(this.node, this.allComments);
  }
}
function getJSDocTags(node, diagnostics, sourceFile) {
  if (!ts6.getParseTreeNode(node))
    return [];
  const [, , tags] = parseJSDoc(node, diagnostics, sourceFile);
  return tags;
}
function getMutableJSDoc(node, diagnostics, sourceFile) {
  const [comments, i, tags] = parseJSDoc(node, diagnostics, sourceFile);
  return new MutableJSDoc(node, comments, i, tags);
}
function parseJSDoc(node, diagnostics, sourceFile) {
  let nodeCommentRange;
  if (diagnostics !== undefined) {
    const pos = node.getFullStart();
    const length = node.getLeadingTriviaWidth(sourceFile);
    nodeCommentRange = { end: pos + length, pos };
  }
  const comments = synthesizeLeadingComments(node);
  if (!comments || comments.length === 0)
    return [[], -1, []];
  for (let i = comments.length - 1;i >= 0; i--) {
    const comment = comments[i];
    const parsed = parse2(comment);
    if (parsed) {
      if (diagnostics !== undefined && parsed.warnings) {
        const range = comment.originalRange || nodeCommentRange;
        reportDiagnostic(diagnostics, node, parsed.warnings.join(`
`), range, ts6.DiagnosticCategory.Warning);
      }
      return [comments, i, parsed.tags];
    }
  }
  return [comments, -1, []];
}

// src/tsickle/decorators.ts
function getDecoratorDeclarations(decorator, typeChecker) {
  let node = decorator;
  while (node.kind !== ts7.SyntaxKind.Identifier) {
    if (node.kind === ts7.SyntaxKind.Decorator || node.kind === ts7.SyntaxKind.CallExpression) {
      node = node.expression;
    } else {
      return [];
    }
  }
  let decSym = typeChecker.getSymbolAtLocation(node);
  if (!decSym)
    return [];
  if (decSym.flags & ts7.SymbolFlags.Alias) {
    decSym = typeChecker.getAliasedSymbol(decSym);
  }
  return decSym.getDeclarations() || [];
}
function hasExportingDecorator(node, typeChecker) {
  const decorators = ts7.canHaveDecorators(node) ? ts7.getDecorators(node) : [];
  return decorators && decorators.some((decorator) => isExportingDecorator(decorator, typeChecker));
}
function isExportingDecorator(decorator, typeChecker) {
  return getDecoratorDeclarations(decorator, typeChecker).some((declaration) => {
    const range = getAllLeadingComments(declaration);
    if (!range) {
      return false;
    }
    for (const { text } of range) {
      if (/@ExportDecoratedItems\b/.test(text)) {
        return true;
      }
    }
    return false;
  });
}
function transformDecoratorsOutputForClosurePropertyRenaming(diagnostics) {
  return (context) => {
    const result = (sourceFile) => {
      let nodeNeedingGoogReflect = undefined;
      const visitor = (node) => {
        const replacementNode = rewriteDecorator(node);
        if (replacementNode) {
          nodeNeedingGoogReflect = node;
          return replacementNode;
        }
        return ts7.visitEachChild(node, visitor, context);
      };
      let updatedSourceFile = ts7.visitNode(sourceFile, visitor, ts7.isSourceFile);
      if (nodeNeedingGoogReflect !== undefined) {
        const statements = [...updatedSourceFile.statements];
        const googModuleIndex = statements.findIndex(isGoogModuleStatement);
        if (googModuleIndex === -1) {
          reportDiagnostic(diagnostics, nodeNeedingGoogReflect, "Internal tsickle error: could not find goog.module statement to import __tsickle_googReflect for decorator compilation.");
          return sourceFile;
        }
        const googRequireReflectObjectProperty = ts7.factory.createVariableStatement(undefined, ts7.factory.createVariableDeclarationList([
          ts7.factory.createVariableDeclaration("__tsickle_googReflect", undefined, undefined, ts7.factory.createCallExpression(ts7.factory.createPropertyAccessExpression(ts7.factory.createIdentifier("goog"), "require"), undefined, [ts7.factory.createStringLiteral("goog.reflect")]))
        ], ts7.NodeFlags.Const));
        statements.splice(googModuleIndex + 3, 0, googRequireReflectObjectProperty);
        updatedSourceFile = ts7.factory.updateSourceFile(updatedSourceFile, ts7.setTextRange(ts7.factory.createNodeArray(statements), updatedSourceFile.statements), updatedSourceFile.isDeclarationFile, updatedSourceFile.referencedFiles, updatedSourceFile.typeReferenceDirectives, updatedSourceFile.hasNoDefaultLib, updatedSourceFile.libReferenceDirectives);
      }
      return updatedSourceFile;
    };
    return result;
  };
}
function rewriteDecorator(node) {
  if (!ts7.isCallExpression(node)) {
    return;
  }
  const identifier = node.expression;
  if (!ts7.isIdentifier(identifier) || identifier.text !== "__decorate") {
    return;
  }
  const args = [...node.arguments];
  if (args.length !== 4) {
    return;
  }
  const untypedFieldNameLiteral = args[2];
  if (!ts7.isStringLiteral(untypedFieldNameLiteral)) {
    return;
  }
  const fieldNameLiteral = untypedFieldNameLiteral;
  args[2] = ts7.factory.createCallExpression(ts7.factory.createPropertyAccessExpression(ts7.factory.createIdentifier("__tsickle_googReflect"), "objectProperty"), undefined, [ts7.factory.createStringLiteral(fieldNameLiteral.text), args[1]]);
  return ts7.factory.updateCallExpression(node, node.expression, node.typeArguments, args);
}
function isGoogModuleStatement(statement) {
  if (!ts7.isExpressionStatement(statement)) {
    return false;
  }
  const expr = statement.expression;
  if (!ts7.isCallExpression(expr)) {
    return false;
  }
  if (!ts7.isPropertyAccessExpression(expr.expression)) {
    return false;
  }
  const goog = expr.expression.expression;
  if (!ts7.isIdentifier(goog)) {
    return false;
  }
  return goog.text === "goog" && expr.expression.name.text === "module";
}
var TAGS_CONFLICTING_WITH_DECORATE = new Set(["template", "abstract"]);
function sanitizeDecorateComments(comments) {
  const sanitized = [];
  for (const comment of comments) {
    const parsedComment = parse2(comment);
    if (parsedComment && parsedComment.tags.length !== 0) {
      const filteredTags = parsedComment.tags.filter((t3) => !TAGS_CONFLICTING_WITH_DECORATE.has(t3.tagName));
      if (filteredTags.length !== 0) {
        sanitized.push(toSynthesizedComment(filteredTags));
      }
    }
  }
  return sanitized;
}
function transformDecoratorJsdoc() {
  return () => {
    const transformer = (sourceFile) => {
      for (const stmt of sourceFile.statements) {
        if (!ts7.isExpressionStatement(stmt))
          continue;
        const expr = stmt.expression;
        if (!ts7.isBinaryExpression(expr))
          continue;
        if (expr.operatorToken.kind !== ts7.SyntaxKind.EqualsToken)
          continue;
        const rhs = expr.right;
        if (!ts7.isCallExpression(rhs))
          continue;
        if (ts7.isIdentifier(rhs.expression) && rhs.expression.text === "__decorate") {
          const comments = ts7.getSyntheticLeadingComments(stmt);
          if (!comments || comments.length === 0) {
            ts7.addSyntheticLeadingComment(stmt, ts7.SyntaxKind.MultiLineCommentTrivia, "* @suppress {visibility} ", true);
          } else {
            ts7.setSyntheticLeadingComments(stmt, sanitizeDecorateComments(comments));
          }
        }
      }
      return sourceFile;
    };
    return transformer;
  };
}

// src/tsickle/decorator_downlevel_transformer.ts
function shouldLower(decorator, typeChecker) {
  for (const d of getDecoratorDeclarations(decorator, typeChecker)) {
    let commentNode = d;
    if (commentNode.kind === ts8.SyntaxKind.VariableDeclaration) {
      if (!commentNode.parent)
        continue;
      commentNode = commentNode.parent;
    }
    if (commentNode.kind === ts8.SyntaxKind.VariableDeclarationList) {
      if (!commentNode.parent)
        continue;
      commentNode = commentNode.parent;
    }
    const range = getAllLeadingComments(commentNode);
    if (!range)
      continue;
    for (const { text } of range) {
      if (text.includes("@Annotation"))
        return true;
    }
  }
  return false;
}
var DECORATOR_INVOCATION_JSDOC_TYPE = "!Array<{type: !Function, args: (undefined|!Array<?>)}>";
function addJSDocTypeAnnotation(node, jsdocType) {
  ts8.setSyntheticLeadingComments(node, [
    toSynthesizedComment([
      {
        tagName: "type",
        type: jsdocType
      }
    ])
  ]);
}
function extractMetadataFromSingleDecorator(decorator, diagnostics) {
  const metadataProperties = [];
  const expr = decorator.expression;
  switch (expr.kind) {
    case ts8.SyntaxKind.Identifier:
      metadataProperties.push(ts8.factory.createPropertyAssignment("type", expr));
      break;
    case ts8.SyntaxKind.CallExpression:
      const call = expr;
      metadataProperties.push(ts8.factory.createPropertyAssignment("type", call.expression));
      if (call.arguments.length) {
        const args = [];
        for (const arg of call.arguments) {
          args.push(arg);
        }
        const argsArrayLiteral = ts8.factory.createArrayLiteralExpression(ts8.factory.createNodeArray(args, true));
        metadataProperties.push(ts8.factory.createPropertyAssignment("args", argsArrayLiteral));
      }
      break;
    default:
      diagnostics.push({
        category: ts8.DiagnosticCategory.Error,
        code: 0,
        file: decorator.getSourceFile(),
        length: decorator.getEnd() - decorator.getStart(),
        messageText: `${ts8.SyntaxKind[decorator.kind]} not implemented in gathering decorator metadata`,
        start: decorator.getStart()
      });
      break;
  }
  return ts8.factory.createObjectLiteralExpression(metadataProperties);
}
function createDecoratorClassProperty(decoratorList) {
  const modifier = ts8.factory.createToken(ts8.SyntaxKind.StaticKeyword);
  const initializer = ts8.factory.createArrayLiteralExpression(ts8.factory.createNodeArray(decoratorList, true), true);
  const prop = ts8.factory.createPropertyDeclaration([modifier], "decorators", undefined, undefined, initializer);
  addJSDocTypeAnnotation(prop, DECORATOR_INVOCATION_JSDOC_TYPE);
  return prop;
}
function createCtorParametersClassProperty(diagnostics, entityNameToExpression, ctorParameters) {
  const params = [];
  for (const ctorParam of ctorParameters) {
    if (!ctorParam.type && ctorParam.decorators.length === 0) {
      params.push(ts8.factory.createNull());
      continue;
    }
    const paramType = ctorParam.type ? typeReferenceToExpression(entityNameToExpression, ctorParam.type) : undefined;
    const members = [
      ts8.factory.createPropertyAssignment("type", paramType || ts8.factory.createIdentifier("undefined"))
    ];
    const decorators = [];
    for (const deco of ctorParam.decorators) {
      decorators.push(extractMetadataFromSingleDecorator(deco, diagnostics));
    }
    if (decorators.length) {
      members.push(ts8.factory.createPropertyAssignment("decorators", ts8.factory.createArrayLiteralExpression(decorators)));
    }
    params.push(ts8.factory.createObjectLiteralExpression(members));
  }
  const initializer = ts8.factory.createArrowFunction(undefined, undefined, [], undefined, ts8.factory.createToken(ts8.SyntaxKind.EqualsGreaterThanToken), ts8.factory.createArrayLiteralExpression(params, true));
  const ctorProp = ts8.factory.createPropertyDeclaration([ts8.factory.createToken(ts8.SyntaxKind.StaticKeyword)], "ctorParameters", undefined, undefined, initializer);
  ts8.setSyntheticLeadingComments(ctorProp, [
    toSynthesizedComment([
      {
        tagName: "type",
        type: lines(`function(): !Array<(null|{`, `  type: ?,`, `  decorators: (undefined|${DECORATOR_INVOCATION_JSDOC_TYPE}),`, `})>`)
      },
      { tagName: "nocollapse" }
    ])
  ]);
  return ctorProp;
}
function createPropDecoratorsClassProperty(diagnostics, properties) {
  const entries = [];
  for (const [name, decorators] of properties.entries()) {
    entries.push(ts8.factory.createPropertyAssignment(name, ts8.factory.createArrayLiteralExpression(decorators.map((deco) => extractMetadataFromSingleDecorator(deco, diagnostics)))));
  }
  const initializer = ts8.factory.createObjectLiteralExpression(entries, true);
  const prop = ts8.factory.createPropertyDeclaration([ts8.factory.createToken(ts8.SyntaxKind.StaticKeyword)], "propDecorators", undefined, undefined, initializer);
  addJSDocTypeAnnotation(prop, `!Object<string, ${DECORATOR_INVOCATION_JSDOC_TYPE}>`);
  return prop;
}
function typeReferenceToExpression(entityNameToExpression, node) {
  let kind = node.kind;
  if (ts8.isLiteralTypeNode(node)) {
    kind = node.literal.kind;
  }
  switch (kind) {
    case ts8.SyntaxKind.FunctionType:
    case ts8.SyntaxKind.ConstructorType:
      return ts8.factory.createIdentifier("Function");
    case ts8.SyntaxKind.ArrayType:
    case ts8.SyntaxKind.TupleType:
      return ts8.factory.createIdentifier("Array");
    case ts8.SyntaxKind.TypePredicate:
    case ts8.SyntaxKind.TrueKeyword:
    case ts8.SyntaxKind.FalseKeyword:
    case ts8.SyntaxKind.BooleanKeyword:
      return ts8.factory.createIdentifier("Boolean");
    case ts8.SyntaxKind.StringLiteral:
    case ts8.SyntaxKind.StringKeyword:
      return ts8.factory.createIdentifier("String");
    case ts8.SyntaxKind.ObjectKeyword:
      return ts8.factory.createIdentifier("Object");
    case ts8.SyntaxKind.NumberKeyword:
    case ts8.SyntaxKind.NumericLiteral:
      return ts8.factory.createIdentifier("Number");
    case ts8.SyntaxKind.TypeReference:
      const typeRef = node;
      return entityNameToExpression(typeRef.typeName);
    default:
      return;
  }
}
function decoratorDownlevelTransformer(typeChecker, diagnostics) {
  return (context) => {
    let importNamesBySymbol = new Map;
    function entityNameToExpression(name) {
      const sym = typeChecker.getSymbolAtLocation(name);
      if (!sym)
        return;
      if (!symbolIsValue(typeChecker, sym))
        return;
      if (ts8.isIdentifier(name)) {
        if (importNamesBySymbol.has(sym))
          return importNamesBySymbol.get(sym);
        return name;
      }
      const ref = entityNameToExpression(name.left);
      if (!ref)
        return;
      return ts8.factory.createPropertyAccessExpression(ref, name.right);
    }
    function transformClassElement(element) {
      element = ts8.visitEachChild(element, visitor, context);
      const modifiersToKeep = [];
      const toLower = [];
      for (const modifier of element.modifiers || []) {
        if (ts8.isDecorator(modifier)) {
          if (shouldLower(modifier, typeChecker)) {
            toLower.push(modifier);
            continue;
          }
        }
        modifiersToKeep.push(modifier);
      }
      if (!toLower.length)
        return [undefined, element, []];
      if (!element.name || element.name.kind !== ts8.SyntaxKind.Identifier) {
        diagnostics.push({
          category: ts8.DiagnosticCategory.Error,
          code: 0,
          file: element.getSourceFile(),
          length: element.getEnd() - element.getStart(),
          messageText: `cannot process decorators on strangely named method`,
          start: element.getStart()
        });
        return [undefined, element, []];
      }
      const name = element.name.text;
      let newNode;
      const modifiers = modifiersToKeep.length ? ts8.setTextRange(ts8.factory.createNodeArray(modifiersToKeep), ts8.factory.createNodeArray(element.modifiers ?? [])) : undefined;
      switch (element.kind) {
        case ts8.SyntaxKind.PropertyDeclaration:
          newNode = ts8.factory.updatePropertyDeclaration(element, modifiers, element.name, element.questionToken ?? element.exclamationToken, element.type, element.initializer);
          break;
        case ts8.SyntaxKind.GetAccessor:
          newNode = ts8.factory.updateGetAccessorDeclaration(element, modifiers, element.name, element.parameters, element.type, element.body);
          break;
        case ts8.SyntaxKind.SetAccessor:
          newNode = ts8.factory.updateSetAccessorDeclaration(element, modifiers, element.name, element.parameters, element.body);
          break;
        case ts8.SyntaxKind.MethodDeclaration:
          newNode = ts8.factory.updateMethodDeclaration(element, modifiers, element.asteriskToken, element.name, element.questionToken, element.typeParameters, element.parameters, element.type, element.body);
          break;
        default:
          throw new Error(`unexpected element: ${element}`);
      }
      return [name, newNode, toLower];
    }
    function transformConstructor(ctor) {
      ctor = ts8.visitEachChild(ctor, visitor, context);
      const newParameters = [];
      const oldParameters = ts8.visitParameterList(ctor.parameters, visitor, context);
      const parametersInfo = [];
      for (const param of oldParameters) {
        const modifiersToKeep = [];
        const paramInfo = {
          decorators: [],
          type: null
        };
        for (const modifier of param.modifiers || []) {
          if (ts8.isDecorator(modifier)) {
            if (shouldLower(modifier, typeChecker)) {
              paramInfo.decorators.push(modifier);
              continue;
            }
          }
          modifiersToKeep.push(modifier);
        }
        if (param.type) {
          paramInfo.type = param.type;
        }
        parametersInfo.push(paramInfo);
        const newParam = ts8.factory.updateParameterDeclaration(param, modifiersToKeep, param.dotDotDotToken, param.name, param.questionToken, param.type, param.initializer);
        newParameters.push(newParam);
      }
      const updated = ts8.factory.updateConstructorDeclaration(ctor, ctor.modifiers, newParameters, ts8.visitFunctionBody(ctor.body, visitor, context));
      return [updated, parametersInfo];
    }
    function transformClassDeclaration(classDecl) {
      const newMembers = [];
      const decoratedProperties = new Map;
      let classParameters = null;
      for (const member of classDecl.members) {
        switch (member.kind) {
          case ts8.SyntaxKind.PropertyDeclaration:
          case ts8.SyntaxKind.GetAccessor:
          case ts8.SyntaxKind.SetAccessor:
          case ts8.SyntaxKind.MethodDeclaration: {
            const [name, newMember, decorators] = transformClassElement(member);
            newMembers.push(newMember);
            if (name)
              decoratedProperties.set(name, decorators);
            continue;
          }
          case ts8.SyntaxKind.Constructor: {
            const ctor = member;
            if (!ctor.body)
              break;
            const [newMember, parametersInfo] = transformConstructor(member);
            classParameters = parametersInfo;
            newMembers.push(newMember);
            continue;
          }
          default:
            break;
        }
        newMembers.push(ts8.visitEachChild(member, visitor, context));
      }
      const decoratorsToLower = [];
      const modifiersToKeep = [];
      for (const modifier of classDecl.modifiers || []) {
        if (ts8.isDecorator(modifier)) {
          if (shouldLower(modifier, typeChecker)) {
            decoratorsToLower.push(extractMetadataFromSingleDecorator(modifier, diagnostics));
            continue;
          }
        }
        modifiersToKeep.push(modifier);
      }
      if (decoratorsToLower.length) {
        newMembers.push(createDecoratorClassProperty(decoratorsToLower));
      }
      if (classParameters) {
        if (decoratorsToLower.length || classParameters.some((p) => !!p.decorators.length)) {
          newMembers.push(createCtorParametersClassProperty(diagnostics, entityNameToExpression, classParameters));
        }
      }
      if (decoratedProperties.size) {
        newMembers.push(createPropDecoratorsClassProperty(diagnostics, decoratedProperties));
      }
      return ts8.factory.updateClassDeclaration(classDecl, modifiersToKeep.length ? modifiersToKeep : undefined, classDecl.name, classDecl.typeParameters, classDecl.heritageClauses, ts8.setTextRange(ts8.factory.createNodeArray(newMembers, classDecl.members.hasTrailingComma), classDecl.members));
    }
    function visitor(node) {
      switch (node.kind) {
        case ts8.SyntaxKind.SourceFile: {
          importNamesBySymbol = new Map;
          return ts8.visitEachChild(node, visitor, context);
        }
        case ts8.SyntaxKind.ImportDeclaration: {
          const impDecl = node;
          if (impDecl.importClause) {
            const importClause = impDecl.importClause;
            const names = [];
            if (importClause.name) {
              names.push(importClause.name);
            }
            if (importClause.namedBindings && importClause.namedBindings.kind === ts8.SyntaxKind.NamedImports) {
              names.push(...importClause.namedBindings.elements.map((e) => e.name));
            }
            for (const name of names) {
              const sym = typeChecker.getSymbolAtLocation(name);
              importNamesBySymbol.set(sym, name);
            }
          }
          return ts8.visitEachChild(node, visitor, context);
        }
        case ts8.SyntaxKind.ClassDeclaration: {
          return transformClassDeclaration(node);
        }
        default:
          return visitEachChild2(node, visitor, context);
      }
    }
    return (sf) => visitor(sf);
  };
}
function lines(...s) {
  return s.join(`
`);
}

// src/tsickle/enum_transformer.ts
var ts9 = __toESM(require("typescript"));
function isInUnsupportedNamespace(node) {
  let parent = ts9.getOriginalNode(node).parent;
  while (parent) {
    if (parent.kind === ts9.SyntaxKind.ModuleDeclaration) {
      return !isMergedDeclaration(parent);
    }
    parent = parent.parent;
  }
  return false;
}
function getEnumMemberType(typeChecker, member) {
  if (!member.initializer) {
    return "number";
  }
  const type = typeChecker.getTypeAtLocation(member.initializer);
  if (type.flags & ts9.TypeFlags.NumberLike) {
    return "number";
  }
  return "string";
}
function getEnumType(typeChecker, enumDecl) {
  let hasNumber = false;
  let hasString = false;
  for (const member of enumDecl.members) {
    const type = getEnumMemberType(typeChecker, member);
    if (type === "string") {
      hasString = true;
    } else if (type === "number") {
      hasNumber = true;
    }
  }
  if (hasNumber && hasString) {
    return "?";
  } else if (hasNumber) {
    return "number";
  } else if (hasString) {
    return "string";
  } else {
    return "?";
  }
}
function enumTransformer(host, typeChecker) {
  return (context) => {
    function visitor(node) {
      if (!ts9.isEnumDeclaration(node))
        return ts9.visitEachChild(node, visitor, context);
      if (isInUnsupportedNamespace(node)) {
        return ts9.visitEachChild(node, visitor, context);
      }
      if (isAmbient(node))
        return ts9.visitEachChild(node, visitor, context);
      const isExported = hasModifierFlag(node, ts9.ModifierFlags.Export);
      const enumType = getEnumType(typeChecker, node);
      const values = [];
      let enumIndex = 0;
      for (const member of node.members) {
        let enumValue;
        if (member.initializer) {
          const enumConstValue = typeChecker.getConstantValue(member);
          if (typeof enumConstValue === "number") {
            enumIndex = enumConstValue + 1;
            if (enumConstValue < 0) {
              enumValue = ts9.factory.createPrefixUnaryExpression(ts9.SyntaxKind.MinusToken, ts9.factory.createNumericLiteral(-enumConstValue));
            } else {
              enumValue = ts9.factory.createNumericLiteral(enumConstValue);
            }
          } else if (typeof enumConstValue === "string") {
            enumValue = ts9.factory.createStringLiteral(enumConstValue);
          } else {
            enumValue = visitor(member.initializer);
          }
        } else {
          enumValue = ts9.factory.createNumericLiteral(enumIndex);
          enumIndex++;
        }
        values.push(ts9.setOriginalNode(ts9.setTextRange(ts9.factory.createPropertyAssignment(member.name, enumValue), member), member));
      }
      const varDecl = ts9.factory.createVariableDeclaration(node.name, undefined, undefined, ts9.factory.createObjectLiteralExpression(ts9.setTextRange(ts9.factory.createNodeArray(values, true), node.members), true));
      const varDeclStmt = ts9.setOriginalNode(ts9.setTextRange(ts9.factory.createVariableStatement(undefined, ts9.factory.createVariableDeclarationList([varDecl], host.useDeclarationMergingTransformation ? ts9.NodeFlags.Const : undefined)), node), node);
      const tags = getJSDocTags(ts9.getOriginalNode(node));
      tags.push({ tagName: "enum", type: enumType });
      const comment = toSynthesizedComment(tags);
      ts9.setSyntheticLeadingComments(varDeclStmt, [comment]);
      const name = getIdentifierText(node.name);
      const resultNodes = [varDeclStmt];
      if (isExported) {
        resultNodes.push(ts9.factory.createExportDeclaration(undefined, false, ts9.factory.createNamedExports([
          ts9.factory.createExportSpecifier(false, undefined, name)
        ])));
      }
      if (hasModifierFlag(node, ts9.ModifierFlags.Const)) {
        return resultNodes;
      }
      for (const member of node.members) {
        const memberName = member.name;
        const memberType = getEnumMemberType(typeChecker, member);
        if (memberType !== "number" || ts9.isPrivateIdentifier(memberName)) {
          continue;
        }
        let nameExpr;
        let memberAccess;
        if (ts9.isIdentifier(memberName)) {
          nameExpr = createSingleQuoteStringLiteral(memberName.text);
          const ident = ts9.factory.createIdentifier(getIdentifierText(memberName));
          memberAccess = ts9.factory.createPropertyAccessExpression(ts9.factory.createIdentifier(name), ident);
        } else {
          nameExpr = ts9.isComputedPropertyName(memberName) ? memberName.expression : memberName;
          memberAccess = ts9.factory.createElementAccessExpression(ts9.factory.createIdentifier(name), nameExpr);
        }
        resultNodes.push(ts9.factory.createExpressionStatement(ts9.factory.createAssignment(ts9.factory.createElementAccessExpression(ts9.factory.createIdentifier(name), memberAccess), nameExpr)));
      }
      return resultNodes;
    }
    return (sf) => visitor(sf);
  };
}

// src/tsickle/externs.ts
var ts12 = __toESM(require("typescript"));

// src/tsickle/jsdoc_transformer.ts
var ts11 = __toESM(require("typescript"));

// src/tsickle/module_type_translator.ts
var ts10 = __toESM(require("typescript"));
function getDefinedModule(symbol) {
  while (symbol) {
    if (symbol.flags & ts10.SymbolFlags.Module) {
      return symbol;
    }
    symbol = symbol.parent;
  }
  return;
}
function getParameterName(param, index) {
  switch (param.name.kind) {
    case ts10.SyntaxKind.Identifier:
      let name = getIdentifierText(param.name);
      if (name === "arguments")
        name = "tsickle_arguments";
      return name;
    case ts10.SyntaxKind.ArrayBindingPattern:
    case ts10.SyntaxKind.ObjectBindingPattern:
      return `__${index}`;
    default:
      const paramName = param.name;
      throw new Error(`unhandled function parameter kind: ${ts10.SyntaxKind[paramName.kind]}`);
  }
}

class ModuleTypeTranslator {
  sourceFile;
  typeChecker;
  host;
  diagnostics;
  isForExterns;
  useInternalNamespaceForExterns;
  additionalImports = [];
  requireTypeModules = new Set;
  symbolToNameCache = new Map;
  symbolsToAliasedNames = new Map;
  constructor(sourceFile, typeChecker, host, diagnostics, isForExterns, useInternalNamespaceForExterns = false) {
    this.sourceFile = sourceFile;
    this.typeChecker = typeChecker;
    this.host = host;
    this.diagnostics = diagnostics;
    this.isForExterns = isForExterns;
    this.useInternalNamespaceForExterns = useInternalNamespaceForExterns;
    this.host.unknownTypesPaths = this.host.unknownTypesPaths ?? this.host.typeBlackListPaths;
  }
  addRequireTypeIfIsExported(decl, sym) {
    if (!hasModifierFlag(decl, ts10.ModifierFlags.ExportDefault))
      return false;
    if (isGlobalAugmentation(decl))
      return false;
    const sourceFile = decl.getSourceFile();
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      return false;
    }
    if (this.isForExterns) {
      this.error(decl, `declaration from module used in ambient type: ${sym.name}`);
    } else if (sourceFile.isDeclarationFile && !sourceFile.text.match(/^\/\/!! generated by (clutz|tsickle|clutz2)/)) {
      this.registerExternSymbolAliases(sourceFile.fileName, moduleSymbol);
    } else {
      this.requireType(decl, sourceFile.fileName, moduleSymbol);
    }
    return true;
  }
  generateModulePrefix(importPath) {
    const modulePrefix = importPath.replace(/(\/index)?(\.d)?\.[tj]sx?$/, "").replace(/^.*[/.](.+?)/, "$1").replace(/\W/g, "_");
    return `tsickle_${modulePrefix || "reqType"}_`;
  }
  getTypeSymbolOfSymbolIfClassOrInterface(symbol) {
    const type = this.typeChecker.getDeclaredTypeOfSymbol(symbol);
    const typeSymbol = type.getSymbol();
    if (!typeSymbol) {
      return;
    }
    if (!(type.flags & ts10.TypeFlags.Object)) {
      return;
    }
    const objectFlags = type.objectFlags;
    return objectFlags & ts10.ObjectFlags.ClassOrInterface ? typeSymbol : undefined;
  }
  qualifiedNameFromSymbolChain(leafSymbol, googNamespace, isDefaultImport, aliasPrefix, namedDefaultImport) {
    if (googNamespace && (isDefaultImport || namedDefaultImport)) {
      return aliasPrefix;
    }
    let typeSymbol = leafSymbol;
    const symbols = [typeSymbol];
    while (typeSymbol.parent && typeSymbol.parent.flags & ts10.SymbolFlags.NamespaceModule) {
      typeSymbol = typeSymbol.parent;
      symbols.push(typeSymbol);
    }
    let qualifiedName = "";
    let aliasResolved = false;
    for (const symbol of symbols.reverse()) {
      const alias = this.symbolsToAliasedNames.get(symbol);
      if (alias) {
        qualifiedName = alias;
        aliasResolved = true;
        continue;
      }
      qualifiedName = qualifiedName ? qualifiedName + "." + symbol.name : symbol.name;
    }
    if (!aliasResolved && leafSymbol.parent) {
      qualifiedName = aliasPrefix + "." + qualifiedName;
    }
    return qualifiedName.replace("ಠ_ಠ.clutz.", "");
  }
  registerImportTypeSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, aliasPrefix) {
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const namedDefaultImport = sym.name === "default";
      if (sym.flags & ts10.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      const typeSymbol = this.getTypeSymbolOfSymbolIfClassOrInterface(sym);
      if (!typeSymbol)
        continue;
      if (typeSymbol.parent && getDefinedModule(sym) !== getDefinedModule(typeSymbol)) {
        continue;
      }
      const qualifiedName = this.qualifiedNameFromSymbolChain(typeSymbol, googNamespace, isDefaultImport, aliasPrefix, namedDefaultImport);
      const cache = this.symbolToNameCache.get(typeSymbol);
      if (!cache || cache.length > qualifiedName.length) {
        this.symbolToNameCache.set(typeSymbol, qualifiedName);
      }
    }
  }
  resolveRestParameterType(newTag, fnDecl, paramNode) {
    const type = restParameterType(this.typeChecker, this.typeChecker.getTypeAtLocation(paramNode));
    newTag.restParam = true;
    if (!type) {
      this.debugWarn(paramNode, "failed to resolve rest parameter type, emitting ?");
      newTag.type = "?";
      return;
    }
    newTag.type = this.typeToClosure(fnDecl, type);
  }
  debugWarn(context, messageText) {
    reportDebugWarning(this.host, context, messageText);
  }
  ensureSymbolDeclared(sym) {
    if (this.symbolsToAliasedNames.has(sym))
      return;
    const declarations = sym.declarations;
    const thisSourceFile = ts10.getOriginalNode(this.sourceFile);
    if (declarations.some((d) => d.getSourceFile() === thisSourceFile)) {
      return;
    }
    for (const decl of declarations) {
      if (this.addRequireTypeIfIsExported(decl, sym))
        return;
    }
    const clutzDecl = declarations.find(isDeclaredInClutzDts);
    if (!clutzDecl)
      return;
    const clutzDts = clutzDecl.getSourceFile();
    const clutzModule = this.typeChecker.getSymbolsInScope(clutzDts, ts10.SymbolFlags.Module).find((module2) => module2.getName().startsWith('"goog:') && module2.valueDeclaration?.getSourceFile() === clutzDts && this.typeChecker.getExportsOfModule(module2).some((exported) => {
      if (exported.flags & ts10.SymbolFlags.Alias) {
        exported = this.typeChecker.getAliasedSymbol(exported);
      }
      if (exported === sym) {
        return true;
      }
      if (exported.exports) {
        let found = false;
        exported.exports.forEach((symbol, key) => {
          found = found || symbol === sym;
        });
        return found;
      }
      return false;
    }));
    if (clutzModule) {
      this.requireType(clutzDecl, clutzModule.getName().slice(1, -1), clutzModule);
    }
  }
  error(node, messageText) {
    reportDiagnostic(this.diagnostics, node, messageText);
  }
  getFunctionTypeJSDoc(fnDecls, extraTags = []) {
    const typeChecker = this.typeChecker;
    const tagsByName = new Map;
    function addTag(tag) {
      if (tag.tagName === "implements")
        return;
      const existing = tagsByName.get(tag.tagName);
      tagsByName.set(tag.tagName, existing ? merge([existing, tag]) : tag);
    }
    for (const extraTag of extraTags)
      addTag(extraTag);
    const isConstructor = fnDecls.find((d) => d.kind === ts10.SyntaxKind.Constructor) !== undefined;
    const paramTags = [];
    const returnTags = [];
    const thisTags = [];
    const typeParameterNames = new Set;
    const argCounts = [];
    let thisReturnType = null;
    for (const fnDecl of fnDecls) {
      const tags = this.getJSDoc(fnDecl, false);
      for (const tag of tags) {
        if (tag.tagName === "param" || tag.tagName === "return")
          continue;
        addTag(tag);
      }
      const flags = ts10.getCombinedModifierFlags(fnDecl);
      if (flags & ts10.ModifierFlags.Abstract) {
        addTag({ tagName: "abstract" });
      }
      if (fnDecls.every((d) => !ts10.isFunctionDeclaration(d) && !ts10.isFunctionExpression(d) && !ts10.isArrowFunction(d))) {
        if (flags & ts10.ModifierFlags.Protected) {
          addTag({ tagName: "protected" });
        } else if (flags & ts10.ModifierFlags.Private) {
          addTag({ tagName: "private" });
        } else if (!tagsByName.has("export") && !tagsByName.has("package")) {
          addTag({ tagName: "public" });
        }
      }
      if (fnDecl.typeParameters) {
        for (const tp of fnDecl.typeParameters) {
          typeParameterNames.add(getIdentifierText(tp.name));
        }
      }
      const sig = typeChecker.getSignatureFromDeclaration(fnDecl);
      if (!sig || !sig.declaration) {
        throw new Error(`invalid signature ${fnDecl.name}`);
      }
      if (sig.declaration.kind === ts10.SyntaxKind.JSDocSignature) {
        throw new Error(`JSDoc signature ${fnDecl.name}`);
      }
      let hasThisParam = false;
      for (let i = 0;i < sig.declaration.parameters.length; i++) {
        const paramNode = sig.declaration.parameters[i];
        const name = getParameterName(paramNode, i);
        const isThisParam = name === "this";
        if (isThisParam)
          hasThisParam = true;
        const newTag = {
          optional: paramNode.initializer !== undefined || paramNode.questionToken !== undefined,
          parameterName: isThisParam ? undefined : name,
          tagName: isThisParam ? "this" : "param"
        };
        if (paramNode.dotDotDotToken === undefined) {
          newTag.type = this.typeToClosure(fnDecl, this.typeChecker.getTypeAtLocation(paramNode));
        } else {
          this.resolveRestParameterType(newTag, fnDecl, paramNode);
        }
        for (const { parameterName, tagName, text } of tags) {
          if (tagName === "param" && parameterName === newTag.parameterName) {
            newTag.text = text;
            break;
          }
        }
        if (!isThisParam) {
          const paramIdx = hasThisParam ? i - 1 : i;
          if (!paramTags[paramIdx])
            paramTags.push([]);
          paramTags[paramIdx].push(newTag);
        } else {
          thisTags.push(newTag);
        }
      }
      argCounts.push(hasThisParam ? sig.declaration.parameters.length - 1 : sig.declaration.parameters.length);
      if (!isConstructor) {
        const returnTag = {
          tagName: "return"
        };
        const retType = typeChecker.getReturnTypeOfSignature(sig);
        if (retType["isThisType"] && !hasThisParam) {
          thisReturnType = retType;
          addTag({ tagName: "template", text: "THIS" });
          addTag({ tagName: "this", type: "THIS" });
          returnTag.type = "THIS";
        } else {
          returnTag.type = this.typeToClosure(fnDecl, retType);
          for (const { tagName, text } of tags) {
            if (tagName === "return") {
              returnTag.text = text;
              break;
            }
          }
        }
        returnTags.push(returnTag);
      }
    }
    if (typeParameterNames.size > 0) {
      addTag({
        tagName: "template",
        text: Array.from(typeParameterNames.values()).join(", ")
      });
    }
    const newDoc = Array.from(tagsByName.values());
    for (const extraTag of extraTags) {
      if (extraTag.tagName === "implements")
        newDoc.push(extraTag);
    }
    if (thisTags.length > 0) {
      newDoc.push(merge(thisTags));
    }
    const minArgsCount = Math.min(...argCounts);
    const maxArgsCount = Math.max(...argCounts);
    const paramNames = new Set;
    let foundOptional = false;
    for (let i = 0;i < maxArgsCount; i++) {
      const paramTag = merge(paramTags[i]);
      if (paramTag.parameterName) {
        if (paramNames.has(paramTag.parameterName)) {
          paramTag.parameterName += i.toString();
        }
        paramNames.add(paramTag.parameterName);
      }
      if (!paramTag.restParam && (paramTag.optional || foundOptional || i >= minArgsCount)) {
        foundOptional = true;
        paramTag.optional = true;
      }
      newDoc.push(paramTag);
      if (paramTag.restParam) {
        break;
      }
    }
    if (!isConstructor) {
      newDoc.push(merge(returnTags));
    }
    return {
      parameterNames: newDoc.filter((t3) => t3.tagName === "param").map((t3) => t3.parameterName),
      tags: newDoc,
      thisReturnType
    };
  }
  getJSDoc(node, reportWarnings) {
    return getJSDocTags(node, reportWarnings ? this.diagnostics : undefined, this.sourceFile);
  }
  getMutableJSDoc(node) {
    return getMutableJSDoc(node, this.diagnostics, this.sourceFile);
  }
  insertAdditionalImports(sourceFile) {
    let insertion = 0;
    if (sourceFile.statements.length && sourceFile.statements[0].kind === ts10.SyntaxKind.NotEmittedStatement) {
      insertion++;
    }
    return ts10.factory.updateSourceFile(sourceFile, [
      ...sourceFile.statements.slice(0, insertion),
      ...this.additionalImports,
      ...sourceFile.statements.slice(insertion)
    ]);
  }
  isAlwaysUnknownSymbol(context) {
    const type = this.typeChecker.getTypeAtLocation(context);
    let sym = type.symbol;
    if (!sym)
      return false;
    if (sym.flags & ts10.SymbolFlags.Alias) {
      sym = this.typeChecker.getAliasedSymbol(sym);
    }
    return this.newTypeTranslator(context).isAlwaysUnknownSymbol(sym);
  }
  mustGetSymbolAtLocation(node) {
    const sym = this.typeChecker.getSymbolAtLocation(node);
    if (!sym)
      throw new Error("no symbol");
    return sym;
  }
  newTypeTranslator(context) {
    const translationContext = this.isForExterns ? this.sourceFile : context;
    const translator = new TypeTranslator(this.host, this.typeChecker, translationContext, this.host.unknownTypesPaths || new Set, this.symbolsToAliasedNames, this.symbolToNameCache, (sym) => {
      this.ensureSymbolDeclared(sym);
    });
    translator.isForExterns = this.isForExterns;
    translator.useInternalNamespaceForExterns = this.useInternalNamespaceForExterns;
    translator.warn = (msg) => {
      this.debugWarn(context, msg);
    };
    return translator;
  }
  registerExternSymbolAliases(importPath, moduleSymbol) {
    const moduleNamespace = moduleNameAsIdentifier(this.host, importPath, this.sourceFile.fileName);
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const namedDefaultImport = sym.name === "default";
      let qualifiedName;
      if (moduleNamespace) {
        if (namedDefaultImport) {
          qualifiedName = moduleNamespace;
        } else {
          qualifiedName = moduleNamespace + "." + sym.name;
        }
      } else {
        qualifiedName = sym.name;
      }
      if (sym.flags & ts10.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      this.symbolsToAliasedNames.set(sym, qualifiedName);
    }
  }
  registerImportSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, getAliasPrefix) {
    for (let sym of this.typeChecker.getExportsOfModule(moduleSymbol)) {
      const aliasPrefix = getAliasPrefix(sym);
      const namedDefaultImport = sym.name === "default";
      const qualifiedName = googNamespace && (isDefaultImport || namedDefaultImport) ? aliasPrefix : aliasPrefix + "." + sym.name;
      if (sym.flags & ts10.SymbolFlags.Alias) {
        sym = this.typeChecker.getAliasedSymbol(sym);
      }
      this.symbolsToAliasedNames.set(sym, qualifiedName);
    }
  }
  requireType(context, importPath, moduleSymbol, isDefaultImport = false) {
    if (this.host.untyped)
      return;
    if (this.requireTypeModules.has(moduleSymbol))
      return;
    if (isAlwaysUnknownSymbol(this.host.unknownTypesPaths, moduleSymbol)) {
      return;
    }
    const nsImport = jsPathToNamespace(this.host, context, this.diagnostics, importPath, () => moduleSymbol);
    const requireTypePrefix = this.generateModulePrefix(importPath) + String(this.requireTypeModules.size + 1);
    const moduleNamespace = nsImport != null ? nsImport : this.host.pathToModuleName(this.sourceFile.fileName, importPath);
    if (jsPathToStripProperty(this.host, importPath, () => moduleSymbol)) {
      isDefaultImport = true;
    }
    this.additionalImports.push(ts10.factory.createVariableStatement(undefined, ts10.factory.createVariableDeclarationList([
      ts10.factory.createVariableDeclaration(requireTypePrefix, undefined, undefined, ts10.factory.createCallExpression(ts10.factory.createPropertyAccessExpression(ts10.factory.createIdentifier("goog"), "requireType"), undefined, [ts10.factory.createStringLiteral(moduleNamespace)]))
    ], ts10.NodeFlags.Const)));
    this.requireTypeModules.add(moduleSymbol);
    this.registerImportSymbolAliases(nsImport, isDefaultImport, moduleSymbol, () => requireTypePrefix);
    this.registerImportTypeSymbolAliases(nsImport, isDefaultImport, moduleSymbol, requireTypePrefix);
  }
  typeToClosure(context, type) {
    if (this.host.untyped) {
      return "?";
    }
    context = ts10.getOriginalNode(context);
    const typeChecker = this.typeChecker;
    if (!type) {
      type = typeChecker.getTypeAtLocation(context);
    }
    try {
      return this.newTypeTranslator(context).translate(type);
    } catch (e) {
      if (!(e instanceof Error))
        throw e;
      const sourceFile = context.getSourceFile();
      const { character, line } = context.pos !== -1 ? sourceFile.getLineAndCharacterOfPosition(context.pos) : { character: 0, line: 0 };
      e.message = `internal error converting type at ${sourceFile.fileName}:${line}:${character}:

` + e.message;
      throw e;
    }
  }
}
function isGlobalAugmentation(decl) {
  let current = decl;
  while (current) {
    if (current.flags & ts10.NodeFlags.GlobalAugmentation)
      return true;
    current = current.parent;
  }
  return false;
}

// src/tsickle/jsdoc_transformer.ts
function addCommentOn(node, tags, escapeExtraTags, hasTrailingNewLine = true) {
  const comment = toSynthesizedComment(tags, escapeExtraTags, hasTrailingNewLine);
  const comments = ts11.getSyntheticLeadingComments(node) || [];
  comments.push(comment);
  ts11.setSyntheticLeadingComments(node, comments);
  return comment;
}
function maybeAddTemplateClause(docTags, decl) {
  if (!decl.typeParameters)
    return;
  docTags.push({
    tagName: "template",
    text: decl.typeParameters.map((tp) => getIdentifierText(tp.name)).join(", ")
  });
}
function maybeAddHeritageClauses(docTags, mtt, decl) {
  if (!decl.heritageClauses)
    return;
  const isClass = decl.kind === ts11.SyntaxKind.ClassDeclaration;
  const hasAnyExtends = decl.heritageClauses.some((c) => c.token === ts11.SyntaxKind.ExtendsKeyword);
  for (const heritage of decl.heritageClauses) {
    const isExtends = heritage.token === ts11.SyntaxKind.ExtendsKeyword;
    for (const expr of heritage.types) {
      addHeritage(isExtends ? "extends" : "implements", expr);
    }
  }
  function addHeritage(relation, expr) {
    const supertype = mtt.typeChecker.getTypeAtLocation(expr);
    if (!supertype.symbol) {
      warn(`type without symbol`);
      return;
    }
    if (!supertype.symbol.name) {
      warn(`type without symbol name`);
      return;
    }
    if (supertype.symbol.flags & ts11.SymbolFlags.TypeLiteral) {
      warn(`dropped ${relation} of a type literal: ${expr.getText()}`);
      return;
    }
    const typeTranslator = mtt.newTypeTranslator(expr);
    typeTranslator.dropFinalTypeArgument = true;
    let closureType = typeTranslator.translate(supertype);
    if (closureType === "?") {
      warn(`{?} type`);
      return;
    }
    closureType = closureType.replace(/^!/, "");
    let tagName = relation;
    if (supertype.symbol.flags & ts11.SymbolFlags.Class) {
      if (!isClass) {
        warn(`interface cannot extend/implement class`);
        return;
      }
      if (relation !== "extends") {
        if (!hasAnyExtends) {
          tagName = "extends";
        } else {
          warn(`cannot implements a class`);
          return;
        }
      }
    }
    docTags.push({
      tagName,
      type: closureType
    });
    function warn(message) {
      message = `dropped ${relation}: ${message}`;
      docTags.push({ tagName: "", text: `tsickle: ${message}` });
      mtt.debugWarn(decl, message);
    }
  }
}
function createMemberTypeDeclaration(mtt, typeDecl) {
  const ctors = [];
  let paramProps = [];
  const nonStaticProps = [];
  const staticProps = [];
  const unhandled = [];
  const abstractMethods = [];
  for (const member of typeDecl.members) {
    if (member.kind === ts11.SyntaxKind.Constructor) {
      ctors.push(member);
    } else if (ts11.isPropertyDeclaration(member) || ts11.isPropertySignature(member) || ts11.isMethodDeclaration(member) && member.questionToken) {
      const isStatic = hasModifierFlag(member, ts11.ModifierFlags.Static);
      if (isStatic) {
        staticProps.push(member);
      } else {
        nonStaticProps.push(member);
      }
    } else if (member.kind === ts11.SyntaxKind.MethodDeclaration || member.kind === ts11.SyntaxKind.MethodSignature || member.kind === ts11.SyntaxKind.GetAccessor || member.kind === ts11.SyntaxKind.SetAccessor) {
      if (hasModifierFlag(member, ts11.ModifierFlags.Abstract) || ts11.isInterfaceDeclaration(typeDecl)) {
        abstractMethods.push(member);
      }
    } else {
      unhandled.push(member);
    }
  }
  if (ctors.length > 0) {
    const ctor = ctors[ctors.length - 1];
    paramProps = ctor.parameters.filter((p) => hasModifierFlag(p, ts11.ModifierFlags.ParameterPropertyModifier));
  }
  if (nonStaticProps.length === 0 && paramProps.length === 0 && staticProps.length === 0 && abstractMethods.length === 0) {
    return null;
  }
  if (!typeDecl.name) {
    mtt.debugWarn(typeDecl, "cannot add types on unnamed declarations");
    return null;
  }
  const className = getIdentifierText(typeDecl.name);
  const staticPropAccess = ts11.factory.createIdentifier(className);
  const instancePropAccess = ts11.factory.createPropertyAccessExpression(staticPropAccess, "prototype");
  const isInterface = ts11.isInterfaceDeclaration(typeDecl);
  const propertyDecls = staticProps.map((p) => createClosurePropertyDeclaration(mtt, staticPropAccess, p, isInterface && !!p.questionToken));
  propertyDecls.push(...[...nonStaticProps, ...paramProps].map((p) => createClosurePropertyDeclaration(mtt, instancePropAccess, p, isInterface && !!p.questionToken)));
  propertyDecls.push(...unhandled.map((p) => createMultiLineComment(p, `Skipping unhandled member: ${escapeForComment(p.getText())}`)));
  for (const fnDecl of abstractMethods) {
    const name = fnDecl.name && ts11.isComputedPropertyName(fnDecl.name) ? fnDecl.name.expression : propertyName(fnDecl);
    if (!name) {
      mtt.error(fnDecl, "anonymous abstract function");
      continue;
    }
    const { parameterNames, tags } = mtt.getFunctionTypeJSDoc([fnDecl], []);
    if (hasExportingDecorator(fnDecl, mtt.typeChecker))
      tags.push({ tagName: "export" });
    const lhs = typeof name === "string" ? ts11.factory.createPropertyAccessExpression(instancePropAccess, name) : ts11.factory.createElementAccessExpression(instancePropAccess, name);
    const abstractFnDecl = ts11.factory.createExpressionStatement(ts11.factory.createAssignment(lhs, ts11.factory.createFunctionExpression(undefined, undefined, undefined, undefined, parameterNames.map((n) => ts11.factory.createParameterDeclaration(undefined, undefined, n)), undefined, ts11.factory.createBlock([]))));
    ts11.setSyntheticLeadingComments(abstractFnDecl, [
      toSynthesizedComment(tags)
    ]);
    propertyDecls.push(ts11.setSourceMapRange(abstractFnDecl, fnDecl));
  }
  const ifStmt = ts11.factory.createIfStatement(ts11.factory.createFalse(), ts11.factory.createBlock(propertyDecls, true));
  ts11.addSyntheticLeadingComment(ifStmt, ts11.SyntaxKind.MultiLineCommentTrivia, " istanbul ignore if ", true);
  return ifStmt;
}
function propertyName(prop) {
  if (!prop.name)
    return null;
  switch (prop.name.kind) {
    case ts11.SyntaxKind.Identifier:
      return getIdentifierText(prop.name);
    case ts11.SyntaxKind.StringLiteral:
      const text = prop.name.text;
      if (!isValidClosurePropertyName(text))
        return null;
      return text;
    default:
      return null;
  }
}
function escapeForComment(str) {
  return str.replace(/\/\*/g, "__").replace(/\*\//g, "__");
}
function createClosurePropertyDeclaration(mtt, expr, prop, optional) {
  const name = propertyName(prop);
  if (!name) {
    if (ts11.isPrivateIdentifier(prop.name)) {
      return createMultiLineComment(prop, `Skipping private member:
${escapeForComment(prop.getText())}`);
    } else {
      mtt.debugWarn(prop, `handle unnamed member:
${escapeForComment(prop.getText())}`);
      return createMultiLineComment(prop, `Skipping unnamed member:
${escapeForComment(prop.getText())}`);
    }
  }
  if (name === "prototype") {
    return createMultiLineComment(prop, `Skipping illegal member name:
${escapeForComment(prop.getText())}`);
  }
  let type = mtt.typeToClosure(prop);
  if (optional && type === "?")
    type += "|undefined";
  const tags = mtt.getJSDoc(prop, false);
  const flags = ts11.getCombinedModifierFlags(prop);
  const isReadonly = !!(flags & ts11.ModifierFlags.Readonly);
  tags.push({ tagName: isReadonly ? "const" : "type", type });
  if (hasExportingDecorator(prop, mtt.typeChecker)) {
    tags.push({ tagName: "export" });
  } else if (flags & ts11.ModifierFlags.Protected) {
    tags.push({ tagName: "protected" });
  } else if (flags & ts11.ModifierFlags.Private) {
    tags.push({ tagName: "private" });
  } else if (!tags.find((t3) => t3.tagName === "export" || t3.tagName === "package")) {
    tags.push({ tagName: "public" });
  }
  const declStmt = ts11.setSourceMapRange(ts11.factory.createExpressionStatement(ts11.factory.createPropertyAccessExpression(expr, name)), prop);
  addCommentOn(declStmt, tags, TAGS_CONFLICTING_WITH_TYPE);
  return declStmt;
}
function removeTypeAssertions() {
  return (context) => {
    return (sourceFile) => {
      function visitor(node) {
        switch (node.kind) {
          case ts11.SyntaxKind.TypeAssertionExpression:
          case ts11.SyntaxKind.AsExpression:
            return ts11.visitNode(node.expression, visitor);
          case ts11.SyntaxKind.NonNullExpression:
            return ts11.visitNode(node.expression, visitor);
          default:
            break;
        }
        return ts11.visitEachChild(node, visitor, context);
      }
      return visitor(sourceFile);
    };
  };
}
function containsAsync(node) {
  if (ts11.isFunctionLike(node) && hasModifierFlag(node, ts11.ModifierFlags.Async)) {
    return true;
  }
  return ts11.forEachChild(node, containsAsync) || false;
}
function containsOptionalChainingOperator(node) {
  let maybePropertyAccessChain = node;
  while (ts11.isPropertyAccessExpression(maybePropertyAccessChain) || ts11.isNonNullExpression(maybePropertyAccessChain) || ts11.isCallExpression(maybePropertyAccessChain) || ts11.isElementAccessExpression(maybePropertyAccessChain)) {
    if (!ts11.isNonNullExpression(maybePropertyAccessChain) && maybePropertyAccessChain.questionDotToken != null) {
      return true;
    }
    maybePropertyAccessChain = maybePropertyAccessChain.expression;
  }
  return false;
}
function jsdocTransformer(host, tsOptions, typeChecker, diagnostics) {
  return (context) => {
    return (sourceFile) => {
      const moduleTypeTranslator = new ModuleTypeTranslator(sourceFile, typeChecker, host, diagnostics, false);
      const expandedStarImports = new Set;
      let contextThisType = null;
      let emitNarrowedTypes = true;
      function visitClassDeclaration(classDecl) {
        const contextThisTypeBackup = contextThisType;
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(classDecl);
        if (hasModifierFlag(classDecl, ts11.ModifierFlags.Abstract)) {
          mjsdoc.tags.push({ tagName: "abstract" });
        }
        maybeAddTemplateClause(mjsdoc.tags, classDecl);
        if (!host.untyped) {
          maybeAddHeritageClauses(mjsdoc.tags, moduleTypeTranslator, classDecl);
        }
        mjsdoc.updateComment(TAGS_CONFLICTING_WITH_TYPE);
        const decls = [];
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, classDecl);
        decls.push(ts11.visitEachChild(classDecl, visitor, context));
        if (memberDecl)
          decls.push(memberDecl);
        contextThisType = contextThisTypeBackup;
        return decls;
      }
      function visitHeritageClause(heritageClause) {
        if (heritageClause.token !== ts11.SyntaxKind.ExtendsKeyword || !heritageClause.parent || heritageClause.parent.kind === ts11.SyntaxKind.InterfaceDeclaration) {
          return ts11.visitEachChild(heritageClause, visitor, context);
        }
        if (heritageClause.types.length !== 1) {
          moduleTypeTranslator.error(heritageClause, `expected exactly one type in class extension clause`);
        }
        const type = heritageClause.types[0];
        let expr = type.expression;
        while (ts11.isParenthesizedExpression(expr) || ts11.isNonNullExpression(expr) || ts11.isAssertionExpression(expr)) {
          expr = expr.expression;
        }
        return ts11.factory.updateHeritageClause(heritageClause, [
          ts11.factory.updateExpressionWithTypeArguments(type, expr, type.typeArguments || [])
        ]);
      }
      function visitInterfaceDeclaration(iface) {
        const sym = typeChecker.getSymbolAtLocation(iface.name);
        if (!sym) {
          moduleTypeTranslator.error(iface, "interface with no symbol");
          return [];
        }
        if (symbolIsValue(typeChecker, sym) && !isMergedDeclaration(iface)) {
          moduleTypeTranslator.debugWarn(iface, `type/symbol conflict for ${sym.name}, using {?} for now`);
          return [
            createSingleLineComment(iface, "WARNING: interface has both a type and a value, skipping emit")
          ];
        }
        const tags = moduleTypeTranslator.getJSDoc(iface, true) || [];
        tags.push({ tagName: "record" });
        maybeAddTemplateClause(tags, iface);
        if (!host.untyped) {
          maybeAddHeritageClauses(tags, moduleTypeTranslator, iface);
        }
        const name = getIdentifierText(iface.name);
        const modifiers = hasModifierFlag(iface, ts11.ModifierFlags.Export) ? [ts11.factory.createToken(ts11.SyntaxKind.ExportKeyword)] : undefined;
        const decl = ts11.setSourceMapRange(ts11.factory.createFunctionDeclaration(modifiers, undefined, name, undefined, [], undefined, ts11.factory.createBlock([])), iface);
        addCommentOn(decl, tags, TAGS_CONFLICTING_WITH_TYPE);
        const isFirstOccurrence = getPreviousDeclaration(sym, iface) === null;
        const declarations = [];
        if (isFirstOccurrence)
          declarations.push(decl);
        const memberDecl = createMemberTypeDeclaration(moduleTypeTranslator, iface);
        if (memberDecl)
          declarations.push(memberDecl);
        return declarations;
      }
      function visitFunctionLikeDeclaration(fnDecl) {
        if (!fnDecl.body) {
          return ts11.visitEachChild(fnDecl, visitor, context);
        }
        const extraTags = [];
        if (hasExportingDecorator(fnDecl, typeChecker))
          extraTags.push({ tagName: "export" });
        const { tags, thisReturnType } = moduleTypeTranslator.getFunctionTypeJSDoc([fnDecl], extraTags);
        const isDownlevellingAsync = tsOptions.target !== undefined && tsOptions.target <= ts11.ScriptTarget.ES2018;
        const isFunction = fnDecl.kind === ts11.SyntaxKind.FunctionDeclaration;
        const hasExistingThisTag = tags.some((t3) => t3.tagName === "this");
        if (isDownlevellingAsync && isFunction && !hasExistingThisTag && containsAsync(fnDecl)) {
          tags.push({ tagName: "this", type: "*" });
        }
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(fnDecl);
        mjsdoc.tags = tags;
        mjsdoc.updateComment();
        const contextThisTypeBackup = contextThisType;
        if (!ts11.isArrowFunction(fnDecl))
          contextThisType = thisReturnType;
        fnDecl = ts11.visitEachChild(fnDecl, visitor, context);
        contextThisType = contextThisTypeBackup;
        if (!fnDecl.body) {
          return fnDecl;
        }
        const bindingAliases = [];
        const updatedParams = [];
        let hasUpdatedParams = false;
        for (const param of fnDecl.parameters) {
          if (!ts11.isArrayBindingPattern(param.name)) {
            updatedParams.push(param);
            continue;
          }
          const updatedParamName = renameArrayBindings(param.name, bindingAliases);
          if (!updatedParamName) {
            updatedParams.push(param);
            continue;
          }
          hasUpdatedParams = true;
          updatedParams.push(ts11.factory.updateParameterDeclaration(param, param.modifiers, param.dotDotDotToken, updatedParamName, param.questionToken, param.type, param.initializer));
        }
        if (!hasUpdatedParams || bindingAliases.length === 0)
          return fnDecl;
        let body = fnDecl.body;
        const stmts = createArrayBindingAliases(ts11.NodeFlags.Let, bindingAliases);
        if (!ts11.isBlock(body)) {
          stmts.push(ts11.factory.createReturnStatement(ts11.factory.createParenthesizedExpression(body)));
          body = ts11.factory.createBlock(stmts, true);
        } else {
          stmts.push(...body.statements);
          body = ts11.factory.updateBlock(body, stmts);
        }
        switch (fnDecl.kind) {
          case ts11.SyntaxKind.FunctionDeclaration:
            fnDecl = ts11.factory.updateFunctionDeclaration(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts11.SyntaxKind.MethodDeclaration:
            fnDecl = ts11.factory.updateMethodDeclaration(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.questionToken, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts11.SyntaxKind.SetAccessor:
            fnDecl = ts11.factory.updateSetAccessorDeclaration(fnDecl, fnDecl.modifiers, fnDecl.name, updatedParams, body);
            break;
          case ts11.SyntaxKind.Constructor:
            fnDecl = ts11.factory.updateConstructorDeclaration(fnDecl, fnDecl.modifiers, updatedParams, body);
            break;
          case ts11.SyntaxKind.FunctionExpression:
            fnDecl = ts11.factory.updateFunctionExpression(fnDecl, fnDecl.modifiers, fnDecl.asteriskToken, fnDecl.name, fnDecl.typeParameters, updatedParams, fnDecl.type, body);
            break;
          case ts11.SyntaxKind.ArrowFunction:
            fnDecl = ts11.factory.updateArrowFunction(fnDecl, fnDecl.modifiers, fnDecl.name, updatedParams, fnDecl.type, fnDecl.equalsGreaterThanToken, body);
            break;
          case ts11.SyntaxKind.GetAccessor:
            moduleTypeTranslator.error(fnDecl, `get accessors cannot have parameters`);
            break;
          default:
            moduleTypeTranslator.error(fnDecl, `unexpected function like declaration`);
            break;
        }
        return fnDecl;
      }
      function visitThisExpression(node) {
        if (!contextThisType)
          return ts11.visitEachChild(node, visitor, context);
        return createClosureCast(node, node, contextThisType);
      }
      function visitVariableStatement(varStmt) {
        const stmts = [];
        const flags = ts11.getCombinedNodeFlags(varStmt.declarationList);
        let tags = moduleTypeTranslator.getJSDoc(varStmt, true);
        const leading = ts11.getSyntheticLeadingComments(varStmt);
        if (leading) {
          const commentHolder = ts11.factory.createNotEmittedStatement(varStmt);
          ts11.setSyntheticLeadingComments(commentHolder, leading.filter((c) => c.text[0] !== "*"));
          stmts.push(commentHolder);
        }
        const isExported = varStmt.modifiers?.some((modifier) => modifier.kind === ts11.SyntaxKind.ExportKeyword);
        for (const decl of varStmt.declarationList.declarations) {
          const localTags = [];
          if (tags) {
            localTags.push(...tags);
            tags = null;
          }
          if (ts11.isIdentifier(decl.name)) {
            const initializersMarkedAsUnknown = !!decl.initializer && moduleTypeTranslator.isAlwaysUnknownSymbol(decl);
            if (!initializersMarkedAsUnknown && decl.initializer?.kind !== ts11.SyntaxKind.ClassExpression) {
              const typeStr = moduleTypeTranslator.typeToClosure(decl);
              const defineTag = localTags.find(({ tagName }) => tagName === "define");
              if (defineTag) {
                defineTag.type = typeStr;
              } else {
                localTags.push({ tagName: "type", type: typeStr });
              }
            }
          } else if (ts11.isArrayBindingPattern(decl.name)) {
            const aliases = [];
            const updatedBinding = renameArrayBindings(decl.name, aliases);
            if (updatedBinding && aliases.length > 0) {
              const declVisited = ts11.visitNode(decl, visitor, ts11.isVariableDeclaration);
              const newDecl2 = ts11.factory.updateVariableDeclaration(declVisited, updatedBinding, declVisited.exclamationToken, declVisited.type, declVisited.initializer);
              const newStmt2 = ts11.factory.createVariableStatement(varStmt.modifiers?.filter((modifier) => modifier.kind !== ts11.SyntaxKind.ExportKeyword), ts11.factory.createVariableDeclarationList([newDecl2], flags));
              if (localTags.length) {
                addCommentOn(newStmt2, localTags, TAGS_CONFLICTING_WITH_TYPE);
              }
              stmts.push(newStmt2);
              stmts.push(...createArrayBindingAliases(varStmt.declarationList.flags, aliases, isExported));
              continue;
            }
          }
          const newDecl = ts11.setEmitFlags(ts11.visitNode(decl, visitor, ts11.isVariableDeclaration), ts11.EmitFlags.NoComments);
          const newStmt = ts11.factory.createVariableStatement(varStmt.modifiers, ts11.factory.createVariableDeclarationList([newDecl], flags));
          if (localTags.length)
            addCommentOn(newStmt, localTags, TAGS_CONFLICTING_WITH_TYPE);
          stmts.push(newStmt);
        }
        return stmts;
      }
      function shouldEmitExportsAssignments() {
        return tsOptions.module === ts11.ModuleKind.CommonJS;
      }
      function visitTypeAliasDeclaration(typeAlias) {
        const sym = moduleTypeTranslator.mustGetSymbolAtLocation(typeAlias.name);
        if (symbolIsValue(typeChecker, sym))
          return [];
        if (!shouldEmitExportsAssignments())
          return [];
        const typeName = getIdentifierText(typeAlias.name);
        moduleTypeTranslator.newTypeTranslator(typeAlias).markTypeParameterAsUnknown(moduleTypeTranslator.symbolsToAliasedNames, typeAlias.typeParameters);
        const typeStr = host.untyped ? "?" : moduleTypeTranslator.typeToClosure(typeAlias, undefined);
        const tags = moduleTypeTranslator.getJSDoc(typeAlias, true);
        tags.push({ tagName: "typedef", type: typeStr });
        let propertyBase = null;
        if (hasModifierFlag(typeAlias, ts11.ModifierFlags.Export)) {
          propertyBase = "exports";
        }
        const ns = getTransformedNs(typeAlias);
        if (ns !== null && ts11.getOriginalNode(typeAlias).parent.parent === ns && ts11.isIdentifier(ns.name)) {
          propertyBase = getIdentifierText(ns.name);
        }
        let decl;
        if (propertyBase !== null) {
          decl = ts11.factory.createExpressionStatement(ts11.factory.createPropertyAccessExpression(ts11.factory.createIdentifier(propertyBase), ts11.factory.createIdentifier(typeName)));
        } else {
          decl = ts11.factory.createVariableStatement(undefined, ts11.factory.createVariableDeclarationList([
            ts11.factory.createVariableDeclaration(ts11.factory.createIdentifier(typeName))
          ]));
        }
        decl = ts11.setSourceMapRange(decl, typeAlias);
        addCommentOn(decl, tags, TAGS_CONFLICTING_WITH_TYPE);
        return [decl];
      }
      function createClosureCast(context2, expression, type) {
        const inner = ts11.factory.createParenthesizedExpression(expression);
        const comment = addCommentOn(inner, [
          {
            tagName: "type",
            type: moduleTypeTranslator.typeToClosure(context2, type)
          }
        ]);
        comment.hasTrailingNewLine = false;
        return ts11.setSourceMapRange(ts11.factory.createParenthesizedExpression(inner), context2);
      }
      function visitAssertionExpression(assertion) {
        const type = typeChecker.getTypeAtLocation(assertion.type);
        return createClosureCast(assertion, ts11.visitEachChild(assertion, visitor, context), type);
      }
      function visitNonNullExpression(nonNull) {
        if (containsOptionalChainingOperator(nonNull)) {
          return nonNull.expression;
        }
        const type = typeChecker.getTypeAtLocation(nonNull.expression);
        const nonNullType = typeChecker.getNonNullableType(type);
        return createClosureCast(nonNull, ts11.visitEachChild(nonNull, visitor, context), nonNullType);
      }
      function getNarrowedType(node) {
        if (node.kind === ts11.SyntaxKind.SuperKeyword)
          return;
        if (node.kind === ts11.SyntaxKind.ThisKeyword)
          return;
        const symbol = typeChecker.getSymbolAtLocation(node);
        if (symbol?.declarations === undefined || symbol.declarations.length === 0 || symbol.declarations.some((decl) => ts11.isClassDeclaration(decl) || ts11.isInterfaceDeclaration(decl) || ts11.isModuleDeclaration(decl))) {
          return;
        }
        const typeAtUsage = typeChecker.getTypeAtLocation(node);
        const notNullableType = typeChecker.getNonNullableType(typeAtUsage);
        for (const decl of symbol.declarations) {
          const declaredType = typeChecker.getTypeOfSymbolAtLocation(symbol, decl);
          if (typeAtUsage !== declaredType && notNullableType !== typeChecker.getNonNullableType(declaredType) && moduleTypeTranslator.typeToClosure(node, typeAtUsage) !== "?") {
            return typeAtUsage;
          }
        }
        return;
      }
      function visitPropertyAccessExpression(node) {
        if (!emitNarrowedTypes || containsOptionalChainingOperator(node)) {
          return ts11.visitEachChild(node, visitor, context);
        }
        const objType = getNarrowedType(node.expression);
        if (objType === undefined) {
          return ts11.visitEachChild(node, visitor, context);
        }
        const propertyAccessWithCast = ts11.factory.updatePropertyAccessExpression(node, createClosureCast(node.expression, ts11.visitEachChild(node.expression, visitor, context), objType), node.name);
        const propType = getNarrowedType(node);
        if (propType === undefined) {
          return propertyAccessWithCast;
        }
        return createClosureCast(node, propertyAccessWithCast, propType);
      }
      function visitImportDeclaration(importDecl) {
        if (!importDecl.importClause)
          return importDecl;
        const sym = typeChecker.getSymbolAtLocation(importDecl.moduleSpecifier);
        if (!sym)
          return importDecl;
        const importPath = importDecl.moduleSpecifier.text;
        moduleTypeTranslator.requireType(importDecl.moduleSpecifier, importPath, sym, !!importDecl.importClause.name);
        return importDecl;
      }
      function escapeIllegalJSDoc(node) {
        if (!ts11.getParseTreeNode(node))
          return;
        const mjsdoc = moduleTypeTranslator.getMutableJSDoc(node);
        mjsdoc.updateComment(TAGS_CONFLICTING_WITH_TYPE);
      }
      function shouldEmitValueExportForSymbol(sym) {
        if (sym.flags & ts11.SymbolFlags.Alias) {
          sym = typeChecker.getAliasedSymbol(sym);
        }
        if ((sym.flags & ts11.SymbolFlags.Value) === 0) {
          return false;
        }
        if (sym.flags & ts11.SymbolFlags.ConstEnum) {
          if (tsOptions.preserveConstEnums) {
            return !sym.valueDeclaration.getSourceFile().isDeclarationFile;
          } else {
            return false;
          }
        }
        return true;
      }
      function visitExportDeclaration(exportDecl) {
        const importedModuleSymbol = exportDecl.moduleSpecifier && typeChecker.getSymbolAtLocation(exportDecl.moduleSpecifier);
        if (importedModuleSymbol) {
          moduleTypeTranslator.requireType(exportDecl.moduleSpecifier, exportDecl.moduleSpecifier.text, importedModuleSymbol, false);
        }
        const typesToExport = [];
        if (!exportDecl.exportClause) {
          const currentModuleSymbol = typeChecker.getSymbolAtLocation(sourceFile);
          const currentModuleExports = currentModuleSymbol && currentModuleSymbol.exports;
          if (!importedModuleSymbol) {
            moduleTypeTranslator.error(exportDecl, `export * without module symbol`);
            return exportDecl;
          }
          const exportedSymbols = typeChecker.getExportsOfModule(importedModuleSymbol);
          const exportSpecifiers = [];
          for (const sym of exportedSymbols) {
            if (currentModuleExports && currentModuleExports.has(sym.escapedName))
              continue;
            if (expandedStarImports.has(sym.name))
              continue;
            expandedStarImports.add(sym.name);
            if (shouldEmitValueExportForSymbol(sym)) {
              exportSpecifiers.push(ts11.factory.createExportSpecifier(false, undefined, sym.name));
            } else {
              typesToExport.push([sym.name, sym]);
            }
          }
          const isTypeOnlyExport = false;
          exportDecl = ts11.factory.updateExportDeclaration(exportDecl, exportDecl.modifiers, isTypeOnlyExport, ts11.factory.createNamedExports(exportSpecifiers), exportDecl.moduleSpecifier, exportDecl.attributes);
        } else if (ts11.isNamedExports(exportDecl.exportClause)) {
          for (const exp of exportDecl.exportClause.elements) {
            const exportedName = getIdentifierText(exp.name);
            typesToExport.push([
              exportedName,
              moduleTypeTranslator.mustGetSymbolAtLocation(exp.name)
            ]);
          }
        }
        if (host.untyped)
          return exportDecl;
        const result = [exportDecl];
        for (const [exportedName, sym] of typesToExport) {
          let aliasedSymbol = sym;
          if (sym.flags & ts11.SymbolFlags.Alias) {
            aliasedSymbol = typeChecker.getAliasedSymbol(sym);
          }
          const isTypeAlias = (aliasedSymbol.flags & ts11.SymbolFlags.Value) === 0 && (aliasedSymbol.flags & (ts11.SymbolFlags.TypeAlias | ts11.SymbolFlags.Interface)) !== 0;
          const isConstEnum = (aliasedSymbol.flags & ts11.SymbolFlags.ConstEnum) !== 0;
          if (!isTypeAlias && !isConstEnum)
            continue;
          const typeName = moduleTypeTranslator.symbolsToAliasedNames.get(aliasedSymbol) || aliasedSymbol.name;
          const stmt = ts11.factory.createExpressionStatement(ts11.factory.createPropertyAccessExpression(ts11.factory.createIdentifier("exports"), exportedName));
          addCommentOn(stmt, [{ tagName: "typedef", type: "!" + typeName }]);
          ts11.addSyntheticTrailingComment(stmt, ts11.SyntaxKind.SingleLineCommentTrivia, " re-export typedef", true);
          result.push(stmt);
        }
        return result;
      }
      function getExportDeclarationNames(node) {
        switch (node.kind) {
          case ts11.SyntaxKind.VariableStatement:
            const varDecl = node;
            return varDecl.declarationList.declarations.map((d) => getExportDeclarationNames(d)[0]);
          case ts11.SyntaxKind.VariableDeclaration:
          case ts11.SyntaxKind.FunctionDeclaration:
          case ts11.SyntaxKind.InterfaceDeclaration:
          case ts11.SyntaxKind.ClassDeclaration:
          case ts11.SyntaxKind.ModuleDeclaration:
          case ts11.SyntaxKind.EnumDeclaration:
            const decl = node;
            if (!decl.name || decl.name.kind !== ts11.SyntaxKind.Identifier) {
              break;
            }
            return [decl.name];
          case ts11.SyntaxKind.TypeAliasDeclaration:
            const typeAlias = node;
            return [typeAlias.name];
          default:
            break;
        }
        moduleTypeTranslator.error(node, `unsupported export declaration ${ts11.SyntaxKind[node.kind]}: ${node.getText()}`);
        return [];
      }
      function visitExportedAmbient(node) {
        if (host.untyped || !shouldEmitExportsAssignments())
          return [node];
        const declNames = getExportDeclarationNames(node);
        const result = [node];
        for (const decl of declNames) {
          const sym = typeChecker.getSymbolAtLocation(decl);
          if (!symbolIsValue(typeChecker, sym)) {
            if (node.kind === ts11.SyntaxKind.ModuleDeclaration)
              continue;
            const mangledName = moduleNameAsIdentifier(host, sourceFile.fileName);
            const declName = getIdentifierText(decl);
            const stmt = ts11.factory.createExpressionStatement(ts11.factory.createPropertyAccessExpression(ts11.factory.createIdentifier("exports"), declName));
            addCommentOn(stmt, [
              { tagName: "typedef", type: `!${mangledName}.${declName}` }
            ]);
            result.push(stmt);
          }
        }
        return result;
      }
      let aliasCounter = 1;
      function renameArrayBindings(node, aliases) {
        const updatedElements = [];
        for (const e of node.elements) {
          if (ts11.isOmittedExpression(e)) {
            updatedElements.push(e);
            continue;
          } else if (ts11.isObjectBindingPattern(e.name)) {
            return;
          }
          let updatedBindingName;
          if (ts11.isArrayBindingPattern(e.name)) {
            updatedBindingName = renameArrayBindings(e.name, aliases);
            if (!updatedBindingName)
              return;
          } else {
            const aliasName = ts11.factory.createIdentifier(`${e.name.text}__tsickle_destructured_${aliasCounter++}`);
            aliases.push([e.name, aliasName]);
            updatedBindingName = aliasName;
          }
          updatedElements.push(ts11.factory.updateBindingElement(e, e.dotDotDotToken, ts11.visitNode(e.propertyName, visitor, ts11.isPropertyName), updatedBindingName, ts11.visitNode(e.initializer, visitor)));
        }
        return ts11.factory.updateArrayBindingPattern(node, updatedElements);
      }
      function createArrayBindingAliases(flags, aliases, needsExport = false) {
        const aliasDecls = [];
        for (const [oldName, aliasName] of aliases) {
          const typeStr = moduleTypeTranslator.typeToClosure(ts11.getOriginalNode(oldName));
          const closureCastExpr = ts11.factory.createParenthesizedExpression(aliasName);
          addCommentOn(closureCastExpr, [{ tagName: "type", type: typeStr }], undefined, false);
          const varDeclList = ts11.factory.createVariableDeclarationList([
            ts11.factory.createVariableDeclaration(oldName, undefined, undefined, closureCastExpr)
          ], flags);
          const varStmt = ts11.factory.createVariableStatement(needsExport ? [ts11.factory.createModifier(ts11.SyntaxKind.ExportKeyword)] : undefined, varDeclList);
          aliasDecls.push(varStmt);
        }
        return aliasDecls;
      }
      function visitForOfStatement(node) {
        const varDecls = node.initializer;
        if (!ts11.isVariableDeclarationList(varDecls)) {
          return ts11.visitEachChild(node, visitor, context);
        }
        if (varDecls.declarations.length !== 1) {
          return ts11.visitEachChild(node, visitor, context);
        }
        const varDecl = varDecls.declarations[0];
        if (!ts11.isArrayBindingPattern(varDecl.name)) {
          return ts11.visitEachChild(node, visitor, context);
        }
        const aliases = [];
        const updatedPattern = renameArrayBindings(varDecl.name, aliases);
        if (!updatedPattern || aliases.length === 0) {
          return ts11.visitEachChild(node, visitor, context);
        }
        const updatedInitializer = ts11.factory.updateVariableDeclarationList(varDecls, [
          ts11.factory.updateVariableDeclaration(varDecl, updatedPattern, varDecl.exclamationToken, varDecl.type, varDecl.initializer)
        ]);
        const aliasDecls = createArrayBindingAliases(varDecls.flags, aliases);
        let updatedStatement;
        if (ts11.isBlock(node.statement)) {
          updatedStatement = ts11.factory.updateBlock(node.statement, [
            ...aliasDecls,
            ...ts11.visitNode(node.statement, visitor, ts11.isBlock).statements
          ]);
        } else {
          updatedStatement = ts11.factory.createBlock([
            ...aliasDecls,
            ts11.visitNode(node.statement, visitor)
          ]);
        }
        return ts11.factory.updateForOfStatement(node, node.awaitModifier, updatedInitializer, ts11.visitNode(node.expression, visitor), updatedStatement);
      }
      function visitor(node) {
        if (isAmbient(node)) {
          if (!hasModifierFlag(node, ts11.ModifierFlags.Export)) {
            return node;
          }
          return visitExportedAmbient(node);
        }
        switch (node.kind) {
          case ts11.SyntaxKind.ImportDeclaration:
            return visitImportDeclaration(node);
          case ts11.SyntaxKind.ExportDeclaration:
            return visitExportDeclaration(node);
          case ts11.SyntaxKind.ClassDeclaration:
            return visitClassDeclaration(node);
          case ts11.SyntaxKind.InterfaceDeclaration:
            return visitInterfaceDeclaration(node);
          case ts11.SyntaxKind.HeritageClause:
            return visitHeritageClause(node);
          case ts11.SyntaxKind.ArrowFunction:
          case ts11.SyntaxKind.FunctionExpression:
            return ts11.factory.createParenthesizedExpression(visitFunctionLikeDeclaration(node));
          case ts11.SyntaxKind.Constructor:
          case ts11.SyntaxKind.FunctionDeclaration:
          case ts11.SyntaxKind.MethodDeclaration:
          case ts11.SyntaxKind.GetAccessor:
          case ts11.SyntaxKind.SetAccessor:
            return visitFunctionLikeDeclaration(node);
          case ts11.SyntaxKind.ThisKeyword:
            return visitThisExpression(node);
          case ts11.SyntaxKind.VariableStatement:
            return visitVariableStatement(node);
          case ts11.SyntaxKind.ExpressionStatement:
          case ts11.SyntaxKind.PropertyAssignment:
          case ts11.SyntaxKind.PropertyDeclaration:
          case ts11.SyntaxKind.ModuleDeclaration:
          case ts11.SyntaxKind.EnumMember:
          case ts11.SyntaxKind.EnumDeclaration:
            escapeIllegalJSDoc(node);
            break;
          case ts11.SyntaxKind.Parameter:
            const paramDecl = node;
            if (hasModifierFlag(paramDecl, ts11.ModifierFlags.ParameterPropertyModifier)) {
              ts11.setSyntheticLeadingComments(paramDecl, []);
              suppressLeadingCommentsRecursively(paramDecl);
            }
            break;
          case ts11.SyntaxKind.TypeAliasDeclaration:
            return visitTypeAliasDeclaration(node);
          case ts11.SyntaxKind.AsExpression:
          case ts11.SyntaxKind.TypeAssertionExpression:
            return visitAssertionExpression(node);
          case ts11.SyntaxKind.NonNullExpression:
            return visitNonNullExpression(node);
          case ts11.SyntaxKind.PropertyAccessExpression:
            return visitPropertyAccessExpression(node);
          case ts11.SyntaxKind.ForOfStatement:
            return visitForOfStatement(node);
          case ts11.SyntaxKind.DeleteExpression:
            emitNarrowedTypes = false;
            const visited = ts11.visitEachChild(node, visitor, context);
            emitNarrowedTypes = true;
            return visited;
          default:
            break;
        }
        return ts11.visitEachChild(node, visitor, context);
      }
      sourceFile = ts11.visitEachChild(sourceFile, visitor, context);
      return moduleTypeTranslator.insertAdditionalImports(sourceFile);
    };
  };
}

// src/tsickle/externs.ts
var PREDECLARED_CLOSURE_EXTERNS_LIST = [
  "exports",
  "global",
  "module",
  "ErrorConstructor",
  "Symbol",
  "WorkerGlobalScope"
];
var EXTERNS_HEADER = `/**
 * @externs
 * @suppress {checkTypes,const,duplicate,missingOverride}
 */
// NOTE: generated by tsickle, do not edit.
`;
function getGeneratedExterns(externs, rootDir) {
  let allExterns = EXTERNS_HEADER;
  for (const fileName of Object.keys(externs)) {
    const srcPath = relative(rootDir, fileName);
    allExterns += `// ${createGeneratedFromComment(srcPath)}
`;
    allExterns += externs[fileName].output;
  }
  return allExterns;
}
function isInGlobalAugmentation(declaration) {
  if (!declaration.parent || !declaration.parent.parent)
    return false;
  return (declaration.parent.parent.flags & ts12.NodeFlags.GlobalAugmentation) !== 0;
}
function generateExterns(typeChecker, sourceFile, host) {
  let output = "";
  const diagnostics = [];
  const isDts = isDtsFileName(sourceFile.fileName);
  const isExternalModule3 = ts12.isExternalModule(sourceFile);
  let moduleNamespace = "";
  if (isExternalModule3) {
    moduleNamespace = moduleNameAsIdentifier(host, sourceFile.fileName);
  }
  let rootNamespace = moduleNamespace;
  const exportAssignment = sourceFile.statements.find(ts12.isExportAssignment);
  const hasExportEquals = exportAssignment && exportAssignment.isExportEquals;
  if (hasExportEquals) {
    rootNamespace = rootNamespace + "_";
  }
  const mtt = new ModuleTypeTranslator(sourceFile, typeChecker, host, diagnostics, true, hasExportEquals);
  for (const stmt of sourceFile.statements) {
    importsVisitor(stmt);
    if (!isDts && !hasModifierFlag(stmt, ts12.ModifierFlags.Ambient)) {
      continue;
    }
    visitor(stmt, []);
  }
  function qualifiedNameToMangledIdentifier(name) {
    const entityName = getEntityNameText(name);
    let symbol = typeChecker.getSymbolAtLocation(name);
    if (symbol) {
      if (symbol.flags & ts12.SymbolFlags.Alias) {
        symbol = typeChecker.getAliasedSymbol(symbol);
      }
      const alias = mtt.symbolsToAliasedNames.get(symbol);
      if (alias)
        return alias;
      const isGlobalSymbol = symbol && symbol.declarations && symbol.declarations.some((d) => {
        if (isInGlobalAugmentation(d))
          return true;
        return !ts12.isExternalModule(d.getSourceFile());
      });
      if (isGlobalSymbol)
        return entityName;
    }
    return rootNamespace + "." + entityName;
  }
  if (output && isExternalModule3) {
    output = `/** @const */
var ${rootNamespace} = {};
` + output;
    let exportedNamespace = rootNamespace;
    if (exportAssignment && hasExportEquals) {
      if (ts12.isIdentifier(exportAssignment.expression) || ts12.isQualifiedName(exportAssignment.expression)) {
        exportedNamespace = qualifiedNameToMangledIdentifier(exportAssignment.expression);
      } else {
        reportDiagnostic(diagnostics, exportAssignment.expression, `export = expression must be a qualified name, got ${ts12.SyntaxKind[exportAssignment.expression.kind]}.`);
      }
      emit(`/**
 * export = ${exportAssignment.expression.getText()}
 * @const
 */
`);
      emit(`var ${moduleNamespace} = ${exportedNamespace};
`);
    }
    if (isDts && host.provideExternalModuleDtsNamespace) {
      for (const nsExport of sourceFile.statements.filter(ts12.isNamespaceExportDeclaration)) {
        const namespaceName = getIdentifierText(nsExport.name);
        emit(`// export as namespace ${namespaceName}
`);
        writeVariableStatement(namespaceName, [], exportedNamespace);
      }
    }
  }
  return { diagnostics, moduleNamespace, output };
  function emit(str) {
    output += str;
  }
  function isFirstValueDeclaration(decl) {
    if (!decl.name)
      return true;
    const sym = typeChecker.getSymbolAtLocation(decl.name);
    if (!sym.declarations || sym.declarations.length < 2)
      return true;
    const earlierDecls = sym.declarations.slice(0, sym.declarations.indexOf(decl));
    return earlierDecls.length === 0 || earlierDecls.every((d) => ts12.isVariableDeclaration(d) && d.getSourceFile() !== decl.getSourceFile());
  }
  function writeVariableStatement(name, namespace, value) {
    const qualifiedName = namespace.concat([name]).join(".");
    if (namespace.length === 0)
      emit(`var `);
    emit(qualifiedName);
    if (value)
      emit(` = ${value}`);
    emit(`;
`);
  }
  function writeVariableDeclaration(decl, namespace) {
    if (decl.name.kind === ts12.SyntaxKind.Identifier) {
      const name = getIdentifierText(decl.name);
      if (PREDECLARED_CLOSURE_EXTERNS_LIST.indexOf(name) >= 0)
        return;
      emit(toString([{ tagName: "type", type: mtt.typeToClosure(decl) }]));
      emit(`
`);
      writeVariableStatement(name, namespace);
    } else {
      errorUnimplementedKind(decl.name, "externs for variable");
    }
  }
  function emitFunctionType(decls, extraTags = []) {
    const { parameterNames, tags } = mtt.getFunctionTypeJSDoc(decls, extraTags);
    emit(`
`);
    emit(toString(tags));
    return parameterNames;
  }
  function writeFunction(name, params, namespace) {
    const paramsStr = params.join(", ");
    if (namespace.length > 0) {
      let fqn = namespace.join(".");
      if (name.kind === ts12.SyntaxKind.Identifier) {
        fqn += ".";
      }
      fqn += name.getText();
      emit(`${fqn} = function(${paramsStr}) {};
`);
    } else {
      if (name.kind !== ts12.SyntaxKind.Identifier) {
        reportDiagnostic(diagnostics, name, "Non-namespaced computed name in externs");
      }
      emit(`function ${name.getText()}(${paramsStr}) {}
`);
    }
  }
  function writeEnum(decl, namespace) {
    const name = getIdentifierText(decl.name);
    let members = "";
    const enumType = getEnumType(typeChecker, decl);
    const initializer = enumType === "string" ? `''` : 1;
    for (const member of decl.members) {
      let memberName;
      switch (member.name.kind) {
        case ts12.SyntaxKind.Identifier:
          memberName = getIdentifierText(member.name);
          break;
        case ts12.SyntaxKind.StringLiteral:
          const text = member.name.text;
          if (isValidClosurePropertyName(text))
            memberName = text;
          break;
        default:
          break;
      }
      if (!memberName) {
        members += `  /* TODO: ${ts12.SyntaxKind[member.name.kind]}: ${escapeForComment(member.name.getText())} */
`;
        continue;
      }
      members += `  ${memberName}: ${initializer},
`;
    }
    emit(`
/** @enum {${enumType}} */
`);
    writeVariableStatement(name, namespace, `{
${members}}`);
  }
  function handleLostProperties(decl, namespace) {
    let propNames = undefined;
    function collectPropertyNames(node) {
      if (ts12.isTypeLiteralNode(node)) {
        for (const m of node.members) {
          if (m.name && ts12.isIdentifier(m.name)) {
            propNames = propNames || new Set;
            propNames.add(getIdentifierText(m.name));
          }
        }
      }
      ts12.forEachChild(node, collectPropertyNames);
    }
    function findTypeIntersection(node) {
      if (ts12.isIntersectionTypeNode(node)) {
        ts12.forEachChild(node, collectPropertyNames);
      } else {
        ts12.forEachChild(node, findTypeIntersection);
      }
    }
    ts12.forEachChild(decl, findTypeIntersection);
    if (propNames) {
      const helperName = getIdentifierText(decl.name) + "_preventPropRenaming_doNotUse";
      emit(`
/** @typedef {{${[...propNames].map((p) => `${p}: ?`).join(", ")}}} */
`);
      writeVariableStatement(helperName, namespace);
    }
  }
  function writeTypeAlias(decl, namespace) {
    const typeStr = mtt.typeToClosure(decl, undefined);
    emit(`
/** @typedef {${typeStr}} */
`);
    writeVariableStatement(getIdentifierText(decl.name), namespace);
    handleLostProperties(decl, namespace);
  }
  function writeType(decl, namespace) {
    const name = decl.name;
    if (!name) {
      reportDiagnostic(diagnostics, decl, "anonymous type in externs");
      return;
    }
    if (name.escapedText === "gbigint" && decl.getSourceFile().fileName.endsWith("closure.lib.d.ts")) {
      return;
    }
    const typeName = namespace.concat([name.getText()]).join(".");
    if (PREDECLARED_CLOSURE_EXTERNS_LIST.indexOf(typeName) >= 0)
      return;
    if (isFirstValueDeclaration(decl)) {
      let paramNames = [];
      const jsdocTags = [];
      let wroteJsDoc = false;
      maybeAddHeritageClauses(jsdocTags, mtt, decl);
      maybeAddTemplateClause(jsdocTags, decl);
      if (decl.kind === ts12.SyntaxKind.ClassDeclaration) {
        jsdocTags.push({ tagName: "constructor" }, { tagName: "struct" });
        const ctors = getCtors(decl);
        if (ctors.length) {
          paramNames = emitFunctionType(ctors, jsdocTags);
          wroteJsDoc = true;
        }
      } else {
        jsdocTags.push({ tagName: "record" }, { tagName: "struct" });
      }
      if (!wroteJsDoc)
        emit(toString(jsdocTags));
      writeFunction(name, paramNames, namespace);
    }
    const methods = new Map;
    const accessors = new Map;
    for (const member of decl.members) {
      switch (member.kind) {
        case ts12.SyntaxKind.PropertySignature:
        case ts12.SyntaxKind.PropertyDeclaration:
          const prop = member;
          if (prop.name.kind === ts12.SyntaxKind.Identifier) {
            let type = mtt.typeToClosure(prop);
            if (prop.questionToken && type === "?") {
              type = "?|undefined";
            }
            const isReadonly = hasModifierFlag(prop, ts12.ModifierFlags.Readonly);
            emit(toString([
              { tagName: isReadonly ? "const" : "type", type }
            ]));
            if (hasModifierFlag(prop, ts12.ModifierFlags.Static)) {
              emit(`
${typeName}.${prop.name.getText()};
`);
            } else {
              emit(`
${typeName}.prototype.${prop.name.getText()};
`);
            }
            continue;
          }
          break;
        case ts12.SyntaxKind.GetAccessor:
        case ts12.SyntaxKind.SetAccessor:
          const accessor = member;
          if (accessor.name.kind === ts12.SyntaxKind.Identifier) {
            const name2 = accessor.name.getText();
            if (!accessors.has(name2) || accessor.kind === ts12.SyntaxKind.GetAccessor) {
              accessors.set(name2, accessor);
            }
            continue;
          }
          break;
        case ts12.SyntaxKind.MethodSignature:
        case ts12.SyntaxKind.MethodDeclaration:
          const method = member;
          const isStatic = hasModifierFlag(method, ts12.ModifierFlags.Static);
          const methodSignature = `${method.name.getText()}$$$${isStatic ? "static" : "instance"}`;
          if (methods.has(methodSignature)) {
            methods.get(methodSignature).push(method);
          } else {
            methods.set(methodSignature, [method]);
          }
          continue;
        case ts12.SyntaxKind.Constructor:
          continue;
        default:
          break;
      }
      let memberName = namespace;
      if (member.name) {
        memberName = memberName.concat([member.name.getText()]);
      }
      emit(`
/* TODO: ${ts12.SyntaxKind[member.kind]}: ${memberName.join(".")} */
`);
    }
    for (const [name2, accessor] of accessors.entries()) {
      const type = mtt.typeToClosure(accessor);
      emit(toString([{ tagName: "type", type }]));
      if (hasModifierFlag(accessor, ts12.ModifierFlags.Static)) {
        emit(`
${typeName}.${name2};
`);
      } else {
        emit(`
${typeName}.prototype.${name2};
`);
      }
    }
    for (const methodVariants of Array.from(methods.values())) {
      const firstMethodVariant = methodVariants[0];
      let parameterNames;
      if (methodVariants.length > 1) {
        parameterNames = emitFunctionType(methodVariants);
      } else {
        parameterNames = emitFunctionType([firstMethodVariant]);
      }
      const methodNamespace = namespace.concat([name.getText()]);
      if (!hasModifierFlag(firstMethodVariant, ts12.ModifierFlags.Static)) {
        methodNamespace.push("prototype");
      }
      writeFunction(firstMethodVariant.name, parameterNames, methodNamespace);
    }
  }
  function writeExportDeclaration(exportDeclaration, namespace) {
    if (!exportDeclaration.exportClause) {
      emit(`
// TODO(tsickle): export * declaration in ${debugLocationStr(exportDeclaration, namespace)}
`);
      return;
    }
    if (ts12.isNamespaceExport(exportDeclaration.exportClause)) {
      emit(`
// TODO(tsickle): export * as declaration in ${debugLocationStr(exportDeclaration, namespace)}
`);
      return;
    }
    for (const exportSpecifier of exportDeclaration.exportClause.elements) {
      if (!exportSpecifier.propertyName)
        continue;
      emit(`/** @const */
`);
      writeVariableStatement(exportSpecifier.name.text, namespace, namespace.join(".") + "." + exportSpecifier.propertyName.text);
    }
  }
  function getCtors(decl) {
    const currentCtors = decl.members.filter((m) => m.kind === ts12.SyntaxKind.Constructor);
    if (currentCtors.length) {
      return currentCtors;
    }
    if (decl.heritageClauses) {
      const baseSymbols = decl.heritageClauses.filter((h) => h.token === ts12.SyntaxKind.ExtendsKeyword).flatMap((h) => h.types).filter((t3) => t3.expression.kind === ts12.SyntaxKind.Identifier);
      for (const base of baseSymbols) {
        const sym = typeChecker.getSymbolAtLocation(base.expression);
        if (!sym || !sym.declarations)
          return [];
        for (const d of sym.declarations) {
          if (d.kind === ts12.SyntaxKind.ClassDeclaration) {
            return getCtors(d);
          }
        }
      }
    }
    return [];
  }
  function addImportAliases(decl) {
    if (ts12.isImportDeclaration(decl) && !decl.importClause)
      return;
    let moduleUri;
    if (ts12.isImportDeclaration(decl)) {
      moduleUri = decl.moduleSpecifier;
    } else if (ts12.isExternalModuleReference(decl.moduleReference)) {
      moduleUri = decl.moduleReference.expression;
    } else {
      return;
    }
    const importDiagnostics = isDts ? diagnostics : [];
    const moduleSymbol = typeChecker.getSymbolAtLocation(moduleUri);
    if (!moduleSymbol) {
      reportDiagnostic(importDiagnostics, moduleUri, `imported module has no symbol`);
      return;
    }
    const googNamespace = jsPathToNamespace(host, moduleUri, importDiagnostics, moduleUri.text, () => moduleSymbol);
    const isDefaultImport = ts12.isImportDeclaration(decl) && !!decl.importClause?.name;
    if (googNamespace) {
      mtt.registerImportSymbolAliases(googNamespace, isDefaultImport, moduleSymbol, () => googNamespace);
    } else {
      mtt.registerImportSymbolAliases(undefined, isDefaultImport, moduleSymbol, getAliasPrefixForEsModule(moduleUri));
    }
  }
  function getAliasPrefixForEsModule(moduleUri) {
    const ambientModulePrefix = moduleNameAsIdentifier(host, moduleUri.text, sourceFile.fileName);
    const defaultPrefix = host.pathToModuleName(sourceFile.fileName, moduleUri.text);
    return (exportedSymbol) => {
      const isAmbientModuleDeclaration = exportedSymbol.declarations && exportedSymbol.declarations.some((d) => isAmbient(d) || d.getSourceFile().isDeclarationFile);
      return isAmbientModuleDeclaration ? ambientModulePrefix : defaultPrefix;
    };
  }
  function errorUnimplementedKind(node, where) {
    reportDiagnostic(diagnostics, node, `${ts12.SyntaxKind[node.kind]} not implemented in ${where}`);
  }
  function getNamespaceForTopLevelDeclaration(declaration, namespace) {
    if (namespace.length !== 0)
      return namespace;
    if (isDts && isExternalModule3)
      return [rootNamespace];
    if (hasModifierFlag(declaration, ts12.ModifierFlags.Export))
      return [rootNamespace];
    return [];
  }
  function debugLocationStr(node, namespace) {
    return namespace.join(".") || node.getSourceFile().fileName.replace(/.*[/\\]/, "");
  }
  function importsVisitor(node) {
    switch (node.kind) {
      case ts12.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node;
        if (importEquals.moduleReference.kind === ts12.SyntaxKind.ExternalModuleReference) {
          addImportAliases(importEquals);
        }
        break;
      case ts12.SyntaxKind.ImportDeclaration:
        addImportAliases(node);
        break;
      default:
        break;
    }
  }
  function visitor(node, namespace) {
    if (node.parent === sourceFile) {
      namespace = getNamespaceForTopLevelDeclaration(node, namespace);
    }
    switch (node.kind) {
      case ts12.SyntaxKind.ModuleDeclaration:
        const decl = node;
        switch (decl.name.kind) {
          case ts12.SyntaxKind.Identifier:
            if (decl.flags & ts12.NodeFlags.GlobalAugmentation) {
              namespace = [];
            } else {
              const name2 = getIdentifierText(decl.name);
              if (isFirstValueDeclaration(decl)) {
                emit(`/** @const */
`);
                writeVariableStatement(name2, namespace, "{}");
              }
              namespace = namespace.concat(name2);
            }
            if (decl.body)
              visitor(decl.body, namespace);
            break;
          case ts12.SyntaxKind.StringLiteral:
            const importName = decl.name.text;
            const mangled = moduleNameAsIdentifier(host, importName, sourceFile.fileName);
            emit(`// Derived from: declare module "${importName}"
`);
            namespace = [mangled];
            if (isFirstValueDeclaration(decl)) {
              emit(`/** @const */
`);
              writeVariableStatement(mangled, [], "{}");
            }
            if (decl.body)
              visitor(decl.body, [mangled]);
            break;
          default:
            errorUnimplementedKind(decl.name, "externs generation of namespace");
            break;
        }
        break;
      case ts12.SyntaxKind.ModuleBlock:
        const block = node;
        for (const stmt of block.statements) {
          visitor(stmt, namespace);
        }
        break;
      case ts12.SyntaxKind.ImportEqualsDeclaration:
        const importEquals = node;
        if (importEquals.moduleReference.kind === ts12.SyntaxKind.ExternalModuleReference) {
          break;
        }
        const localName = getIdentifierText(importEquals.name);
        const qn = qualifiedNameToMangledIdentifier(importEquals.moduleReference);
        emit(`/** @const */
`);
        writeVariableStatement(localName, namespace, qn);
        break;
      case ts12.SyntaxKind.ClassDeclaration:
      case ts12.SyntaxKind.InterfaceDeclaration:
        writeType(node, namespace);
        break;
      case ts12.SyntaxKind.FunctionDeclaration:
        const fnDecl = node;
        const name = fnDecl.name;
        if (!name) {
          reportDiagnostic(diagnostics, fnDecl, "anonymous function in externs");
          break;
        }
        const sym = typeChecker.getSymbolAtLocation(name);
        const decls = sym.declarations.filter(ts12.isFunctionDeclaration);
        if (fnDecl !== decls[0])
          break;
        const params = emitFunctionType(decls);
        writeFunction(name, params, namespace);
        break;
      case ts12.SyntaxKind.VariableStatement:
        for (const decl2 of node.declarationList.declarations) {
          writeVariableDeclaration(decl2, namespace);
        }
        break;
      case ts12.SyntaxKind.EnumDeclaration:
        writeEnum(node, namespace);
        break;
      case ts12.SyntaxKind.TypeAliasDeclaration:
        writeTypeAlias(node, namespace);
        break;
      case ts12.SyntaxKind.ImportDeclaration:
        break;
      case ts12.SyntaxKind.NamespaceExportDeclaration:
      case ts12.SyntaxKind.ExportAssignment:
        break;
      case ts12.SyntaxKind.ExportDeclaration:
        const exportDeclaration = node;
        writeExportDeclaration(exportDeclaration, namespace);
        break;
      default:
        emit(`
// TODO(tsickle): ${ts12.SyntaxKind[node.kind]} in ${debugLocationStr(node, namespace)}
`);
        break;
    }
  }
}

// src/tsickle/fileoverview_comment_transformer.ts
var ts13 = __toESM(require("typescript"));
var FILEOVERVIEW_COMMENT_MARKERS = new Set([
  "fileoverview",
  "externs",
  "modName",
  "mods",
  "pintomodule"
]);
function augmentFileoverviewComments(options, source, tags, generateExtraSuppressions) {
  let fileOverview = tags.find((t3) => t3.tagName === "fileoverview");
  if (!fileOverview) {
    fileOverview = { tagName: "fileoverview", text: "added by tsickle" };
    tags.splice(0, 0, fileOverview);
  }
  if (options.rootDir != null) {
    const GENERATED_FROM_COMMENT_TEXT = `
${createGeneratedFromComment(relative(options.rootDir, source.fileName))}`;
    fileOverview.text = fileOverview.text ? fileOverview.text + GENERATED_FROM_COMMENT_TEXT : GENERATED_FROM_COMMENT_TEXT;
  }
  if (generateExtraSuppressions) {
    const suppressions = [
      "checkTypes",
      "extraRequire",
      "missingRequire",
      "uselessCode",
      "suspiciousCode",
      "missingReturn",
      "unusedPrivateMembers",
      "missingOverride",
      "const"
    ];
    const suppressTags = suppressions.map((s) => ({
      tagName: "suppress",
      text: "added by tsickle",
      type: s
    }));
    const licenseTagIndex = tags.findIndex((t3) => t3.tagName === "license");
    if (licenseTagIndex !== -1) {
      tags.splice(licenseTagIndex, 0, ...suppressTags);
    } else {
      tags.push(...suppressTags);
    }
  }
}
function transformFileoverviewCommentFactory(options, diagnostics, generateExtraSuppressions) {
  return () => {
    function checkNoFileoverviewComments(context, comments, message) {
      for (const comment of comments) {
        const parse3 = parse2(comment);
        if (parse3 !== null && parse3.tags.some((t3) => FILEOVERVIEW_COMMENT_MARKERS.has(t3.tagName))) {
          reportDiagnostic(diagnostics, context, message, comment.originalRange, ts13.DiagnosticCategory.Warning);
        }
      }
    }
    return (sourceFile) => {
      if (!sourceFile.fileName.match(/\.tsx?$/)) {
        return sourceFile;
      }
      const text = sourceFile.getFullText();
      let fileComments = [];
      const firstStatement = sourceFile.statements.length && sourceFile.statements[0] || null;
      const originalComments = ts13.getLeadingCommentRanges(text, 0) || [];
      if (!firstStatement) {
        fileComments = synthesizeCommentRanges(sourceFile, originalComments);
      } else {
        for (let i = originalComments.length - 1;i >= 0; i--) {
          const end = originalComments[i].end;
          if (!text.substring(end).startsWith(`

`) && !text.substring(end).startsWith(`\r
\r
`)) {
            continue;
          }
          const synthesizedComments = synthesizeLeadingComments(firstStatement);
          fileComments = synthesizedComments.splice(0, i + 1);
          break;
        }
      }
      const notEmitted = ts13.factory.createNotEmittedStatement(sourceFile);
      ts13.setSyntheticLeadingComments(notEmitted, fileComments);
      sourceFile = updateSourceFileNode(sourceFile, ts13.factory.createNodeArray([notEmitted, ...sourceFile.statements]));
      for (let i = 0;i < sourceFile.statements.length; i++) {
        const stmt = sourceFile.statements[i];
        if (i === 0 && stmt.kind === ts13.SyntaxKind.NotEmittedStatement) {
          continue;
        }
        const comments = synthesizeLeadingComments(stmt);
        checkNoFileoverviewComments(stmt, comments, `file comments must be at the top of the file, ` + `separated from the file body by an empty line.`);
      }
      let fileoverviewIdx = -1;
      let tags = [];
      for (let i = fileComments.length - 1;i >= 0; i--) {
        const parsed = parse2(fileComments[i]);
        if (parsed !== null && parsed.tags.some((t3) => FILEOVERVIEW_COMMENT_MARKERS.has(t3.tagName))) {
          fileoverviewIdx = i;
          tags = parsed.tags;
          break;
        }
      }
      const mutableJsDoc = new MutableJSDoc(notEmitted, fileComments, fileoverviewIdx, tags);
      if (fileoverviewIdx !== -1) {
        checkNoFileoverviewComments(firstStatement || sourceFile, fileComments.slice(0, fileoverviewIdx), `duplicate file level comment`);
      }
      augmentFileoverviewComments(options, sourceFile, mutableJsDoc.tags, generateExtraSuppressions);
      mutableJsDoc.updateComment();
      return sourceFile;
    };
  };
}

// src/tsickle/modules_manifest.ts
class ModulesManifest {
  moduleToFileName = {};
  referencedModules = {};
  addManifest(other) {
    Object.assign(this.moduleToFileName, other.moduleToFileName);
    Object.assign(this.referencedModules, other.referencedModules);
  }
  addModule(fileName, module2) {
    this.moduleToFileName[module2] = fileName;
    this.referencedModules[fileName] = [];
  }
  addReferencedModule(fileName, resolvedModule) {
    this.referencedModules[fileName].push(resolvedModule);
  }
  get fileNames() {
    return Object.keys(this.referencedModules);
  }
  getFileNameFromModule(module2) {
    return this.moduleToFileName[module2];
  }
  getReferencedModules(fileName) {
    return this.referencedModules[fileName];
  }
  get modules() {
    return Object.keys(this.moduleToFileName);
  }
}

// src/tsickle/ns_transformer.ts
var ts14 = __toESM(require("typescript"));
function namespaceTransformer(host, tsOptions, typeChecker, diagnostics) {
  return (context) => {
    return (sourceFile) => {
      let haveTransformedNs = false;
      let haveSeenError = false;
      const transformedStmts = [];
      for (const stmt of sourceFile.statements) {
        visitTopLevelStatement(stmt);
      }
      if (haveSeenError || !haveTransformedNs) {
        return sourceFile;
      }
      return ts14.factory.updateSourceFile(sourceFile, ts14.setTextRange(ts14.factory.createNodeArray(transformedStmts), sourceFile.statements));
      function transformNamespace(ns, mergedDecl) {
        if (!ns.body || !ts14.isModuleBlock(ns.body)) {
          if (ts14.isModuleDeclaration(ns)) {
            error(ns.name, "nested namespaces are not supported.  (go/ts-merged-namespaces)");
          }
          return [ns];
        }
        const nsName = getIdentifierText(ns.name);
        const mergingWithEnum = ts14.isEnumDeclaration(mergedDecl);
        const transformedNsStmts = [];
        for (const stmt of ns.body.statements) {
          if (ts14.isEmptyStatement(stmt))
            continue;
          if (ts14.isClassDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "class");
              continue;
            }
            transformInnerDeclaration(stmt, (classDecl, notExported, hoistedIdent) => {
              return ts14.factory.updateClassDeclaration(classDecl, notExported, hoistedIdent, classDecl.typeParameters, classDecl.heritageClauses, classDecl.members);
            });
          } else if (ts14.isEnumDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "enum");
              continue;
            }
            transformInnerDeclaration(stmt, (enumDecl, notExported, hoistedIdent) => {
              return ts14.factory.updateEnumDeclaration(enumDecl, notExported, hoistedIdent, enumDecl.members);
            });
          } else if (ts14.isInterfaceDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "interface");
              continue;
            }
            transformInnerDeclaration(stmt, (interfDecl, notExported, hoistedIdent) => {
              return ts14.factory.updateInterfaceDeclaration(interfDecl, notExported, hoistedIdent, interfDecl.typeParameters, interfDecl.heritageClauses, interfDecl.members);
            });
          } else if (ts14.isTypeAliasDeclaration(stmt)) {
            if (mergingWithEnum) {
              errorNotAllowed(stmt, "type alias");
              continue;
            }
            transformTypeAliasDeclaration(stmt);
          } else if (ts14.isVariableStatement(stmt)) {
            if ((ts14.getCombinedNodeFlags(stmt.declarationList) & ts14.NodeFlags.Const) === 0) {
              error(stmt, "non-const values are not supported. (go/ts-merged-namespaces)");
              continue;
            }
            if (!ts14.isInterfaceDeclaration(mergedDecl)) {
              error(stmt, "const declaration only allowed when merging with an interface (go/ts-merged-namespaces)");
              continue;
            }
            transformConstDeclaration(stmt);
          } else if (ts14.isFunctionDeclaration(stmt)) {
            if (!ts14.isEnumDeclaration(mergedDecl)) {
              error(stmt, "function declaration only allowed when merging with an enum (go/ts-merged-namespaces)");
            }
            transformInnerDeclaration(stmt, (funcDecl, notExported, hoistedIdent) => {
              return ts14.factory.updateFunctionDeclaration(funcDecl, notExported, funcDecl.asteriskToken, hoistedIdent, funcDecl.typeParameters, funcDecl.parameters, funcDecl.type, funcDecl.body);
            });
          } else {
            error(stmt, `unsupported statement in declaration merging namespace '${nsName}' (go/ts-merged-namespaces)`);
          }
        }
        if (haveSeenError) {
          return [ns];
        }
        markAsMergedDeclaration(ns);
        markAsMergedDeclaration(mergedDecl);
        haveTransformedNs = true;
        transformedNsStmts.push(ts14.factory.createNotEmittedStatement(ns));
        return transformedNsStmts;
        function errorNotAllowed(stmt, declKind) {
          error(stmt, `${declKind} cannot be merged with enum declaration. (go/ts-merged-namespaces)`);
        }
        function transformConstDeclaration(varDecl) {
          for (let decl of varDecl.declarationList.declarations) {
            if (!decl.name || !ts14.isIdentifier(decl.name)) {
              error(decl, "Destructuring declarations are not supported. (go/ts-merged-namespaces)");
              return;
            }
            const originalName = getIdentifierText(decl.name);
            if (!hasModifierFlag(decl, ts14.ModifierFlags.Export)) {
              error(decl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
              return;
            }
            decl = fixReferences(decl);
            if (!decl.initializer) {
              error(decl, `'${originalName}' must have an initializer`);
              return;
            }
            transformedNsStmts.push(createInnerNameAlias(originalName, decl.initializer, varDecl));
          }
        }
        function transformTypeAliasDeclaration(aliasDecl) {
          const originalName = getIdentifierText(aliasDecl.name);
          if (!hasModifierFlag(aliasDecl, ts14.ModifierFlags.Export)) {
            error(aliasDecl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
          }
          aliasDecl = fixReferences(aliasDecl);
          const notExported = ts14.factory.createModifiersFromModifierFlags(ts14.getCombinedModifierFlags(aliasDecl) & ~ts14.ModifierFlags.Export);
          aliasDecl = ts14.factory.updateTypeAliasDeclaration(aliasDecl, notExported, aliasDecl.name, aliasDecl.typeParameters, aliasDecl.type);
          transformedNsStmts.push(aliasDecl);
        }
        function transformInnerDeclaration(decl, updateDecl) {
          if (!decl.name || !ts14.isIdentifier(decl.name)) {
            error(decl, "Anonymous declaration cannot be merged. (go/ts-merged-namespaces)");
            return;
          }
          const originalName = getIdentifierText(decl.name);
          if (!hasModifierFlag(decl, ts14.ModifierFlags.Export)) {
            error(decl, `'${originalName}' must be exported. (go/ts-merged-namespaces)`);
          }
          decl = fixReferences(decl);
          const hoistedName = `${nsName}$${originalName}`;
          const hoistedIdent = ts14.factory.createIdentifier(hoistedName);
          ts14.setOriginalNode(hoistedIdent, decl.name);
          const notExported = ts14.factory.createModifiersFromModifierFlags(ts14.getCombinedModifierFlags(decl) & ~ts14.ModifierFlags.Export);
          const hoistedDecl = updateDecl(decl, notExported, hoistedIdent);
          transformedNsStmts.push(hoistedDecl);
          const aliasProp = createInnerNameAlias(originalName, hoistedIdent, decl);
          ts14.setEmitFlags(aliasProp, ts14.EmitFlags.NoLeadingComments);
          transformedNsStmts.push(aliasProp);
        }
        function createInnerNameAlias(propName, initializer, original) {
          const prop = ts14.factory.createExpressionStatement(ts14.factory.createAssignment(ts14.factory.createPropertyAccessExpression(mergedDecl.name, propName), initializer));
          ts14.setTextRange(prop, original);
          ts14.setOriginalNode(prop, original);
          const jsDoc = getMutableJSDoc(prop, diagnostics, sourceFile);
          jsDoc.tags.push({ tagName: "const" });
          jsDoc.updateComment();
          return prop;
        }
        function isNamespaceRef(ident) {
          const sym = typeChecker.getSymbolAtLocation(ident);
          const parent = sym && sym.parent;
          if (parent && (parent.flags & ts14.SymbolFlags.Module) !== 0) {
            const parentName = parent.getName();
            if (parentName === nsName) {
              return true;
            }
          }
          return false;
        }
        function maybeFixIdentifier(ident) {
          if (isNamespaceRef(ident)) {
            const nsIdentifier = ts14.factory.createIdentifier(nsName);
            const nsProp = ts14.factory.createPropertyAccessExpression(nsIdentifier, ident);
            ts14.setOriginalNode(nsProp, ident);
            ts14.setTextRange(nsProp, ident);
            return nsProp;
          }
          return ident;
        }
        function maybeFixPropertyAccess(prop) {
          if (ts14.isPropertyAccessExpression(prop.expression)) {
            const updatedProp = maybeFixPropertyAccess(prop.expression);
            if (updatedProp !== prop.expression) {
              return ts14.factory.updatePropertyAccessExpression(prop, updatedProp, prop.name);
            }
            return prop;
          }
          if (!ts14.isIdentifier(prop.expression)) {
            return prop;
          }
          const nsProp = maybeFixIdentifier(prop.expression);
          if (nsProp !== prop.expression) {
            const newPropAccess = ts14.factory.updatePropertyAccessExpression(prop, nsProp, prop.name);
            return newPropAccess;
          }
          return prop;
        }
        function fixReferences(node) {
          const rootNode = node;
          function refCheckVisitor(node2) {
            if (ts14.isTypeReferenceNode(node2) || ts14.isTypeQueryNode(node2)) {
              return node2;
            }
            if (ts14.isPropertyAccessExpression(node2)) {
              return maybeFixPropertyAccess(node2);
            }
            if (!ts14.isIdentifier(node2)) {
              return ts14.visitEachChild(node2, refCheckVisitor, context);
            }
            if (node2.parent === rootNode) {
              return node2;
            }
            return maybeFixIdentifier(node2);
          }
          return ts14.visitEachChild(node, refCheckVisitor, context);
        }
      }
      function visitTopLevelStatement(node) {
        if (!ts14.isModuleDeclaration(node) || isAmbient(node)) {
          transformedStmts.push(node);
          return;
        }
        const ns = node;
        const sym = typeChecker.getSymbolAtLocation(ns.name);
        if (!sym || ns.name.kind === ts14.SyntaxKind.StringLiteral) {
          transformedStmts.push(ns);
          return;
        }
        const mergedDecl = getPreviousDeclaration(sym, ns);
        if (!mergedDecl) {
          transformedStmts.push(ns);
          error(ns.name, "transformation of plain namespace not supported. (go/ts-merged-namespaces)");
          return;
        }
        if (!ts14.isInterfaceDeclaration(mergedDecl) && !ts14.isClassDeclaration(mergedDecl) && !ts14.isEnumDeclaration(mergedDecl)) {
          transformedStmts.push(ns);
          error(ns.name, "merged declaration must be local class, enum, or interface. (go/ts-merged-namespaces)");
          return;
        }
        transformedStmts.push(...transformNamespace(ns, mergedDecl));
      }
      function error(node, message) {
        reportDiagnostic(diagnostics, node, message);
        haveSeenError = true;
      }
    };
  };
}

// src/tsickle/ts_migration_exports_shim.ts
var ts15 = __toESM(require("typescript"));

// src/tsickle/summary.ts
class FileSummary {
  dynamicRequireSet = new Map;
  enhancedSet = new Map;
  maybeRequireSet = new Map;
  modSet = new Map;
  provideSet = new Map;
  strongRequireSet = new Map;
  weakRequireSet = new Map;
  autochunk = false;
  enhanceable = false;
  legacyNamespace = false;
  modName;
  moduleType = 0 /* UNKNOWN */;
  toggles = [];
  stringify(symbol) {
    return JSON.stringify(symbol);
  }
  addDynamicRequire(dynamicRequire) {
    this.dynamicRequireSet.set(this.stringify(dynamicRequire), dynamicRequire);
  }
  addEnhanced(enhanced) {
    this.enhancedSet.set(this.stringify(enhanced), enhanced);
  }
  addMaybeRequire(maybeRequire) {
    this.maybeRequireSet.set(this.stringify(maybeRequire), maybeRequire);
  }
  addMods(mods) {
    this.modSet.set(this.stringify(mods), mods);
  }
  addProvide(provide) {
    this.provideSet.set(this.stringify(provide), provide);
  }
  addStrongRequire(strongRequire) {
    this.strongRequireSet.set(this.stringify(strongRequire), strongRequire);
  }
  addWeakRequire(weakRequire) {
    this.weakRequireSet.set(this.stringify(weakRequire), weakRequire);
  }
  get dynamicRequires() {
    return [...this.dynamicRequireSet.values()];
  }
  get enhanced() {
    return [...this.enhancedSet.values()];
  }
  get maybeRequires() {
    return [...this.maybeRequireSet.values()];
  }
  get mods() {
    return [...this.modSet.values()];
  }
  get provides() {
    return [...this.provideSet.values()];
  }
  get strongRequires() {
    return [...this.strongRequireSet.values()];
  }
  get weakRequires() {
    const weakRequires = [];
    for (const [k, v] of this.weakRequireSet.entries()) {
      if (this.strongRequireSet.has(k))
        continue;
      weakRequires.push(v);
    }
    return weakRequires;
  }
}

// src/tsickle/ts_migration_exports_shim.ts
function createTsMigrationExportsShimTransformerFactory(typeChecker, host, manifest, tsickleDiagnostics, outputFileMap, fileSummaries) {
  return (context) => {
    return (src) => {
      const srcFilename = host.rootDirsRelative(src.fileName);
      const srcModuleId = host.pathToModuleName("", src.fileName);
      const srcIds = new FileIdGroup(srcFilename, srcModuleId);
      const generator = new Generator(src, srcIds, typeChecker, host, manifest, tsickleDiagnostics);
      const tsmesFile = srcIds.google3PathWithoutExtension() + ".tsmes.js";
      const dtsFile = srcIds.google3PathWithoutExtension() + ".tsmes.d.ts";
      if (!host.generateTsMigrationExportsShim) {
        return src;
      }
      if (!generator.foundMigrationExportsShim()) {
        outputFileMap.set(tsmesFile, "");
        const fileSummary2 = new FileSummary;
        fileSummary2.moduleType = 0 /* UNKNOWN */;
        fileSummaries.set(tsmesFile, fileSummary2);
        if (context.getCompilerOptions().declaration) {
          outputFileMap.set(dtsFile, "");
        }
        return src;
      }
      const [content, fileSummary] = generator.generateExportShimJavaScript();
      outputFileMap.set(tsmesFile, content);
      fileSummaries.set(tsmesFile, fileSummary);
      if (context.getCompilerOptions().declaration) {
        const dtsResult = generator.generateExportShimDeclarations();
        outputFileMap.set(dtsFile, dtsResult);
      }
      return generator.transformSourceFile();
    };
  };
}
function stripSupportedExtensions(path3) {
  return path3.replace(SUPPORTED_EXTENSIONS, "");
}
var SUPPORTED_EXTENSIONS = /(?<!\.d)\.ts$/;

class Generator {
  src;
  srcIds;
  typeChecker;
  host;
  manifest;
  diagnostics;
  mainExports;
  outputIds;
  tsmesBreakdown;
  constructor(src, srcIds, typeChecker, host, manifest, diagnostics) {
    this.src = src;
    this.srcIds = srcIds;
    this.typeChecker = typeChecker;
    this.host = host;
    this.manifest = manifest;
    this.diagnostics = diagnostics;
    const moduleSymbol = this.typeChecker.getSymbolAtLocation(this.src);
    this.mainExports = moduleSymbol ? this.typeChecker.getExportsOfModule(moduleSymbol) : [];
    const outputFilename = this.srcIds.google3PathWithoutExtension() + ".tsmes.closure.js";
    this.tsmesBreakdown = this.extractTsmesStatement();
    if (this.tsmesBreakdown) {
      this.outputIds = new FileIdGroup(outputFilename, this.tsmesBreakdown.googModuleId.text);
    }
  }
  checkIsModuleExport(node, symbol) {
    if (!symbol) {
      this.report(node, `could not resolve symbol of exported property`);
    } else if (this.mainExports.indexOf(symbol) === -1) {
      this.report(node, `export must be an exported symbol of the module`);
    } else {
      return true;
    }
    return false;
  }
  checkNonTopLevelTsmesCalls(topLevelStatement) {
    const inner = (node) => {
      if (isAnyTsmesCall(node) || isTsmesDeclareLegacyNamespaceCall(node)) {
        const name = getGoogFunctionName(node);
        this.report(node, `goog.${name} is only allowed in top level statements`);
      }
      ts15.forEachChild(node, inner);
    };
    ts15.forEachChild(topLevelStatement, inner);
  }
  extractGoogExports(exportsExpr) {
    let googExports;
    const diagnosticCount = this.diagnostics.length;
    if (ts15.isObjectLiteralExpression(exportsExpr)) {
      googExports = new Map;
      for (const property of exportsExpr.properties) {
        if (ts15.isShorthandPropertyAssignment(property)) {
          const symbol = this.typeChecker.getShorthandAssignmentValueSymbol(property);
          this.checkIsModuleExport(property.name, symbol);
          googExports.set(property.name.text, property.name.text);
        } else if (ts15.isPropertyAssignment(property)) {
          const name = property.name;
          if (!ts15.isIdentifier(name)) {
            this.report(name, "export names must be simple keys");
            continue;
          }
          const initializer = property.initializer;
          let identifier = null;
          if (ts15.isAsExpression(initializer)) {
            identifier = this.maybeExtractTypeName(initializer);
          } else if (ts15.isIdentifier(initializer)) {
            identifier = initializer;
          } else {
            this.report(initializer, "export values must be plain identifiers");
            continue;
          }
          if (identifier == null) {
            continue;
          }
          const symbol = this.typeChecker.getSymbolAtLocation(identifier);
          this.checkIsModuleExport(identifier, symbol);
          googExports.set(name.text, identifier.text);
        } else {
          this.report(property, `exports object must only contain (shorthand) properties`);
        }
      }
    } else if (ts15.isIdentifier(exportsExpr)) {
      const symbol = this.typeChecker.getSymbolAtLocation(exportsExpr);
      this.checkIsModuleExport(exportsExpr, symbol);
      googExports = exportsExpr.text;
    } else if (ts15.isAsExpression(exportsExpr)) {
      const identifier = this.maybeExtractTypeName(exportsExpr);
      if (!identifier) {
        return;
      }
      const symbol = this.typeChecker.getSymbolAtLocation(identifier);
      this.checkIsModuleExport(identifier, symbol);
      googExports = identifier.text;
    } else {
      this.report(exportsExpr, `exports object must be either an object literal ({A, B}) or the ` + `identifier of a module export (A)`);
    }
    return diagnosticCount === this.diagnostics.length ? googExports : undefined;
  }
  extractTsmesStatement() {
    const startDiagnosticsCount = this.diagnostics.length;
    let tsmesCallStatement = undefined;
    let tsmesDlnCallStatement = undefined;
    for (const statement of this.src.statements) {
      const isTsmesCall = ts15.isExpressionStatement(statement) && isAnyTsmesCall(statement.expression);
      const isTsmesDlnCall = ts15.isExpressionStatement(statement) && isTsmesDeclareLegacyNamespaceCall(statement.expression);
      if (!isTsmesCall && !isTsmesDlnCall) {
        this.checkNonTopLevelTsmesCalls(statement);
        continue;
      }
      if (isTsmesCall) {
        if (tsmesCallStatement) {
          this.report(tsmesCallStatement, "at most one call to any of goog.tsMigrationExportsShim, " + "goog.tsMigrationDefaultExportsShim, " + "goog.tsMigrationNamedExportsShim is allowed per file");
        } else {
          tsmesCallStatement = statement;
        }
      } else if (isTsmesDlnCall) {
        if (tsmesDlnCallStatement) {
          this.report(tsmesDlnCallStatement, "at most one call to " + "goog.tsMigrationExportsShimDeclareLegacyNamespace " + "is allowed per file");
        } else {
          tsmesDlnCallStatement = statement;
        }
      }
    }
    if (!tsmesCallStatement) {
      if (tsmesDlnCallStatement) {
        this.report(tsmesDlnCallStatement, "goog.tsMigrationExportsShimDeclareLegacyNamespace requires a " + "goog.tsMigration*ExportsShim call as well");
        return;
      }
      return;
    } else if (!this.host.generateTsMigrationExportsShim) {
      this.report(tsmesCallStatement, "calls to goog.tsMigration*ExportsShim are not enabled. Please set" + " generate_ts_migration_exports_shim = True" + " in the BUILD file to enable this feature.");
      return;
    }
    const tsmesCall = tsmesCallStatement.expression;
    if (isGoogCallExpressionOf(tsmesCall, "tsMigrationExportsShim") && tsmesCall.arguments.length !== 2) {
      this.report(tsmesCall, "goog.tsMigrationExportsShim requires 2 arguments");
      return;
    }
    if (isTsmesShorthandCall(tsmesCall) && tsmesCall.arguments.length !== 1) {
      this.report(tsmesCall, `goog.${getGoogFunctionName(tsmesCall)} requires exactly one argument`);
      return;
    }
    if (isGoogCallExpressionOf(tsmesCall, "tsMigrationDefaultExportsShim") && this.mainExports.length !== 1) {
      this.report(tsmesCall, "can only call goog.tsMigrationDefaultExportsShim when there is" + " exactly one export.");
      return;
    }
    const [moduleId, exportsExpr] = tsmesCall.arguments;
    if (!ts15.isStringLiteral(moduleId)) {
      this.report(moduleId, `goog.${getGoogFunctionName(tsmesCall)} ID must be a string literal`);
      return;
    }
    let googExports = undefined;
    const fnName = getGoogFunctionName(tsmesCall);
    switch (fnName) {
      case "tsMigrationDefaultExportsShim":
        googExports = this.mainExports[0].name;
        break;
      case "tsMigrationNamedExportsShim":
        googExports = new Map;
        for (const mainExport of this.mainExports) {
          googExports.set(mainExport.name, mainExport.name);
        }
        break;
      case "tsMigrationExportsShim":
        googExports = this.extractGoogExports(exportsExpr);
        break;
      default:
        throw new Error(`encountered unhandled goog.$fnName: ${fnName}`);
    }
    if (googExports === undefined) {
      if (startDiagnosticsCount >= this.diagnostics.length) {
        throw new Error("googExports should be defined unless some diagnostic is reported.");
      }
      return;
    }
    return {
      callStatement: tsmesCallStatement,
      declareLegacyNamespaceStatement: tsmesDlnCallStatement,
      googExports,
      googModuleId: moduleId
    };
  }
  maybeExtractTypeName(cast) {
    if (!ts15.isObjectLiteralExpression(cast.expression) || cast.expression.properties.length !== 0) {
      this.report(cast.expression, "must be object literal with no keys");
      return null;
    }
    const typeRef = cast.type;
    if (!ts15.isTypeReferenceNode(typeRef)) {
      this.report(typeRef, "must be a type reference");
      return null;
    }
    const typeName = typeRef.typeName;
    if (typeRef.typeArguments || !ts15.isIdentifier(typeName)) {
      this.report(typeRef, "export types must be plain identifiers");
      return null;
    }
    return typeName;
  }
  report(node, messageText) {
    reportDiagnostic(this.diagnostics, node, messageText, undefined, ts15.DiagnosticCategory.Error);
  }
  foundMigrationExportsShim() {
    return !!this.tsmesBreakdown;
  }
  generateExportShimDeclarations() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    const generatedFromComment = "// Generated from " + this.srcIds.google3Path;
    const dependencyFileImports = lines2(`declare module 'ಠ_ಠ.clutz._dependencies' {`, `  import '${this.srcIds.esModuleImportPath()}';`, `}`);
    let clutzNamespaceDeclaration;
    let googColonModuleDeclaration;
    if (this.tsmesBreakdown.googExports instanceof Map) {
      const clutzNamespace = this.srcIds.clutzNamespace();
      const clutzNamespaceReexports = Array.from(this.tsmesBreakdown.googExports).map(([k, v]) => `  export import ${k} = ${clutzNamespace}.${v};`);
      clutzNamespaceDeclaration = lines2(generatedFromComment, `declare namespace ${this.outputIds.clutzNamespace()} {`, ...clutzNamespaceReexports, `}`);
      googColonModuleDeclaration = lines2(generatedFromComment, `declare module '${this.outputIds.clutzModuleId()}' {`, `  import x = ${this.outputIds.clutzNamespace()};`, `  export = x;`, `}`);
    } else {
      clutzNamespaceDeclaration = lines2(generatedFromComment, `declare namespace ಠ_ಠ.clutz {`, `  export import ${this.outputIds.googModuleRewrittenId()} =`, `      ${this.srcIds.clutzNamespace()}.${this.tsmesBreakdown.googExports};`, `}`);
      googColonModuleDeclaration = lines2(generatedFromComment, `declare module '${this.outputIds.clutzModuleId()}' {`, `  import x = ${this.outputIds.clutzNamespace()};`, `  export default x;`, `}`);
    }
    return lines2("/**", " * @fileoverview generator:ts_migration_exports_shim.ts", " */", dependencyFileImports, clutzNamespaceDeclaration, googColonModuleDeclaration, "");
  }
  generateExportShimJavaScript() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    let maybeDeclareLegacyNameCall = undefined;
    if (this.tsmesBreakdown.declareLegacyNamespaceStatement) {
      maybeDeclareLegacyNameCall = "goog.module.declareLegacyNamespace();";
    }
    const mainModuleRequire = `var mainModule = goog.require('${this.srcIds.googModuleId}');`;
    let exportsAssignment;
    if (this.tsmesBreakdown.googExports instanceof Map) {
      const exports2 = Array.from(this.tsmesBreakdown.googExports).map(([k, v]) => `exports.${k} = mainModule.${v};`);
      exportsAssignment = lines2(...exports2);
    } else {
      exportsAssignment = `exports = mainModule.${this.tsmesBreakdown.googExports};`;
    }
    this.manifest.addModule(this.outputIds.google3Path, this.outputIds.googModuleId);
    this.manifest.addReferencedModule(this.outputIds.google3Path, this.srcIds.googModuleId);
    const isAutoChunk = containsAtPintoModule(this.src);
    const pintoModuleAnnotation = isAutoChunk ? "@pintomodule found in original_file" : "pintomodule absent in original_file";
    const content = lines2("/**", " * @fileoverview generator:ts_migration_exports_shim.ts", " * original_file:" + this.srcIds.google3Path, ` * ${pintoModuleAnnotation}`, " */", `goog.module('${this.outputIds.googModuleId}');`, maybeDeclareLegacyNameCall, mainModuleRequire, exportsAssignment, "");
    const fileSummary = new FileSummary;
    fileSummary.addProvide({
      name: this.outputIds.googModuleId,
      type: 1 /* CLOSURE */
    });
    fileSummary.addStrongRequire({ name: "goog", type: 1 /* CLOSURE */ });
    fileSummary.addStrongRequire({
      name: this.srcIds.googModuleId,
      type: 1 /* CLOSURE */
    });
    if (maybeDeclareLegacyNameCall) {
      fileSummary.legacyNamespace = true;
    }
    fileSummary.autochunk = isAutoChunk;
    fileSummary.moduleType = 2 /* GOOG_MODULE */;
    return [content, fileSummary];
  }
  transformSourceFile() {
    if (!this.outputIds || !this.tsmesBreakdown) {
      throw new Error("tsmes call must be extracted first");
    }
    const outputStatements = [...this.src.statements];
    const tsmesIndex = outputStatements.indexOf(this.tsmesBreakdown.callStatement);
    if (tsmesIndex < 0) {
      throw new Error("could not find tsmes call in file");
    }
    outputStatements.splice(tsmesIndex, 1);
    if (this.tsmesBreakdown.declareLegacyNamespaceStatement) {
      const dlnIndex = outputStatements.indexOf(this.tsmesBreakdown.declareLegacyNamespaceStatement);
      if (dlnIndex < 0) {
        throw new Error("could not find the tsmes declareLegacyNamespace call in file");
      }
      outputStatements.splice(dlnIndex, 1);
    }
    return ts15.factory.updateSourceFile(this.src, ts15.setTextRange(ts15.factory.createNodeArray(outputStatements), this.src.statements));
  }
}
function lines2(...lines3) {
  return lines3.filter((line) => line != null).join(`
`);
}

class FileIdGroup {
  google3Path;
  googModuleId;
  constructor(google3Path, googModuleId) {
    this.google3Path = google3Path;
    this.googModuleId = googModuleId;
  }
  clutzModuleId() {
    return "goog:" + this.googModuleId;
  }
  clutzNamespace() {
    return "ಠ_ಠ.clutz." + this.googModuleRewrittenId();
  }
  esModuleImportPath() {
    return "google3/" + this.google3PathWithoutExtension();
  }
  google3PathWithoutExtension() {
    return stripSupportedExtensions(this.google3Path);
  }
  googModuleRewrittenId() {
    return "module$exports$" + this.googModuleId.replace(/\./g, "$");
  }
}
function containsAtPintoModule(file) {
  const leadingTrivia = file.getFullText().substring(0, file.getLeadingTriviaWidth());
  return /\s@pintomodule\s/.test(leadingTrivia);
}
// src/tsickle/index.ts
function writeWithTsickleHeader(writeFile, rootDir) {
  return (fileName, content, writeByteOrderMark, onError, sourceFiles, data) => {
    if (fileName.endsWith(".d.ts")) {
      const sources = sourceFiles?.map((sf) => relative(rootDir, sf.fileName));
      content = `//!! generated by tsickle from ${sources?.join(" ") || "???"}
${content}`;
    }
    writeFile(fileName, content, writeByteOrderMark, onError, sourceFiles, data);
  };
}
function emit(program, host, writeFile, targetSourceFile, cancellationToken, emitOnlyDtsFiles, customTransformers = {}) {
  for (const sf of program.getSourceFiles()) {
    assertAbsolute(sf.fileName);
  }
  let tsickleDiagnostics = [];
  const typeChecker = program.getTypeChecker();
  const tsOptions = program.getCompilerOptions();
  if (!tsOptions.rootDir) {
    return {
      diagnostics: [
        {
          category: ts16.DiagnosticCategory.Error,
          code: 0,
          file: undefined,
          length: undefined,
          messageText: "TypeScript options must specify rootDir",
          start: undefined
        }
      ],
      emitSkipped: false,
      externs: {},
      fileSummaries: new Map,
      modulesManifest: new ModulesManifest,
      tsMigrationExportsShimFiles: new Map
    };
  }
  const modulesManifest = new ModulesManifest;
  const tsMigrationExportsShimFiles = new Map;
  const tsickleSourceTransformers = [];
  const fileSummaries = new Map;
  tsickleSourceTransformers.push(createTsMigrationExportsShimTransformerFactory(typeChecker, host, modulesManifest, tsickleDiagnostics, tsMigrationExportsShimFiles, fileSummaries));
  if (host.transformTypesToClosure) {
    tsickleSourceTransformers.push(transformFileoverviewCommentFactory(tsOptions, tsickleDiagnostics, host.generateExtraSuppressions));
    if (host.useDeclarationMergingTransformation) {
      tsickleSourceTransformers.push(namespaceTransformer(host, tsOptions, typeChecker, tsickleDiagnostics));
    }
    tsickleSourceTransformers.push(jsdocTransformer(host, tsOptions, typeChecker, tsickleDiagnostics));
    tsickleSourceTransformers.push(enumTransformer(host, typeChecker));
  }
  if (host.transformDecorators) {
    tsickleSourceTransformers.push(decoratorDownlevelTransformer(typeChecker, tsickleDiagnostics));
  }
  const tsTransformers = {
    after: [...customTransformers.afterTs || []],
    afterDeclarations: [...customTransformers.afterDeclarations || []],
    before: [
      ...(tsickleSourceTransformers || []).map((tf) => skipTransformForSourceFileIfNeeded(host, tf)),
      ...customTransformers.beforeTs || []
    ]
  };
  if (host.transformTypesToClosure) {
    tsTransformers.before.push(removeTypeAssertions());
  }
  if (host.googmodule) {
    tsTransformers.after.push(commonJsToGoogmoduleTransformer(host, modulesManifest, typeChecker));
    tsTransformers.after.push(transformDecoratorsOutputForClosurePropertyRenaming(tsickleDiagnostics));
    tsTransformers.after.push(transformDecoratorJsdoc());
  }
  if (host.addDtsClutzAliases) {
    tsTransformers.afterDeclarations.push(makeDeclarationTransformerFactory(typeChecker, host));
  }
  const {
    diagnostics: tsDiagnostics,
    emitSkipped,
    emittedFiles
  } = program.emit(targetSourceFile, writeWithTsickleHeader(writeFile, tsOptions.rootDir), cancellationToken, emitOnlyDtsFiles, tsTransformers);
  const externs = {};
  if (host.transformTypesToClosure) {
    const sourceFiles = targetSourceFile ? [targetSourceFile] : program.getSourceFiles();
    for (const sourceFile of sourceFiles) {
      const isDts = isDtsFileName(sourceFile.fileName);
      if (isDts && host.shouldSkipTsickleProcessing(sourceFile.fileName)) {
        continue;
      }
      const { diagnostics, moduleNamespace, output } = generateExterns(typeChecker, sourceFile, host);
      if (output) {
        externs[sourceFile.fileName] = { moduleNamespace, output };
      }
      if (diagnostics) {
        tsickleDiagnostics.push(...diagnostics);
      }
    }
  }
  tsickleDiagnostics = tsickleDiagnostics.filter((d) => d.category === ts16.DiagnosticCategory.Error || !host.shouldIgnoreWarningsForPath(d.file.fileName));
  return {
    diagnostics: [...tsDiagnostics, ...tsickleDiagnostics],
    emitSkipped,
    emittedFiles: emittedFiles || [],
    externs,
    fileSummaries,
    modulesManifest,
    tsMigrationExportsShimFiles
  };
}
function skipTransformForSourceFileIfNeeded(host, delegateFactory) {
  return (context) => {
    const delegate = delegateFactory(context);
    return (sourceFile) => {
      if (host.shouldSkipTsickleProcessing(sourceFile.fileName)) {
        return sourceFile;
      }
      return delegate(sourceFile);
    };
  };
}

// src/utils/fileUtils.ts
var import_fs2 = __toESM(require("fs"));
var import_path3 = __toESM(require("path"));
function usage() {
  console.error(`Usage: gcc-ts-compiler [gcc-ts-compiler options]

Example:
  gcc-ts-bundler --src_dir='./src' --entry_point='./index.ts' --output_dir='./dist' --language_out=ECMASCRIPT_NEXT

gcc-ts-compiler flags are:
  --src_dir             The source directory
  --entry_point         The entry point for the application
  --output_dir          The output directory
  --language_out        ECMASCRIPT5 | ECMASCRIPT6 | ECMASCRIPT3 | ECMASCRIPT_NEXT
  --compilation_level   WHITESPACE_ONLY | SIMPLE | ADVANCED
  --preserve_cache      Whether to preserve the cache files for debugging
  --verbose             Print diagnostics to the console
  --fatal_warnings       Whether warnings should be fatal, causing tsickle to return a non-zero exit code
  -h, --help            Show this help message
`);
}
function getCommonParentDirectory(fileNames) {
  if (fileNames.length === 0)
    return "/";
  const commonPath = fileNames.map((fileName) => fileName.split(import_path3.default.sep)).reduce((commonParts, pathParts) => {
    const minLength = Math.min(commonParts.length, pathParts.length);
    const newCommonParts = [];
    for (let i = 0;i < minLength; i++) {
      if (commonParts[i] !== pathParts[i])
        break;
      newCommonParts.push(commonParts[i]);
    }
    return newCommonParts;
  });
  return commonPath.length > 0 ? commonPath.join(import_path3.default.sep) : "/";
}
async function ensureDirectoryExistence(filePath) {
  const dirName = import_path3.default.dirname(filePath);
  if (await import_fs2.default.promises.access(dirName).then(() => true).catch(() => false))
    return;
  await import_fs2.default.promises.mkdir(dirName, { recursive: true });
}

// src/compiler/tsickleCompiler.ts
var modulePrefix = "_gcc_";
async function toClosureJS(options, fileNames, settings, writeFile) {
  const absoluteFileNames = fileNames.map((fileName) => import_path4.default.resolve(fileName));
  const compilerHost = import_typescript.default.createCompilerHost(options);
  const program = import_typescript.default.createProgram(absoluteFileNames, options, compilerHost);
  const rootModulePath = options.rootDir || getCommonParentDirectory(absoluteFileNames);
  const filesToProcess = new Set(absoluteFileNames);
  const writePromises = [];
  const asyncWriteFile = (fileName, content, writeByteOrderMark) => {
    const writePromise = new Promise((resolve, reject) => {
      try {
        writeFile(fileName, content, writeByteOrderMark);
        resolve();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`Failed to write file ${fileName}: ${message}`));
      }
    });
    writePromises.push(writePromise);
  };
  const transformerHost = {
    addDtsClutzAliases: true,
    fileNameToModuleId: (fileName) => modulePrefix + import_path4.default.relative(rootModulePath, fileName),
    generateExtraSuppressions: true,
    generateSummary: true,
    generateTsMigrationExportsShim: true,
    googmodule: true,
    logWarning: (warning) => {
      if (settings.verbose) {
        console.error(import_typescript.default.formatDiagnosticsWithColorAndContext([warning], compilerHost));
      } else {
        console.error(import_typescript.default.flattenDiagnosticMessageText(warning.messageText, `
`));
      }
    },
    options,
    pathToModuleName: (context, fileName) => fileName === "tslib" ? "tslib" : modulePrefix + pathToModuleName(rootModulePath, context, fileName),
    provideExternalModuleDtsNamespace: true,
    rootDirsRelative: (fileName) => fileName,
    shouldIgnoreWarningsForPath: () => !settings.fatalWarnings,
    shouldSkipTsickleProcessing: (fileName) => !filesToProcess.has(import_path4.default.resolve(fileName)),
    transformDecorators: true,
    transformDynamicImport: "closure",
    transformTypesToClosure: true,
    typeBlackListPaths: new Set,
    untyped: false,
    useDeclarationMergingTransformation: true
  };
  const diagnostics = import_typescript.default.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externs: {},
      fileSummaries: new Map,
      modulesManifest: new ModulesManifest,
      tsMigrationExportsShimFiles: new Map
    };
  }
  return new Promise((resolve, reject) => {
    try {
      const result = emit(program, transformerHost, asyncWriteFile);
      Promise.all(writePromises).then(() => resolve(result)).catch(reject);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// src/settings.ts
var import_minimist = __toESM(require("minimist"));
var import_path5 = __toESM(require("path"));
function loadSettingsFromArgs(args) {
  const cwd = process.cwd();
  const defaultSettings = {
    compilationLevel: "ADVANCED",
    entryPoints: [],
    externs: [],
    fatalWarnings: false,
    js: [],
    languageOut: "ECMASCRIPT_NEXT",
    outputDir: import_path5.default.join(cwd, "./dist"),
    preserveCache: false,
    srcDir: "./src",
    verbose: false
  };
  const parsedArgs = import_minimist.default(args);
  const settings = { ...defaultSettings };
  for (const [flag, value] of Object.entries(parsedArgs)) {
    switch (flag) {
      case "src_dir":
        settings.srcDir = value;
        break;
      case "entry_point": {
        const entryPoints = Array.isArray(value) ? value : [value];
        for (const entryPoint of entryPoints) {
          settings.entryPoints.push(import_path5.default.join(cwd, "./.closured/", entryPoint.replace(/\.ts$/, ".js")));
        }
        break;
      }
      case "output_dir":
        settings.outputDir = import_path5.default.join(cwd, String(value));
        break;
      case "language_out":
        settings.languageOut = String(value);
        break;
      case "compilation_level":
        settings.compilationLevel = String(value);
        break;
      case "preserve_cache":
        settings.preserveCache = true;
        break;
      case "verbose":
        settings.verbose = true;
        break;
      case "fatal_warnings":
        settings.fatalWarnings = true;
        break;
      case "h":
      case "help":
        usage();
        process.exit(0);
    }
  }
  return { settings };
}

// src/utils/fileOperations.ts
var import_fs3 = __toESM(require("fs"));
var import_path6 = __toESM(require("path"));
async function copyDirectoryRecursive(src, dest) {
  if (!await import_fs3.default.promises.access(dest).then(() => true).catch(() => false)) {
    await import_fs3.default.promises.mkdir(dest, { recursive: true });
  }
  const entries = await import_fs3.default.promises.readdir(src, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const srcPath = import_path6.default.join(src, entry.name);
    const destPath = import_path6.default.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      await import_fs3.default.promises.copyFile(srcPath, destPath);
    }
  }));
}
async function cleanDirectory(dir) {
  if (!await import_fs3.default.promises.access(dir).then(() => true).catch(() => false)) {
    return;
  }
  const entries = await import_fs3.default.promises.readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const fullPath = import_path6.default.join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanDirectory(fullPath);
      await import_fs3.default.promises.rmdir(fullPath);
    } else {
      await import_fs3.default.promises.unlink(fullPath);
    }
  }));
}
async function writeFileContent(filePath, contents) {
  await ensureDirectoryExistence(filePath);
  await import_fs3.default.promises.writeFile(filePath, contents, "utf-8");
}
async function cleanupDirectories(dirs, remove = true) {
  await Promise.all(dirs.map(async (dir) => {
    await cleanDirectory(dir);
    if (remove) {
      await import_fs3.default.promises.rmdir(dir);
    }
  }));
}

// src/utils/tsConfigLoader.ts
var import_fs4 = __toESM(require("fs"));
var import_path7 = __toESM(require("path"));
var import_typescript2 = __toESM(require("typescript"));
async function loadTscConfig(args) {
  const parsedCommandLine = import_typescript2.default.parseCommandLine(args);
  if (parsedCommandLine.errors.length > 0) {
    return { errors: parsedCommandLine.errors, fileNames: [], options: {} };
  }
  const tsFileArguments = parsedCommandLine.fileNames;
  const projectDir = parsedCommandLine.options.project || process.cwd();
  const possibleConfigFile = import_typescript2.default.findConfigFile(projectDir, (fileName) => import_typescript2.default.sys.fileExists(fileName));
  if (!possibleConfigFile) {
    return {
      errors: [
        {
          category: import_typescript2.default.DiagnosticCategory.Error,
          code: 0,
          file: undefined,
          length: undefined,
          messageText: "Cannot find tsconfig.json",
          start: undefined
        }
      ],
      fileNames: [],
      options: {}
    };
  }
  const configFileText = import_fs4.default.readFileSync(possibleConfigFile, "utf-8");
  const result = import_typescript2.default.parseConfigFileTextToJson(possibleConfigFile, configFileText);
  if (result.error) {
    return { errors: [result.error], fileNames: [], options: {} };
  }
  result.config.compilerOptions.rootDir = "./";
  result.config.compilerOptions.outDir = import_path7.default.join(projectDir, "../.closured");
  result.config.compilerOptions.module = "CommonJS";
  result.config.compilerOptions.moduleResolution = "Node";
  result.config.compilerOptions.target = "ESNext";
  result.config.compilerOptions.skipLibCheck = true;
  result.config.exclude = [];
  result.config.include = [import_path7.default.join(projectDir, "*.ts")];
  const configParseResult = import_typescript2.default.parseJsonConfigFileContent(result.config, import_typescript2.default.sys, projectDir, parsedCommandLine.options, possibleConfigFile);
  if (configParseResult.errors.length > 0) {
    return { errors: configParseResult.errors, fileNames: [], options: {} };
  }
  const fileNames = tsFileArguments.length > 0 ? tsFileArguments : configParseResult.fileNames;
  if (fileNames.length > 0) {
    try {
      await validateFiles(fileNames);
    } catch (error) {
      return {
        errors: [
          {
            category: import_typescript2.default.DiagnosticCategory.Error,
            code: 0,
            file: undefined,
            length: undefined,
            messageText: error instanceof Error ? error.message : "Unknown error validating files",
            start: undefined
          }
        ],
        fileNames: [],
        options: {}
      };
    }
  }
  return { errors: [], fileNames, options: configParseResult.options };
}
async function validateFiles(files) {
  const fileChecks = await Promise.all(files.map(async (file) => {
    try {
      await import_fs4.default.promises.access(file);
      return { exists: true, file };
    } catch {
      return { exists: false, file };
    }
  }));
  const nonExistentFiles = fileChecks.filter((check) => !check.exists).map((check) => check.file);
  if (nonExistentFiles.length > 0) {
    throw new Error(`Files do not exist: ${nonExistentFiles.join(", ")}`);
  }
}

// src/index.ts
var __dirname = "/Users/Blueagle/Code/gcc-ts-bundler/src";
var PRE_COMPILED_DIR = ".pre-compiled";
async function processTsFiles(config, srcDir, preCompiledDir, closuredDir, settings) {
  await Promise.all(config.fileNames.map(async (file) => {
    const relativePath = import_path8.default.relative(srcDir, file);
    const preCompiledPath = import_path8.default.join(preCompiledDir, relativePath);
    const contents = await import_fs5.default.promises.readFile(preCompiledPath, "utf-8");
    const isEntryPoint = settings.entryPoints.some((entryPoint) => entryPoint.replace(/\.[^/.]+$/, "").endsWith(relativePath.split(PRE_COMPILED_DIR)[1].replace(/\.[^/.]+$/, "")));
    const transformed = await customTransform2(contents, preCompiledPath, isEntryPoint);
    const closuredPath = import_path8.default.join(closuredDir, relativePath);
    await writeFileContent(closuredPath, transformed);
  }));
}
async function main(args) {
  const { settings } = loadSettingsFromArgs(args);
  const cwd = process.cwd();
  const srcDir = import_path8.default.join(cwd, settings.srcDir);
  const preCompiledDir = import_path8.default.join(cwd, PRE_COMPILED_DIR);
  const closuredDir = import_path8.default.join(cwd, "./.closured");
  const closureExternsDir = import_path8.default.join(cwd, "./.closure-externs");
  try {
    process.chdir(srcDir);
    await cleanupDirectories([preCompiledDir, closuredDir], false);
    await ensureDirectoryExistence(preCompiledDir);
    await copyDirectoryRecursive(srcDir, preCompiledDir);
    process.chdir(preCompiledDir);
    const config = await loadTscConfig([]);
    if (config.errors.length > 0) {
      console.error(import_typescript3.default.formatDiagnosticsWithColorAndContext(config.errors, import_typescript3.default.createCompilerHost(config.options)));
      return 1;
    }
    if (config.options.module !== import_typescript3.default.ModuleKind.CommonJS) {
      console.error('tsickle converts TypeScript modules to Closure modules via CommonJS internally. Set tsconfig.json "module": "commonjs"');
      return 1;
    }
    await processTsFiles(config, srcDir, preCompiledDir, closuredDir, settings);
    const result = await toClosureJS(config.options, config.fileNames, settings, (fileName, content) => {
      writeFileContent(fileName, content);
    });
    if (result.diagnostics.length > 0) {
      console.error(import_typescript3.default.formatDiagnosticsWithColorAndContext(result.diagnostics, import_typescript3.default.createCompilerHost(config.options)));
      return 1;
    }
    const modulesExterns = import_path8.default.join(closureExternsDir, "modules-externs.js");
    await ensureDirectoryExistence(modulesExterns);
    await import_fs5.default.promises.writeFile(modulesExterns, getGeneratedExterns(result.externs, config.options.rootDir || ""));
    const closureExternsPath = import_path8.default.join(__dirname, "../closure-externs");
    settings.externs.push(...import_fs5.default.readdirSync(closureExternsPath).map((file) => import_path8.default.join(closureExternsPath, file)));
    settings.externs.push(modulesExterns);
    settings.js.push(import_path8.default.join(__dirname, "../closure-lib/**.js"), import_path8.default.join(closuredDir, "**.js"));
    console.log("Building with Closure Compiler...");
    const exitCode = await runClosureCompiler(settings);
    if (exitCode !== 0) {
      console.error("Failed to build with Closure Compiler.");
    } else {
      console.log("Build succeeded.");
    }
    return exitCode;
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    if (!settings.preserveCache) {
      await cleanupDirectories([preCompiledDir, closureExternsDir, closuredDir], true);
    }
  }
}
main(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
