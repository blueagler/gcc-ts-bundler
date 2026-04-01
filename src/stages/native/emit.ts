import fs from "fs";
import { createRequire } from "module";
import path from "path";
import ts from "typescript";

import { DiagnosticsPreflight } from "../../api/types";
import { filesExist } from "../../internal/file-state";
import { collectFileStates } from "../../native/load";
import { NormalizedBuildOptions, PackageAlias } from "../../internal/types";
import { resolveGraph } from "../../native/load";
import { transpileSources } from "../../native/load";

const require = createRequire(import.meta.url);

export interface NativeEmitStageResult {
  diagnostics: ts.Diagnostic[];
  emitSkipped: boolean;
  emittedFiles: string[];
  externsPath: string;
  outDir: string;
  supportFiles: string[];
}

interface NativeEmitMetadata {
  emittedFiles: string[];
  externsPath: string;
  supportFiles: string[];
  version: number;
}

const NATIVE_EMIT_METADATA_VERSION = 2;

export async function emitNativeStage({
  cacheDir,
  fileNames,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir,
}: {
  cacheDir: string;
  fileNames: string[];
  metadataPath: string;
  options: NormalizedBuildOptions;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  tsConfigPath: string;
  workspaceDir: string;
}): Promise<NativeEmitStageResult> {
  const outDir = path.join(cacheDir, "out");
  const externsPath = path.join(cacheDir, "modules-externs.js");
  const runtimePackageInputs = await collectTsxRuntimePackageInputs({
    fileNames,
    tsConfigPath,
    workspaceDir,
  });
  const runtimeSupportFiles = runtimePackageInputs.sourceFiles.map((fileName) =>
    toEmittedPath(fileName, outDir, workspaceDir),
  );
  const combinedFileNames = uniqueSorted([
    ...fileNames,
    ...runtimePackageInputs.sourceFiles,
  ]);
  const combinedPackageAliases = mergePackageAliases([
    ...packageAliases,
    ...runtimePackageInputs.packageAliases,
  ]);
  const combinedPackageJsonFiles = uniqueSorted([
    ...packageJsonFiles,
    ...runtimePackageInputs.packageJsonFiles,
  ]);
  const cachedMetadata = await readMetadata(metadataPath);
  if (
    cachedMetadata &&
    (await filesExist([
      cachedMetadata.externsPath,
      ...cachedMetadata.emittedFiles,
      ...cachedMetadata.supportFiles,
    ]))
  ) {
    return {
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles,
    };
  }

  await fs.promises.rm(outDir, { force: true, recursive: true });
  await fs.promises.mkdir(outDir, { recursive: true });

  const diagnostics = getPreflightDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir,
  });
  if (diagnostics.length > 0) {
    return {
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }

  const result = transpileSources({
    externsPath,
    fileNames: combinedFileNames,
    outDir,
    workspaceDir,
  });
  const decoratorDiagnostics = await rewriteDecoratedTypeScriptOutputs({
    fileNames: combinedFileNames,
    outDir,
    tsConfigPath,
    workspaceDir,
  });
  if (decoratorDiagnostics.length > 0) {
    return {
      diagnostics: decoratorDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: [],
    };
  }
  await rewriteCommonJsPackageImports({
    emittedFiles: result.emittedFiles,
    packageAliases: combinedPackageAliases,
  });
  await stabilizeExternalCallObjectLiteralKeys({
    emittedFiles: result.emittedFiles,
  });
  const supportFiles = await emitPackageSupportFiles({
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir,
  });
  const finalSupportFiles = uniqueSorted([
    ...runtimeSupportFiles,
    ...supportFiles,
  ]);

  await fs.promises.writeFile(
    metadataPath,
    JSON.stringify(
      {
        emittedFiles: result.emittedFiles,
        externsPath: result.externsPath,
        supportFiles: finalSupportFiles,
        version: NATIVE_EMIT_METADATA_VERSION,
      } satisfies NativeEmitMetadata,
      null,
      2,
    ),
    "utf-8",
  );

  return {
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles,
  };
}

async function collectTsxRuntimePackageInputs({
  fileNames,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  tsConfigPath: string;
  workspaceDir: string;
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return {
      packageAliases: [] as PackageAlias[],
      packageJsonFiles: [] as string[],
      sourceFiles: [] as string[],
    };
  }

  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return {
      packageAliases: [] as PackageAlias[],
      packageJsonFiles: [] as string[],
      sourceFiles: [] as string[],
    };
  }

  const resolvedEntry = require.resolve(runtimeSpecifier, {
    paths: [workspaceDir],
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(
    resolvedEntry,
    workspaceDir,
  );
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: path.join(workspaceDir, "src"),
    workspaceDir,
  });

  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases,
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles,
  };
}

function getPreflightDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  preflight: DiagnosticsPreflight;
  tsConfigPath: string;
  workspaceDir: string;
}): ts.Diagnostic[] {
  if (preflight === "off") {
    return [];
  }

  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates
    .filter((state) => !state.exists)
    .map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(
        `Missing required build input(s): ${missingFiles.join(", ")}`,
      ),
    ];
  }

  if (preflight !== "full") {
    return [];
  }

  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const finalCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };

  const compilerHost = ts.createCompilerHost(finalCompilerOptions);
  const program = ts.createProgram(
    fileNames,
    finalCompilerOptions,
    compilerHost,
  );
  return [...ts.getPreEmitDiagnostics(program)].filter(
    (diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic),
  );
}

function loadCompilerOptions(configPath: string): ts.CompilerOptions {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"),
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    {},
    configPath,
  );
  if (parsedConfig.errors.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(
        parsedConfig.errors,
        ts.createCompilerHost({}),
      ),
    );
  }

  return parsedConfig.options;
}

function createSimpleDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined,
  };
}

function shouldIgnorePreflightDiagnostic(diagnostic: ts.Diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }

  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return (
    message.includes("node_modules") &&
    message.includes("implicitly has an 'any' type")
  );
}

async function rewriteDecoratedTypeScriptOutputs({
  fileNames,
  outDir,
  tsConfigPath,
  workspaceDir,
}: {
  fileNames: string[];
  outDir: string;
  tsConfigPath: string;
  workspaceDir: string;
}) {
  const compilerOptions = loadCompilerOptions(tsConfigPath);
  const decoratorCompilerOptions: ts.CompilerOptions = {
    ...compilerOptions,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    sourceMap: false,
    target: ts.ScriptTarget.ES2018,
  };
  const diagnostics: ts.Diagnostic[] = [];

  for (const fileName of fileNames) {
    if (!isTypeScriptSourceFile(fileName)) {
      continue;
    }

    const sourceText = await fs.promises.readFile(fileName, "utf8");
    if (!shouldTranspileWithTypeScript(fileName, sourceText)) {
      continue;
    }

    const transpiled = ts.transpileModule(sourceText, {
      compilerOptions: decoratorCompilerOptions,
      fileName,
      reportDiagnostics: true,
    });
    diagnostics.push(
      ...(transpiled.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ),
    );

    const outputPath = path
      .join(outDir, path.relative(workspaceDir, fileName))
      .replace(/\.[^/.]+$/, ".js");
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, transpiled.outputText, "utf8");
  }

  return diagnostics;
}

async function rewriteCommonJsPackageImports({
  emittedFiles,
  packageAliases,
}: {
  emittedFiles: string[];
  packageAliases: PackageAlias[];
}) {
  const commonJsSpecifiers: string[] = [];
  for (const alias of packageAliases) {
    if (!(await isCommonJsPackageTarget(alias.targetPath))) {
      continue;
    }

    commonJsSpecifiers.push(
      alias.subpath === "."
        ? alias.packageName
        : `${alias.packageName}/${alias.subpath.slice(2)}`,
    );
  }

  if (commonJsSpecifiers.length === 0) {
    return;
  }

  for (const emittedFile of emittedFiles) {
    if (emittedFile.includes(`${path.sep}node_modules${path.sep}`)) {
      continue;
    }

    const sourceText = await fs.promises.readFile(emittedFile, "utf8");
    const rewritten = rewriteNamedImportsFromCommonJs(
      sourceText,
      commonJsSpecifiers,
    );
    if (rewritten !== sourceText) {
      await fs.promises.writeFile(emittedFile, rewritten, "utf8");
    }
  }
}

async function stabilizeExternalCallObjectLiteralKeys({
  emittedFiles,
}: {
  emittedFiles: string[];
}) {
  for (const emittedFile of emittedFiles) {
    if (emittedFile.includes(`${path.sep}node_modules${path.sep}`)) {
      continue;
    }

    const sourceText = await fs.promises.readFile(emittedFile, "utf8");
    const rewritten = rewriteExternalCallObjectLiteralKeys(
      sourceText,
      emittedFile,
    );
    if (rewritten !== sourceText) {
      await fs.promises.writeFile(emittedFile, rewritten, "utf8");
    }
  }
}

function containsDecorators(fileName: string, sourceText: string) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName),
  );
  let found = false;

  const visit = (node: ts.Node) => {
    if (found) {
      return;
    }

    if (
      ts.canHaveDecorators(node) &&
      (ts.getDecorators(node)?.length ?? 0) > 0
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function shouldTranspileWithTypeScript(fileName: string, sourceText: string) {
  return fileName.endsWith(".tsx") || containsDecorators(fileName, sourceText);
}

async function isCommonJsPackageTarget(targetPath: string) {
  const sourceText = await fs.promises.readFile(targetPath, "utf8");
  return (
    targetPath.endsWith(".cjs") ||
    sourceText.includes("module.exports") ||
    sourceText.includes("exports.") ||
    sourceText.includes("exports[") ||
    sourceText.includes("require(")
  );
}

function rewriteNamedImportsFromCommonJs(
  sourceText: string,
  commonJsSpecifiers: string[],
) {
  let rewritten = sourceText;
  let importCounter = 0;

  for (const specifier of [...new Set(commonJsSpecifiers)]) {
    const escapedSpecifier = escapeRegExp(specifier);
    const namespaceRegex = new RegExp(
      `^import\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+["']${escapedSpecifier}["'];?$`,
      "gm",
    );
    rewritten = rewritten.replace(namespaceRegex, (_match, namespaceImport) => {
      const importName = `__cjs_import_${importCounter++}`;
      return [
        `import ${importName} from ${JSON.stringify(specifier)};`,
        `const ${namespaceImport} = ${importName};`,
      ].join("\n");
    });

    const defaultAndNamedRegex = new RegExp(
      `^import\\s+([A-Za-z_$][\\w$]*)\\s*,\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapedSpecifier}["'];?$`,
      "gm",
    );
    rewritten = rewritten.replace(
      defaultAndNamedRegex,
      (_match, defaultImport, bindings) => {
        return [
          `import ${defaultImport} from ${JSON.stringify(specifier)};`,
          `const { ${normalizeImportBindings(bindings)} } = ${defaultImport};`,
        ].join("\n");
      },
    );

    const namedOnlyRegex = new RegExp(
      `^import\\s*\\{([^}]+)\\}\\s*from\\s*["']${escapedSpecifier}["'];?$`,
      "gm",
    );
    rewritten = rewritten.replace(namedOnlyRegex, (_match, bindings) => {
      const importName = `__cjs_import_${importCounter++}`;
      return [
        `import ${importName} from ${JSON.stringify(specifier)};`,
        `const { ${normalizeImportBindings(bindings)} } = ${importName};`,
      ].join("\n");
    });
  }

  return rewritten;
}

function rewriteExternalCallObjectLiteralKeys(
  sourceText: string,
  fileName: string,
) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const externalNames = collectExternalCallableNames(sourceFile);
  if (externalNames.size === 0) {
    return sourceText;
  }

  let changed = false;
  const transformer = <T extends ts.Node>(
    context: ts.TransformationContext,
  ) => {
    const visit: ts.Visitor = (node) => {
      if (
        ts.isCallExpression(node) &&
        isExternalCallableExpression(node.expression, externalNames)
      ) {
        let callChanged = false;
        const rewrittenArguments = node.arguments.map((argument) => {
          const rewrittenArgument = rewriteExternalObjectValue(argument);
          if (rewrittenArgument !== argument) {
            callChanged = true;
          }
          return rewrittenArgument;
        });
        if (callChanged) {
          changed = true;
          return ts.visitEachChild(
            context.factory.updateCallExpression(
              node,
              node.expression,
              node.typeArguments,
              rewrittenArguments,
            ),
            visit,
            context,
          );
        }
      }

      return ts.visitEachChild(node, visit, context);
    };

    return (node: T) => ts.visitNode(node, visit) as T;
  };

  const transformed = ts.transform(sourceFile, [transformer]);
  try {
    if (!changed) {
      return sourceText;
    }

    return ts
      .createPrinter({ newLine: ts.NewLineKind.LineFeed })
      .printFile(transformed.transformed[0] as ts.SourceFile);
  } finally {
    transformed.dispose();
  }
}

function collectExternalCallableNames(sourceFile: ts.SourceFile) {
  const externalNames = new Set<string>();
  let changed = true;

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }

    const { importClause } = statement;
    if (importClause.name) {
      externalNames.add(importClause.name.text);
    }
    if (importClause.namedBindings) {
      if (ts.isNamespaceImport(importClause.namedBindings)) {
        externalNames.add(importClause.namedBindings.name.text);
      } else {
        for (const element of importClause.namedBindings.elements) {
          externalNames.add(
            (element.name ?? element.propertyName)?.text ?? element.name.text,
          );
        }
      }
    }
  }

  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer) {
          continue;
        }

        if (
          ts.isIdentifier(declaration.name) &&
          isExternalValueExpression(declaration.initializer, externalNames) &&
          !externalNames.has(declaration.name.text)
        ) {
          externalNames.add(declaration.name.text);
          changed = true;
          continue;
        }

        if (
          ts.isObjectBindingPattern(declaration.name) &&
          isExternalValueExpression(declaration.initializer, externalNames)
        ) {
          for (const element of declaration.name.elements) {
            if (
              ts.isIdentifier(element.name) &&
              !externalNames.has(element.name.text)
            ) {
              externalNames.add(element.name.text);
              changed = true;
            }
          }
        }
      }
    }
  }

  return externalNames;
}

function isExternalCallableExpression(
  expression: ts.Expression,
  externalNames: Set<string>,
): boolean {
  if (ts.isIdentifier(expression)) {
    return externalNames.has(expression.text);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return isExternalValueExpression(expression.expression, externalNames);
  }

  if (ts.isElementAccessExpression(expression)) {
    return isExternalValueExpression(expression.expression, externalNames);
  }

  return false;
}

function isExternalValueExpression(
  expression: ts.Expression,
  externalNames: Set<string>,
): boolean {
  if (ts.isIdentifier(expression)) {
    return externalNames.has(expression.text);
  }

  if (ts.isParenthesizedExpression(expression)) {
    return isExternalValueExpression(expression.expression, externalNames);
  }

  if (ts.isPropertyAccessExpression(expression)) {
    return isExternalValueExpression(expression.expression, externalNames);
  }

  if (ts.isElementAccessExpression(expression)) {
    return isExternalValueExpression(expression.expression, externalNames);
  }

  return false;
}

function rewriteExternalObjectValue(expression: ts.Expression): ts.Expression {
  if (ts.isObjectLiteralExpression(expression)) {
    return rewriteObjectLiteralKeys(expression);
  }

  if (ts.isArrayLiteralExpression(expression)) {
    let changed = false;
    const elements = expression.elements.map((element) => {
      if (!ts.isExpression(element)) {
        return element;
      }
      const rewritten = rewriteExternalObjectValue(element);
      if (rewritten !== element) {
        changed = true;
      }
      return rewritten;
    });
    return changed
      ? ts.factory.updateArrayLiteralExpression(expression, elements)
      : expression;
  }

  if (ts.isParenthesizedExpression(expression)) {
    const rewritten = rewriteExternalObjectValue(expression.expression);
    return rewritten !== expression.expression
      ? ts.factory.updateParenthesizedExpression(expression, rewritten)
      : expression;
  }

  return expression;
}

function rewriteObjectLiteralKeys(expression: ts.ObjectLiteralExpression) {
  let changed = false;
  const properties = expression.properties.map((property) => {
    if (ts.isPropertyAssignment(property)) {
      const rewrittenInitializer = rewriteExternalObjectValue(
        property.initializer,
      );
      const rewrittenName = quotePropertyName(property.name);
      if (
        rewrittenInitializer !== property.initializer ||
        rewrittenName !== property.name
      ) {
        changed = true;
        return ts.factory.updatePropertyAssignment(
          property,
          rewrittenName,
          rewrittenInitializer,
        );
      }
      return property;
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      changed = true;
      return ts.factory.createPropertyAssignment(
        ts.factory.createStringLiteral(property.name.text),
        property.name,
      );
    }

    if (ts.isSpreadAssignment(property)) {
      const rewrittenExpression = rewriteExternalObjectValue(
        property.expression,
      );
      if (rewrittenExpression !== property.expression) {
        changed = true;
        return ts.factory.updateSpreadAssignment(property, rewrittenExpression);
      }
    }

    return property;
  });

  return changed
    ? ts.factory.updateObjectLiteralExpression(expression, properties)
    : expression;
}

function quotePropertyName(name: ts.PropertyName): ts.PropertyName {
  if (ts.isIdentifier(name)) {
    return ts.factory.createComputedPropertyName(
      ts.factory.createStringLiteral(name.text),
    );
  }

  if (ts.isNumericLiteral(name)) {
    return ts.factory.createComputedPropertyName(
      ts.factory.createStringLiteral(name.text),
    );
  }

  return name;
}

function getScriptKind(fileName: string) {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith(".mts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.TS;
}

function getJsxRuntimeSpecifier(compilerOptions: ts.CompilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case ts.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}

function isTypeScriptSourceFile(fileName: string) {
  return (
    (fileName.endsWith(".ts") ||
      fileName.endsWith(".tsx") ||
      fileName.endsWith(".mts")) &&
    !fileName.endsWith(".d.ts")
  );
}

async function readMetadata(
  metadataPath: string,
): Promise<NativeEmitMetadata | null> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<NativeEmitMetadata>;
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function emitPackageSupportFiles({
  outDir,
  packageAliases,
  packageJsonFiles,
  workspaceDir,
}: {
  outDir: string;
  packageAliases: PackageAlias[];
  packageJsonFiles: string[];
  workspaceDir: string;
}) {
  const supportFiles: string[] = [];
  const rootPackageNames = new Set(
    packageAliases
      .filter((alias) => alias.subpath === ".")
      .map((alias) => alias.packageName),
  );

  for (const packageJsonFile of packageJsonFiles) {
    const packageDir = path.dirname(packageJsonFile);
    const packageName = path.relative(
      path.join(workspaceDir, "node_modules"),
      packageDir,
    );
    if (rootPackageNames.has(packageName)) {
      continue;
    }

    const outputPath = path.join(
      outDir,
      path.relative(workspaceDir, packageJsonFile),
    );
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.copyFile(packageJsonFile, outputPath);
    supportFiles.push(outputPath);
  }

  for (const alias of packageAliases) {
    const targetPath = toEmittedPath(alias.targetPath, outDir, workspaceDir);
    const packageDir = path.join(outDir, "node_modules", alias.packageName);

    if (alias.subpath === ".") {
      const entryFile = path.join(packageDir, "__gcc_entry__.js");
      const packageJsonOutput = path.join(packageDir, "package.json");
      const commonJsTarget = await isCommonJsPackageTarget(alias.targetPath);
      await fs.promises.mkdir(packageDir, { recursive: true });
      await fs.promises.writeFile(
        entryFile,
        commonJsTarget
          ? createCommonJsReexportModule(entryFile, targetPath)
          : createReexportModule(entryFile, targetPath),
        "utf8",
      );
      await fs.promises.writeFile(
        packageJsonOutput,
        JSON.stringify(
          {
            browser: "./__gcc_entry__.js",
            main: "./__gcc_entry__.js",
            module: "./__gcc_entry__.js",
            name: alias.packageName,
          },
          null,
          2,
        ),
        "utf8",
      );
      supportFiles.push(entryFile, packageJsonOutput);
      continue;
    }

    const aliasFile = toAliasFilePath(packageDir, alias.subpath);
    if (aliasFile === targetPath) {
      continue;
    }

    const commonJsTarget = await isCommonJsPackageTarget(alias.targetPath);
    await fs.promises.mkdir(path.dirname(aliasFile), { recursive: true });
    await fs.promises.writeFile(
      aliasFile,
      commonJsTarget
        ? createCommonJsReexportModule(aliasFile, targetPath)
        : createReexportModule(aliasFile, targetPath),
      "utf8",
    );
    supportFiles.push(aliasFile);
  }

  return [...new Set(supportFiles)].sort((left, right) =>
    left.localeCompare(right),
  );
}

function createReexportModule(fromPath: string, targetPath: string) {
  const relativePath = toImportPath(
    path.relative(path.dirname(fromPath), targetPath),
  );
  return [
    `import * as __module from ${JSON.stringify(relativePath)};`,
    `export * from ${JSON.stringify(relativePath)};`,
    "export default __module.default;",
    "",
  ].join("\n");
}

function createCommonJsReexportModule(fromPath: string, targetPath: string) {
  const relativePath = toImportPath(
    path.relative(path.dirname(fromPath), targetPath),
  );
  return [
    `import __default, { __cjsExports } from ${JSON.stringify(relativePath)};`,
    "export default __default;",
    "export { __cjsExports };",
    "",
  ].join("\n");
}

function toAliasFilePath(packageDir: string, subpath: string) {
  const relativeSubpath = subpath.replace(/^\.\//, "");
  return path.extname(relativeSubpath)
    ? path.join(packageDir, relativeSubpath)
    : path.join(packageDir, `${relativeSubpath}.js`);
}

function toEmittedPath(
  sourcePath: string,
  outDir: string,
  workspaceDir: string,
) {
  return path
    .join(outDir, path.relative(workspaceDir, sourcePath))
    .replace(/\.[^/.]+$/, ".js");
}

function toImportPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function mergePackageAliases(aliases: PackageAlias[]) {
  const merged = new Map<string, PackageAlias>();
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\0${alias.subpath}`, alias);
  }

  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\0${left.subpath}`;
    const rightKey = `${right.packageName}\0${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}

function toWorkspaceNodeModulesPath(
  resolvedPath: string,
  workspaceDir: string,
) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }

  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path.join(workspaceDir, relativeNodeModulesPath);
}

function normalizeImportBindings(bindings: string) {
  return bindings
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean)
    .map((binding) => binding.replace(/\s+as\s+/g, ": "))
    .join(", ");
}

function toRuntimePackageAlias(
  specifier: string,
  targetPath: string,
): PackageAlias {
  const segments = specifier.startsWith("@")
    ? specifier.split("/", 3)
    : specifier.split("/", 2);
  const packageName = specifier.startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
  const subpath = specifier.startsWith("@") ? segments[2] : segments[1];

  return {
    packageName,
    subpath: subpath ? `./${subpath}` : ".",
    targetPath,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
