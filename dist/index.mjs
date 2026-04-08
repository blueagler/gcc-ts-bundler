const __gcc_current_module_url = import.meta.url;

// src/api/externs.ts
import fs3 from "fs";
import path3 from "path";
import ts2 from "typescript";

// src/stages/native/compiler-options.ts
import fs2 from "fs";
import path2 from "path";
import ts from "typescript";

// src/cache/hash.ts
import crypto from "crypto";
function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, nestedValue]) => typeof nestedValue !== "function").sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)]));
  }
  return value;
}
function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}
function hashJson(value) {
  return hashContent(JSON.stringify(normalizeValue(value)));
}

// src/internal/bundle-location.ts
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
var bundleRequire = null;
var packageRoot = null;
function getBundleFilePath() {
  return fileURLToPath(__gcc_current_module_url);
}
function createBundleRequire() {
  bundleRequire ??= createRequire(__gcc_current_module_url);
  return bundleRequire;
}
function getPackageRootFromBundle() {
  if (packageRoot) {
    return packageRoot;
  }
  let currentDir = path.dirname(getBundleFilePath());
  while (true) {
    if (fs.existsSync(path.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package.json from bundled module path ${getBundleFilePath()}`);
    }
    currentDir = parentDir;
  }
}

// src/stages/native/compiler-options.ts
var RUNTIME_SPECIFIER = "gcc-ts-bundler/runtime";
var PACKAGE_ROOT = getPackageRootFromBundle();
var compilerOptionsCache = new Map;
async function loadCompilerOptions(configPath, extraOptions = {}) {
  const configStat = await fs2.promises.stat(configPath);
  const cacheKey = hashJson({
    configPath,
    extraOptions,
    mtimeMs: configStat.mtimeMs,
    size: configStat.size
  });
  const cached = compilerOptionsCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const configDir = path2.dirname(configPath);
  const runtimePaths = await shouldInjectRuntimePaths(configDir) ? {
    [RUNTIME_SPECIFIER]: [path2.join(PACKAGE_ROOT, "src", "runtime", "index.ts")]
  } : {};
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, `
`));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, configDir, {
    ...extraOptions,
    baseUrl: extraOptions.baseUrl ?? configFile.config.compilerOptions?.baseUrl ?? configDir,
    ignoreDeprecations: extraOptions.ignoreDeprecations ?? configFile.config.compilerOptions?.ignoreDeprecations ?? "6.0",
    paths: {
      ...configFile.config.compilerOptions?.paths ?? {},
      ...extraOptions.paths ?? {},
      ...runtimePaths
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, ts.createCompilerHost({})));
  }
  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
}
async function shouldInjectRuntimePaths(configDir) {
  let currentDir = configDir;
  while (true) {
    const packageJsonPath = path2.join(currentDir, "package.json");
    try {
      const raw = await fs2.promises.readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      return parsed.name === "gcc-ts-bundler";
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    const parentDir = path2.dirname(currentDir);
    if (parentDir === currentDir) {
      return false;
    }
    currentDir = parentDir;
  }
}

// src/api/externs.ts
var DECLARATION_EXTENSIONS = [
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".ts",
  ".tsx",
  ".mts",
  ".cts"
];
var BUILTIN_CONTAINER_NAMES = new Set([
  "Array",
  "AsyncIterable",
  "AsyncIterator",
  "Iterable",
  "Iterator",
  "Map",
  "Promise",
  "ReadonlyArray",
  "ReadonlyMap",
  "ReadonlySet",
  "Set",
  "String",
  "WeakMap",
  "WeakSet"
]);
var BUILTIN_RUNTIME_MEMBER_NAMES = new Set([
  "addEventListener",
  "apply",
  "attachShadow",
  "attributes",
  "length",
  "message",
  "name",
  "removeAttribute",
  "removeEventListener",
  "setAttribute"
]);
async function generateExterns(options) {
  if (options.modules.length === 0) {
    throw new Error("generateExterns requires at least one module specifier.");
  }
  const mode = options.mode ?? "boundary-aware";
  const projectRoot = path3.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path3.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath = options.tsConfigPath && path3.resolve(projectRoot, options.tsConfigPath);
  const compilerOptions = await loadExternCompilerOptions({
    projectRoot,
    tsConfigPath
  });
  const includeDependencies = options.includeDependencies ?? true;
  if (mode === "boundary-aware" && (options.appEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in boundary-aware mode requires appEntryFiles.");
  }
  if (mode === "runtime-aware" && (options.runtimeEntryFiles?.length ?? 0) === 0) {
    throw new Error("generateExterns in runtime-aware mode requires runtimeEntryFiles.");
  }
  const typeEntryFiles = await resolveModuleTypeEntries({
    compilerOptions,
    projectRoot,
    specifiers: options.modules,
    tolerateMissing: mode === "runtime-aware"
  });
  const scannedFiles = typeEntryFiles.length === 0 ? [] : await collectReachableTypeFiles({
    compilerOptions,
    entryFiles: typeEntryFiles,
    includeDependencies
  });
  const registry = scannedFiles.length === 0 ? createEmptyContractRegistry() : collectContracts(ts2.createProgram(scannedFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true
  }), scannedFiles);
  const text = mode === "candidates" ? renderCandidateExterns({
    modules: options.modules,
    registry,
    scannedFiles
  }) : mode === "boundary-aware" ? renderBoundaryAwareExterns({
    appEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.appEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    compilerOptions,
    modules: options.modules,
    projectRoot,
    registry,
    scannedFiles
  }) : await renderRuntimeAwareExterns({
    appEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.appEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    compilerOptions,
    modules: options.modules,
    projectRoot,
    registry,
    runtimeEntryFiles: resolveAnalysisEntryFiles({
      entryFiles: options.runtimeEntryFiles ?? [],
      projectRoot,
      srcDir
    }),
    scannedFiles
  });
  const outputFile = options.outputFile && path3.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await fs3.promises.mkdir(path3.dirname(outputFile), { recursive: true });
    await fs3.promises.writeFile(outputFile, text, "utf8");
  }
  return {
    mode,
    modules: [...options.modules],
    outputFile,
    scannedFiles,
    text
  };
}
async function loadExternCompilerOptions({
  projectRoot,
  tsConfigPath
}) {
  const fallbackOptions = {
    allowJs: true,
    baseUrl: projectRoot,
    module: ts2.ModuleKind.ESNext,
    moduleResolution: ts2.ModuleResolutionKind.Bundler,
    target: ts2.ScriptTarget.ESNext
  };
  const resolvedConfigPath = tsConfigPath ?? path3.join(projectRoot, "tsconfig.json");
  try {
    await fs3.promises.access(resolvedConfigPath, fs3.constants.R_OK);
    try {
      return await loadCompilerOptions(resolvedConfigPath, {
        allowJs: true,
        rootDir: projectRoot
      });
    } catch (error) {
      if (!isRecoverableExternConfigError(error)) {
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return fallbackOptions;
}
async function resolveModuleTypeEntry({
  compilerOptions,
  projectRoot,
  specifier
}) {
  const containingFile = path3.join(projectRoot, "__gcc_externs_entry__.ts");
  const resolution = ts2.resolveModuleName(specifier, containingFile, compilerOptions, ts2.sys).resolvedModule;
  const resolvedFromTypescript = resolution && normalizeResolvedTypeFile(resolution.resolvedFileName);
  if (resolvedFromTypescript) {
    return resolvedFromTypescript;
  }
  const require2 = ts2.createModuleResolutionCache(projectRoot, (fileName) => fileName, compilerOptions);
  const fallbackResolution = ts2.nodeModuleNameResolver(specifier, containingFile, compilerOptions, ts2.sys, require2).resolvedModule;
  const resolvedFromFallback = fallbackResolution && normalizeResolvedTypeFile(fallbackResolution.resolvedFileName);
  if (resolvedFromFallback) {
    return resolvedFromFallback;
  }
  throw new Error(`Unable to resolve TypeScript declarations for module ${JSON.stringify(specifier)} from ${projectRoot}.`);
}
async function resolveModuleTypeEntries({
  compilerOptions,
  projectRoot,
  specifiers,
  tolerateMissing
}) {
  const resolvedEntries = [];
  for (const specifier of specifiers) {
    try {
      resolvedEntries.push(await resolveModuleTypeEntry({
        compilerOptions,
        projectRoot,
        specifier
      }));
    } catch (error) {
      if (!tolerateMissing) {
        throw error;
      }
    }
  }
  return uniqueStrings(resolvedEntries);
}
function createEmptyContractRegistry() {
  return {
    classContracts: new Map,
    interfaceContracts: new Map,
    scannedFiles: new Set,
    typeAliasContracts: new Map
  };
}
function normalizeResolvedTypeFile(resolvedFileName) {
  const normalizedPath = path3.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }
  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (ts2.sys.fileExists(candidate)) {
      return path3.resolve(candidate);
    }
  }
  return null;
}
function withTypeExtension(filePath, nextExtension) {
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return filePath;
  }
  const extension = path3.extname(filePath);
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`;
}
async function collectReachableTypeFiles({
  compilerOptions,
  entryFiles,
  includeDependencies
}) {
  const rootPackageDirs = new Set(entryFiles.map((filePath) => findPackageDir(filePath)).filter((packageDir) => packageDir !== null));
  const queue = [...entryFiles];
  const seen = new Set;
  while (queue.length > 0) {
    const nextFile = queue.shift();
    if (!nextFile) {
      continue;
    }
    const resolvedFile = path3.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);
    const sourceText = await fs3.promises.readFile(resolvedFile, "utf8");
    const sourceFile = ts2.createSourceFile(resolvedFile, sourceText, ts2.ScriptTarget.Latest, true);
    for (const specifier of collectReferencedSpecifiers(sourceFile)) {
      const resolvedModule = ts2.resolveModuleName(specifier, resolvedFile, compilerOptions, ts2.sys).resolvedModule;
      if (!resolvedModule) {
        continue;
      }
      const normalizedDependency = normalizeResolvedTypeFile(resolvedModule.resolvedFileName);
      if (!normalizedDependency || isTypescriptLibFile(normalizedDependency)) {
        continue;
      }
      if (!includeDependencies) {
        const dependencyPackageDir = findPackageDir(normalizedDependency);
        if (dependencyPackageDir && !rootPackageDirs.has(dependencyPackageDir)) {
          continue;
        }
      }
      queue.push(normalizedDependency);
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}
function collectReferencedSpecifiers(sourceFile) {
  const specifiers = new Set;
  const add = (value) => {
    if (value) {
      specifiers.add(value);
    }
  };
  const visit = (node) => {
    if (ts2.isImportDeclaration(node) || ts2.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts2.isStringLiteralLike(moduleSpecifier)) {
        add(moduleSpecifier.text);
      }
    } else if (ts2.isImportEqualsDeclaration(node) && ts2.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts2.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text);
    } else if (ts2.isImportTypeNode(node) && ts2.isLiteralTypeNode(node.argument) && ts2.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text);
    }
    ts2.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}
function collectContracts(program, scannedFiles) {
  const checker = program.getTypeChecker();
  const scannedFileSet = new Set(scannedFiles.map((filePath) => path3.resolve(filePath)));
  const interfaceContracts = new Map;
  const typeAliasContracts = new Map;
  const classContracts = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(path3.resolve(sourceFile.fileName))) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (ts2.isInterfaceDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        interfaceContracts.set(symbol, {
          extends: getReferencedContractSymbols(statement.heritageClauses?.flatMap((clause) => clause.types) ?? [], checker, scannedFileSet),
          members: collectTypeElementMembers(statement.members),
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (ts2.isTypeAliasDeclaration(statement) && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const members = collectAliasMembers(statement.type);
        if (members.size === 0) {
          continue;
        }
        typeAliasContracts.set(symbol, {
          members,
          name: statement.name.text,
          symbol
        });
        continue;
      }
      if (ts2.isClassDeclaration(statement) && statement.name && isExportedDeclaration(statement)) {
        const symbol = checker.getSymbolAtLocation(statement.name);
        if (!symbol) {
          continue;
        }
        const instanceMembers = new Set;
        const staticMembers = new Set;
        for (const member of statement.members) {
          if (ts2.isConstructorDeclaration(member)) {
            continue;
          }
          if (hasNonPublicModifier(member)) {
            continue;
          }
          const memberName = getPropertyNameText(member.name);
          if (!memberName || !isExternPropertyName(memberName)) {
            continue;
          }
          if (hasStaticModifier(member)) {
            staticMembers.add(memberName);
          } else {
            instanceMembers.add(memberName);
          }
        }
        classContracts.set(symbol, {
          constructorParamContracts: collectConstructorParamContracts(statement, checker, scannedFileSet),
          instanceMembers,
          name: statement.name.text,
          staticMembers,
          symbol,
          usedImplementedContracts: getClassImplementedContracts(statement, checker, scannedFileSet)
        });
      }
    }
  }
  return {
    classContracts,
    interfaceContracts,
    scannedFiles: scannedFileSet,
    typeAliasContracts
  };
}
function renderCandidateExterns({
  modules,
  registry,
  scannedFiles
}) {
  return renderExternText({
    emittedLines: collectCandidateExternLines(registry),
    mode: "candidates",
    modules,
    scannedFiles
  });
}
function renderBoundaryAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  scannedFiles
}) {
  return renderExternText({
    emittedLines: collectBoundaryAwareExternLines({
      appEntryFiles,
      compilerOptions,
      projectRoot,
      registry
    }),
    mode: "boundary-aware",
    modules,
    scannedFiles
  });
}
async function renderRuntimeAwareExterns({
  appEntryFiles,
  compilerOptions,
  modules,
  projectRoot,
  registry,
  runtimeEntryFiles,
  scannedFiles
}) {
  const emittedLines = appEntryFiles.length > 0 ? collectBoundaryAwareExternLines({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry
  }) : collectCandidateExternLines(registry);
  const runtimeMembers = await analyzeRuntimeUsage(runtimeEntryFiles);
  for (const member of runtimeMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  return renderExternText({
    emittedLines,
    mode: "runtime-aware",
    modules,
    runtimeEntryFiles,
    scannedFiles
  });
}
function collectCandidateExternLines(registry) {
  const properties = new Set;
  for (const contract of registry.interfaceContracts.values()) {
    for (const member of collectStructuralContractMembers(contract.symbol, registry)) {
      properties.add(member);
    }
  }
  for (const contract of registry.typeAliasContracts.values()) {
    for (const member of contract.members) {
      properties.add(member);
    }
  }
  for (const contract of registry.classContracts.values()) {
    for (const member of contract.instanceMembers) {
      properties.add(member);
    }
  }
  return new Set([...properties].sort((left, right) => left.localeCompare(right)).map((property) => renderStructuralExternLine(property)));
}
function collectBoundaryAwareExternLines({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry
}) {
  const usage = analyzeAppUsage({
    appEntryFiles,
    compilerOptions,
    projectRoot,
    registry
  });
  const emittedLines = new Set;
  for (const symbol of usage.structuralContracts) {
    for (const member of collectStructuralContractMembers(symbol, registry)) {
      emittedLines.add(renderStructuralExternLine(member));
    }
  }
  for (const member of usage.structuralMembers) {
    emittedLines.add(renderStructuralExternLine(member));
  }
  for (const [symbol, members] of usage.nominalInstanceMembers) {
    const nominalTarget = resolveNominalInstanceTarget(symbol, registry);
    for (const member of members) {
      emittedLines.add(nominalTarget ? renderNominalInstanceExternLine(nominalTarget, member) : renderStructuralExternLine(member));
    }
  }
  for (const [symbol, members] of usage.nominalStaticMembers) {
    const nominalTarget = resolveNominalStaticTarget(symbol, registry);
    for (const member of members) {
      emittedLines.add(nominalTarget ? renderNominalStaticExternLine(nominalTarget, member) : renderStructuralExternLine(member));
    }
  }
  return emittedLines;
}
function renderExternText({
  emittedLines,
  mode,
  modules,
  runtimeEntryFiles = [],
  scannedFiles
}) {
  const scannedSummary = mode === "runtime-aware" ? `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"} and ${runtimeEntryFiles.length} runtime file${runtimeEntryFiles.length === 1 ? "" : "s"}.` : `// Scanned ${scannedFiles.length} type file${scannedFiles.length === 1 ? "" : "s"}.`;
  return [
    "/** @externs */",
    `// Generated by gcc-ts-bundler for: ${modules.join(", ")}`,
    `// Mode: ${mode}`,
    scannedSummary,
    "",
    ...[...emittedLines].sort((left, right) => left.localeCompare(right)),
    ""
  ].join(`
`);
}
function resolveAnalysisEntryFiles({
  entryFiles,
  projectRoot,
  srcDir
}) {
  return entryFiles.map((entry) => {
    if (path3.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path3.resolve(srcDir, entry);
    if (ts2.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path3.resolve(projectRoot, entry);
  });
}
async function analyzeRuntimeUsage(runtimeEntryFiles) {
  const structuralMembers = new Set;
  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs3.promises.readFile(runtimeEntryFile, "utf8");
    const sourceFile = ts2.createSourceFile(runtimeEntryFile, sourceText, ts2.ScriptTarget.Latest, true, getScriptKindForFile(runtimeEntryFile));
    const knownConstructors = collectKnownConstructorBindings(sourceFile);
    const visit = (node) => {
      if (ts2.isClassDeclaration(node) || ts2.isClassExpression(node)) {
        for (const member of node.members) {
          if (ts2.isPropertyDeclaration(member) || ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member)) {
            const memberName = getPropertyNameText(member.name);
            if (memberName && isRuntimeExternPropertyName(memberName)) {
              structuralMembers.add(memberName);
            }
          }
        }
      } else if (ts2.isPropertyAccessExpression(node)) {
        if (isThisOrSuperExpression(node.expression) && isRuntimeExternPropertyName(node.name.text)) {
          structuralMembers.add(node.name.text);
        }
      } else if (ts2.isElementAccessExpression(node)) {
        const memberName = getStringLiteralMemberName(node.argumentExpression);
        if (memberName && isThisOrSuperExpression(node.expression) && isRuntimeExternPropertyName(memberName)) {
          structuralMembers.add(memberName);
        }
      } else if (ts2.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        collectRuntimeAssignmentMembers(node.left, knownConstructors, structuralMembers);
      } else if (ts2.isCallExpression(node)) {
        collectRuntimeCallMembers(node, knownConstructors, structuralMembers);
      }
      ts2.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return structuralMembers;
}
function collectKnownConstructorBindings(sourceFile) {
  const knownConstructors = new Set;
  const visit = (node) => {
    if ((ts2.isClassDeclaration(node) || ts2.isFunctionDeclaration(node)) && node.name) {
      knownConstructors.add(node.name.text);
    } else if (ts2.isVariableDeclaration(node) && ts2.isIdentifier(node.name) && node.initializer && (ts2.isClassExpression(node.initializer) || ts2.isFunctionExpression(node.initializer) || ts2.isArrowFunction(node.initializer))) {
      knownConstructors.add(node.name.text);
    }
    ts2.forEachChild(node, visit);
  };
  visit(sourceFile);
  return knownConstructors;
}
function collectRuntimeAssignmentMembers(target, knownConstructors, structuralMembers) {
  if (ts2.isPropertyAccessExpression(target)) {
    if (isThisOrSuperExpression(target.expression) || isKnownPrototypeExpression(target.expression, knownConstructors) || isKnownConstructorExpression(target.expression, knownConstructors)) {
      if (isRuntimeExternPropertyName(target.name.text)) {
        structuralMembers.add(target.name.text);
      }
    }
    return;
  }
  if (ts2.isElementAccessExpression(target)) {
    const memberName = getStringLiteralMemberName(target.argumentExpression);
    if (memberName && (isThisOrSuperExpression(target.expression) || isKnownPrototypeExpression(target.expression, knownConstructors) || isKnownConstructorExpression(target.expression, knownConstructors)) && isRuntimeExternPropertyName(memberName)) {
      structuralMembers.add(memberName);
    }
  }
}
function collectRuntimeCallMembers(node, knownConstructors, structuralMembers) {
  const callee = node.expression;
  if (ts2.isIdentifier(callee) && callee.text === "__publicField" && node.arguments.length >= 2) {
    const memberName2 = getStringLiteralMemberName(node.arguments[1]);
    if (memberName2 && (isThisOrSuperExpression(node.arguments[0]) || isKnownConstructorExpression(node.arguments[0], knownConstructors)) && isRuntimeExternPropertyName(memberName2)) {
      structuralMembers.add(memberName2);
    }
    return;
  }
  if (!isObjectDefinePropertyCall(callee) || node.arguments.length < 2) {
    return;
  }
  const memberName = getStringLiteralMemberName(node.arguments[1]);
  if (!memberName || !isRuntimeExternPropertyName(memberName)) {
    return;
  }
  const target = node.arguments[0];
  if (isThisOrSuperExpression(target) || isKnownConstructorExpression(target, knownConstructors) || isKnownPrototypeExpression(target, knownConstructors)) {
    structuralMembers.add(memberName);
  }
}
function analyzeAppUsage({
  appEntryFiles,
  compilerOptions,
  projectRoot,
  registry
}) {
  const program = ts2.createProgram(appEntryFiles, {
    ...compilerOptions,
    noEmit: true,
    skipLibCheck: true
  });
  const checker = program.getTypeChecker();
  const usage = {
    nominalInstanceMembers: new Map,
    nominalStaticMembers: new Map,
    structuralContracts: new Set,
    structuralMembers: new Set
  };
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => isProjectAppSourceFile(sourceFile.fileName, projectRoot));
  for (const sourceFile of sourceFiles) {
    const importBindings = collectImportedClassBindings(sourceFile, registry);
    const localBindings = new Map;
    const visit = (node) => {
      if (ts2.isClassDeclaration(node)) {
        const fieldBindings = collectClassFieldBindings(node, importBindings);
        const classVisit = (child) => {
          if (ts2.isNewExpression(child)) {
            analyzeNewExpression(child, checker, registry, usage, importBindings, localBindings);
          } else if (ts2.isPropertyAccessExpression(child)) {
            analyzePropertyAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (ts2.isElementAccessExpression(child) && ts2.isStringLiteral(child.argumentExpression)) {
            analyzeElementAccess(child, checker, registry, usage, importBindings, localBindings, fieldBindings);
          } else if (ts2.isVariableDeclaration(child)) {
            registerVariableBinding(child, importBindings, localBindings);
          }
          ts2.forEachChild(child, classVisit);
        };
        ts2.forEachChild(node, classVisit);
        return;
      }
      if (ts2.isVariableDeclaration(node)) {
        registerVariableBinding(node, importBindings, localBindings);
      } else if (ts2.isNewExpression(node)) {
        analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings);
      } else if (ts2.isPropertyAccessExpression(node)) {
        analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      } else if (ts2.isElementAccessExpression(node) && ts2.isStringLiteral(node.argumentExpression)) {
        analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, new Map);
      }
      ts2.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return usage;
}
function analyzeNewExpression(node, checker, registry, usage, importBindings, localBindings) {
  const calleeSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, new Map) ?? resolveValueSymbol(node.expression, checker) ?? resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!calleeSymbol) {
    return;
  }
  const classContract = registry.classContracts.get(calleeSymbol);
  if (!classContract) {
    return;
  }
  for (const symbol of classContract.usedImplementedContracts) {
    usage.structuralContracts.add(symbol);
  }
  for (const [index, contractSymbols] of classContract.constructorParamContracts.entries()) {
    const argument = node.arguments?.[index];
    if (!argument || !isStructuralBoundaryArgument(argument)) {
      continue;
    }
    for (const symbol of contractSymbols) {
      usage.structuralContracts.add(symbol);
    }
  }
}
function analyzePropertyAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const propertyName = node.name.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  if (ts2.isIdentifier(node.expression) && importBindings.has(node.expression.text)) {
    const targetSymbol = importBindings.get(node.expression.text);
    if (targetSymbol) {
      const classContract = registry.classContracts.get(targetSymbol);
      if (classContract && classContract.staticMembers.has(propertyName)) {
        addMapSetValue(usage.nominalStaticMembers, targetSymbol, propertyName);
        return;
      }
    }
  }
  const boundInstanceSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundInstanceSymbol && registry.classContracts.has(boundInstanceSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundInstanceSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function analyzeElementAccess(node, checker, registry, usage, importBindings, localBindings, fieldBindings) {
  const argumentExpression = node.argumentExpression;
  if (!ts2.isStringLiteral(argumentExpression)) {
    return;
  }
  const propertyName = argumentExpression.text;
  if (!isExternPropertyName(propertyName)) {
    return;
  }
  const boundSymbol = resolveBoundClassSymbol(node.expression, importBindings, localBindings, fieldBindings);
  if (boundSymbol && registry.classContracts.has(boundSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, boundSymbol, propertyName);
    return;
  }
  const typeSymbol = resolveTypeSymbol(checker.getTypeAtLocation(node.expression), checker);
  if (!typeSymbol) {
    return;
  }
  if (registry.classContracts.has(typeSymbol)) {
    addMapSetValue(usage.nominalInstanceMembers, typeSymbol, propertyName);
    return;
  }
  if (registry.interfaceContracts.has(typeSymbol) || registry.typeAliasContracts.has(typeSymbol)) {
    usage.structuralMembers.add(propertyName);
  }
}
function collectImportedClassBindings(sourceFile, registry) {
  const bindings = new Map;
  for (const statement of sourceFile.statements) {
    if (!ts2.isImportDeclaration(statement) || !statement.importClause) {
      continue;
    }
    const clause = statement.importClause;
    if (clause.name) {
      const symbol = findClassContractByName(clause.name.text, registry);
      if (symbol) {
        bindings.set(clause.name.text, symbol);
      }
    }
    const namedBindings = clause.namedBindings;
    if (!namedBindings || !ts2.isNamedImports(namedBindings)) {
      continue;
    }
    for (const specifier of namedBindings.elements) {
      const importedName = specifier.propertyName?.text ?? specifier.name.text;
      const symbol = findClassContractByName(importedName, registry);
      if (symbol) {
        bindings.set(specifier.name.text, symbol);
      }
    }
  }
  return bindings;
}
function collectClassFieldBindings(declaration, importBindings) {
  const bindings = new Map;
  for (const member of declaration.members) {
    if (!ts2.isPropertyDeclaration(member) || !member.initializer || !ts2.isIdentifier(member.name) || !ts2.isNewExpression(member.initializer) || !ts2.isIdentifier(member.initializer.expression)) {
      continue;
    }
    const classSymbol = importBindings.get(member.initializer.expression.text);
    if (classSymbol) {
      bindings.set(member.name.text, classSymbol);
    }
  }
  return bindings;
}
function registerVariableBinding(declaration, importBindings, localBindings) {
  if (!ts2.isIdentifier(declaration.name) || !declaration.initializer || !ts2.isNewExpression(declaration.initializer) || !ts2.isIdentifier(declaration.initializer.expression)) {
    return;
  }
  const classSymbol = importBindings.get(declaration.initializer.expression.text);
  if (classSymbol) {
    localBindings.set(declaration.name.text, classSymbol);
  }
}
function resolveBoundClassSymbol(expression, importBindings, localBindings, fieldBindings) {
  if (ts2.isIdentifier(expression)) {
    return localBindings.get(expression.text) ?? importBindings.get(expression.text) ?? null;
  }
  if (ts2.isPropertyAccessExpression(expression) && expression.expression.kind === ts2.SyntaxKind.ThisKeyword) {
    return fieldBindings.get(expression.name.text) ?? null;
  }
  return null;
}
function findClassContractByName(name, registry) {
  for (const [symbol, contract] of registry.classContracts) {
    if (contract.name === name) {
      return symbol;
    }
  }
  return null;
}
function collectStructuralContractMembers(symbol, registry, seen = new Set) {
  if (seen.has(symbol)) {
    return new Set;
  }
  seen.add(symbol);
  const interfaceContract = registry.interfaceContracts.get(symbol);
  if (interfaceContract) {
    const members = new Set(interfaceContract.members);
    for (const extendedSymbol of interfaceContract.extends) {
      for (const member of collectStructuralContractMembers(extendedSymbol, registry, seen)) {
        members.add(member);
      }
    }
    return members;
  }
  const typeAliasContract = registry.typeAliasContracts.get(symbol);
  if (typeAliasContract) {
    return new Set(typeAliasContract.members);
  }
  return new Set;
}
function collectTypeElementMembers(members) {
  const collected = new Set;
  for (const member of members) {
    if (ts2.isPropertySignature(member) || ts2.isMethodSignature(member) || ts2.isGetAccessorDeclaration(member) || ts2.isSetAccessorDeclaration(member)) {
      const memberName = getPropertyNameText(member.name);
      if (memberName && isExternPropertyName(memberName)) {
        collected.add(memberName);
      }
    }
  }
  return collected;
}
function collectAliasMembers(typeNode) {
  if (ts2.isTypeLiteralNode(typeNode)) {
    return collectTypeElementMembers(typeNode.members);
  }
  if (ts2.isIntersectionTypeNode(typeNode)) {
    const members = new Set;
    for (const child of typeNode.types) {
      for (const member of collectAliasMembers(child)) {
        members.add(member);
      }
    }
    return members;
  }
  return new Set;
}
function getReferencedContractSymbols(typeNodes, checker, scannedFiles) {
  const symbols = new Set;
  for (const typeNode of typeNodes) {
    for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
      symbols.add(symbol);
    }
  }
  return symbols;
}
function getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles) {
  if (ts2.isExpressionWithTypeArguments(typeNode)) {
    const symbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
    return symbol && isScannedDeclarationSymbol(symbol, scannedFiles) ? new Set([symbol]) : new Set;
  }
  if (ts2.isParenthesizedTypeNode(typeNode)) {
    return getContractSymbolsFromTypeNode(typeNode.type, checker, scannedFiles);
  }
  if (ts2.isIntersectionTypeNode(typeNode) || ts2.isUnionTypeNode(typeNode)) {
    const symbols = new Set;
    for (const child of typeNode.types) {
      for (const symbol of getContractSymbolsFromTypeNode(child, checker, scannedFiles)) {
        symbols.add(symbol);
      }
    }
    return symbols;
  }
  if (ts2.isTypeReferenceNode(typeNode)) {
    return getContractSymbolsFromEntityName(typeNode.typeName, checker, scannedFiles);
  }
  return new Set;
}
function getContractSymbolsFromEntityName(entityName, checker, scannedFiles) {
  const symbol = ts2.isIdentifier(entityName) ? checker.getSymbolAtLocation(entityName) : checker.getSymbolAtLocation(entityName.right);
  const resolved = resolveAliasedSymbol(symbol, checker);
  if (!resolved) {
    return new Set;
  }
  return isScannedDeclarationSymbol(resolved, scannedFiles) ? new Set([resolved]) : new Set;
}
function collectConstructorParamContracts(statement, checker, scannedFiles) {
  const constructorDeclaration = statement.members.find((member) => ts2.isConstructorDeclaration(member));
  if (!constructorDeclaration || !ts2.isConstructorDeclaration(constructorDeclaration)) {
    return [];
  }
  return constructorDeclaration.parameters.map((parameter) => parameter.type ? getContractSymbolsFromTypeNode(parameter.type, checker, scannedFiles) : new Set);
}
function getClassImplementedContracts(statement, checker, scannedFiles, seen = new Set) {
  const contracts = new Set;
  const classSymbol = statement.name && checker.getSymbolAtLocation(statement.name);
  const classKey = classSymbol ? symbolCacheKey(classSymbol) : "";
  if (classKey && seen.has(classKey)) {
    return contracts;
  }
  if (classKey) {
    seen.add(classKey);
  }
  for (const clause of statement.heritageClauses ?? []) {
    if (clause.token === ts2.SyntaxKind.ImplementsKeyword) {
      for (const typeNode of clause.types) {
        for (const symbol of getContractSymbolsFromTypeNode(typeNode, checker, scannedFiles)) {
          contracts.add(symbol);
        }
      }
      continue;
    }
    if (clause.token === ts2.SyntaxKind.ExtendsKeyword) {
      for (const typeNode of clause.types) {
        const baseSymbol = resolveAliasedSymbol(checker.getSymbolAtLocation(typeNode.expression), checker);
        if (!baseSymbol) {
          continue;
        }
        const declaration = baseSymbol.declarations?.find((item) => ts2.isClassDeclaration(item));
        if (declaration && ts2.isClassDeclaration(declaration)) {
          for (const symbol of getClassImplementedContracts(declaration, checker, scannedFiles, seen)) {
            contracts.add(symbol);
          }
        }
      }
    }
  }
  return contracts;
}
function isStructuralBoundaryArgument(expression) {
  return !(ts2.isArrayLiteralExpression(expression) || ts2.isObjectLiteralExpression(expression) || ts2.isStringLiteralLike(expression) || ts2.isNumericLiteral(expression) || expression.kind === ts2.SyntaxKind.TrueKeyword || expression.kind === ts2.SyntaxKind.FalseKeyword || expression.kind === ts2.SyntaxKind.NullKeyword);
}
function resolveTypeSymbol(type, checker) {
  const symbol = type.getSymbol();
  if (!symbol && type.isUnionOrIntersection()) {
    for (const child of type.types) {
      const childSymbol = resolveTypeSymbol(child, checker);
      if (childSymbol) {
        return childSymbol;
      }
    }
    return null;
  }
  return resolveAliasedSymbol(symbol, checker);
}
function resolveValueSymbol(node, checker) {
  return resolveAliasedSymbol(checker.getSymbolAtLocation(node), checker);
}
function resolveAliasedSymbol(symbol, checker) {
  if (!symbol) {
    return null;
  }
  return symbol.flags & ts2.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}
function resolveNominalInstanceTarget(symbol, registry) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}
function resolveNominalStaticTarget(symbol, registry) {
  const contract = registry.classContracts.get(symbol);
  if (!contract) {
    return null;
  }
  return isAmbientGlobalSymbol(symbol) ? contract.name : null;
}
function isAmbientGlobalSymbol(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !ts2.isExternalModule(sourceFile);
  });
}
function renderStructuralExternLine(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `Object.prototype.${name};` : `Object.prototype[${JSON.stringify(name)}];`;
}
function renderNominalInstanceExternLine(target, name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${target}.prototype.${name};` : `${target}.prototype[${JSON.stringify(name)}];`;
}
function renderNominalStaticExternLine(target, name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `${target}.${name};` : `${target}[${JSON.stringify(name)}];`;
}
function addMapSetValue(map, key, value) {
  const current = map.get(key);
  if (current) {
    current.add(value);
    return;
  }
  map.set(key, new Set([value]));
}
function isProjectAppSourceFile(filePath, projectRoot) {
  const resolvedFilePath = path3.resolve(filePath);
  return !resolvedFilePath.includes(`${path3.sep}node_modules${path3.sep}`) && !resolvedFilePath.endsWith(".d.ts") && resolvedFilePath.startsWith(path3.resolve(projectRoot) + path3.sep);
}
function isExportedDeclaration(node) {
  return (ts2.getCombinedModifierFlags(node) & ts2.ModifierFlags.Export) !== 0;
}
function hasStaticModifier(node) {
  return (ts2.getCombinedModifierFlags(node) & ts2.ModifierFlags.Static) !== 0;
}
function hasNonPublicModifier(node) {
  const modifierFlags = ts2.getCombinedModifierFlags(node);
  return (modifierFlags & ts2.ModifierFlags.Private) !== 0 || (modifierFlags & ts2.ModifierFlags.Protected) !== 0;
}
function getPropertyNameText(name) {
  if (!name) {
    return null;
  }
  if (ts2.isIdentifier(name) || ts2.isStringLiteral(name) || ts2.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}
function getStringLiteralMemberName(expression) {
  if (!expression) {
    return null;
  }
  return ts2.isStringLiteral(expression) || ts2.isNoSubstitutionTemplateLiteral(expression) ? expression.text : null;
}
function isExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !name.startsWith("_") && !name.startsWith("$") && !BUILTIN_CONTAINER_NAMES.has(name);
}
function isRuntimeExternPropertyName(name) {
  return name !== "prototype" && name !== "constructor" && !name.startsWith("#") && !name.includes("@") && !BUILTIN_CONTAINER_NAMES.has(name) && !BUILTIN_RUNTIME_MEMBER_NAMES.has(name);
}
function isThisOrSuperExpression(expression) {
  return expression.kind === ts2.SyntaxKind.ThisKeyword || expression.kind === ts2.SyntaxKind.SuperKeyword;
}
function isKnownConstructorExpression(expression, knownConstructors) {
  return ts2.isIdentifier(expression) && knownConstructors.has(expression.text);
}
function isKnownPrototypeExpression(expression, knownConstructors) {
  return ts2.isPropertyAccessExpression(expression) && expression.name.text === "prototype" && isKnownConstructorExpression(expression.expression, knownConstructors);
}
function isObjectDefinePropertyCall(expression) {
  return ts2.isPropertyAccessExpression(expression) && ts2.isIdentifier(expression.expression) && expression.expression.text === "Object" && expression.name.text === "defineProperty";
}
function isAssignmentOperator(kind) {
  return kind === ts2.SyntaxKind.EqualsToken || kind === ts2.SyntaxKind.BarBarEqualsToken || kind === ts2.SyntaxKind.AmpersandAmpersandEqualsToken || kind === ts2.SyntaxKind.QuestionQuestionEqualsToken;
}
function getScriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return ts2.ScriptKind.TSX;
  }
  if (filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts")) {
    return ts2.ScriptKind.TS;
  }
  if (filePath.endsWith(".jsx")) {
    return ts2.ScriptKind.JSX;
  }
  return ts2.ScriptKind.JS;
}
function isScannedDeclarationSymbol(symbol, scannedFiles) {
  return (symbol.declarations ?? []).some((declaration) => scannedFiles.has(path3.resolve(declaration.getSourceFile().fileName)));
}
function findPackageDir(filePath) {
  let currentDir = path3.dirname(filePath);
  while (true) {
    const packageJsonPath = path3.join(currentDir, "package.json");
    if (ts2.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = path3.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}
function isTypeSourceFile(filePath) {
  return DECLARATION_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}
function isTypescriptLibFile(filePath) {
  return filePath.includes(`${path3.sep}node_modules${path3.sep}typescript${path3.sep}lib${path3.sep}`);
}
function symbolCacheKey(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration ? `${path3.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}` : symbol.getName();
}
function uniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function isRecoverableExternConfigError(error) {
  return error instanceof Error && (error.message.includes("TS18003") || error.message.includes("No inputs were found in config file"));
}

// src/cli/parse-options.ts
import minimist from "minimist";

// src/api/types.ts
var DEFAULT_BUILD_OPTIONS = Object.freeze({
  cache: {
    dir: "",
    mode: "persistent"
  },
  compilationLevel: "ADVANCED",
  chunks: {
    baseChunkName: "main",
    manifestFile: "",
    mode: "off",
    publicPath: "./"
  },
  diagnostics: {
    fatalWarnings: false,
    preflight: "errors-only",
    verbose: false
  },
  entries: [],
  externs: [],
  js: [],
  languageOut: "ECMASCRIPT_NEXT",
  outDir: "",
  outputNames: [],
  packages: {
    mode: "esm-only"
  },
  projectRoot: "",
  srcDir: ""
});

// src/cli/parse-externs-options.ts
import minimist2 from "minimist";

// src/pipeline/build-pipeline.ts
import path10 from "path";
import fs10 from "fs";

// src/cache/store.ts
import fs4 from "fs";
import os from "os";
import path4 from "path";
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return path4.join(os.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return path4.join(process.env.LOCALAPPDATA ?? path4.join(os.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return path4.join(process.env.XDG_CACHE_HOME ?? path4.join(os.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await fs4.promises.mkdtemp(path4.join(os.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = path4.join(rootDir2, "workspace");
    await fs4.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await fs4.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = path4.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path4.join(rootDir, hashContent(projectRoot));
  const workspaceDir = path4.join(projectCacheDir, "workspace");
  await fs4.promises.mkdir(workspaceDir, { recursive: true });
  return {
    async cleanup() {},
    mode,
    projectCacheDir,
    rootDir,
    workspaceDir
  };
}
async function readJsonIfExists(filePath) {
  try {
    const raw = await fs4.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function writeJson(filePath, value) {
  await ensureDirectoryExistence(filePath);
  await fs4.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
async function ensureDirectoryExistence(filePath) {
  await fs4.promises.mkdir(path4.dirname(filePath), { recursive: true });
}

// src/internal/file-state.ts
import fs6 from "fs";
import path6 from "path";

// src/native/index.ts
import fs5 from "fs";
import path5 from "path";
var require2 = createBundleRequire();
var SUPPORTED_TARGETS = {
  "darwin-arm64": "gcc-ts-bundler-darwin-arm64",
  "darwin-x64": "gcc-ts-bundler-darwin-x64",
  "linux-arm64-gnu": "gcc-ts-bundler-linux-arm64-gnu",
  "linux-arm64-musl": "gcc-ts-bundler-linux-arm64-musl",
  "linux-x64-gnu": "gcc-ts-bundler-linux-x64-gnu",
  "linux-x64-musl": "gcc-ts-bundler-linux-x64-musl",
  "win32-arm64-msvc": "gcc-ts-bundler-win32-arm64-msvc",
  "win32-x64-msvc": "gcc-ts-bundler-win32-x64-msvc"
};
function detectLinuxLibc() {
  const report = process.report?.getReport?.();
  if (report?.header?.glibcVersionRuntime) {
    return "gnu";
  }
  try {
    const { execFileSync } = require2("node:child_process");
    const output = execFileSync("ldd", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.includes("musl") ? "musl" : "gnu";
  } catch {}
  return "musl";
}
function getTargetKey() {
  if (process.platform === "linux") {
    return `${process.platform}-${process.arch}-${detectLinuxLibc()}`;
  }
  if (process.platform === "win32") {
    return `${process.platform}-${process.arch}-msvc`;
  }
  return `${process.platform}-${process.arch}`;
}
function loadNativeBinding() {
  const targetKey = getTargetKey();
  const packageName = SUPPORTED_TARGETS[targetKey];
  const loadErrors = [];
  if (packageName) {
    try {
      return require2(packageName);
    } catch (error) {
      loadErrors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const localFallbackPath = path5.join(getPackageRootFromBundle(), "native", "index.node");
  if (fs5.existsSync(localFallbackPath)) {
    return require2(localFallbackPath);
  }
  const supportedTargets = Object.keys(SUPPORTED_TARGETS).join(", ");
  const details = loadErrors.length > 0 ? ` Tried ${loadErrors.join("; ")}.` : "";
  throw new Error(`No native binding available for ${targetKey}. Supported targets: ${supportedTargets}.${details}`);
}
var native_default = loadNativeBinding();

// src/native/load.ts
var cachedBinding = null;
function loadBinding() {
  if (cachedBinding) {
    return cachedBinding;
  }
  cachedBinding = native_default;
  return cachedBinding;
}
function resolveGraph(input) {
  const result = loadBinding().resolveGraph(input.entries, input.srcDir, input.workspaceDir, input.packageMode);
  return {
    entries: result.entries,
    fileHashes: Object.fromEntries(result.fileHashes.map((entry) => [entry.filePath, entry.hash])),
    graph: Object.fromEntries(result.graph.map((entry) => [entry.filePath, entry.dependencies])),
    lazyImports: result.lazyImports,
    packageAliases: result.packageAliases,
    packageJsonFiles: result.packageJsonFiles,
    sourceFiles: result.sourceFiles,
    trackedFiles: result.trackedFiles
  };
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.metadataPath, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? [], input.lazyImports ?? []);
}
function writeEntryShims(input) {
  return loadBinding().writeEntryShims(input.entries);
}
function collectFileStates(filePaths) {
  return loadBinding().collectFileStates(filePaths);
}
function collectPublishedOutputStats(filePaths) {
  return loadBinding().collectPublishedOutputStats(filePaths);
}
function matchFileStates(expected) {
  return loadBinding().matchFileStates(expected);
}
function publishedOutputSnapshotMatches(publishedOutputs, outDir) {
  return loadBinding().publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
function publishedOutputsMatch(outputFiles, outDir) {
  return loadBinding().publishedOutputsMatch(outputFiles, outDir);
}

// src/internal/file-state.ts
function uniqueSorted(filePaths) {
  return [...new Set(filePaths)].sort((left, right) => left.localeCompare(right));
}
async function collectTrackedFiles(filePaths) {
  const states = collectFileStates(uniqueSorted(filePaths));
  return Object.fromEntries(states.filter((state) => state.exists).map((state) => [
    state.filePath,
    {
      mtimeMs: state.mtimeMs,
      size: state.size
    }
  ]));
}
async function trackedFilesMatch(trackedFiles) {
  return matchFileStates(Object.entries(trackedFiles).map(([filePath, state]) => ({
    exists: true,
    filePath,
    mtimeMs: state.mtimeMs,
    size: state.size
  })));
}
async function filesExist(filePaths) {
  return collectFileStates(uniqueSorted(filePaths)).every((state) => state.exists);
}
async function publishedOutputsMatch2(outputFiles, outDir) {
  return publishedOutputsMatch(uniqueSorted(outputFiles), outDir);
}
async function publishedOutputsMatchSnapshot(publishedOutputs, outDir) {
  return publishedOutputSnapshotMatches(publishedOutputs, outDir);
}
async function collectPublishedOutputStats2(outputFiles) {
  return collectPublishedOutputStats(uniqueSorted(outputFiles));
}
async function copyOrLinkFiles(sourceFiles, outDir) {
  await fs6.promises.rm(outDir, { force: true, recursive: true });
  await fs6.promises.mkdir(outDir, { recursive: true });
  await Promise.all(sourceFiles.map(async (sourceFile) => {
    const destinationFile = path6.join(outDir, path6.basename(sourceFile));
    try {
      await fs6.promises.link(sourceFile, destinationFile);
    } catch (error) {
      const code = error.code;
      if (code !== "EXDEV" && code !== "EEXIST" && code !== "EPERM") {
        throw error;
      }
      await fs6.promises.copyFile(sourceFile, destinationFile);
    }
  }));
}

// src/pipeline/resolve-build.ts
import fs7 from "fs";
import path7 from "path";
import ts3 from "typescript";
async function createBuildContext(options) {
  const packageRoot2 = getPackageRoot();
  const usesPersistentCache = options.cache.mode === "persistent";
  return {
    options,
    optionsSignature: getOptionsSignature(options),
    packageRoot: packageRoot2,
    packageSignature: usesPersistentCache ? await getPackageSignature(packageRoot2) : "",
    projectCacheDir: path7.join(path7.resolve(options.cache.dir || getDefaultPersistentCacheRoot()), hashContent(options.projectRoot))
  };
}
async function resolveBuild(context) {
  const { options } = context;
  if (options.entries.length === 0) {
    throw new Error("At least one entry is required.");
  }
  const cacheStore = await createCacheStore({
    cacheDir: options.cache.dir || undefined,
    mode: options.cache.mode,
    projectRoot: options.projectRoot
  });
  const usesPersistentCache = options.cache.mode === "persistent";
  const sourceRoot = path7.join(cacheStore.workspaceDir, "src");
  await ensureDirectorySymlink(sourceRoot, options.srcDir);
  await ensureWorkspaceNodeModules(cacheStore.workspaceDir, options);
  const tsConfigPath = await resolveTsConfigPath(options.projectRoot);
  const compilerOptionsHash = usesPersistentCache ? await hashTsConfig(tsConfigPath) : "";
  const entryRelativePaths = options.entries.map((entry) => path7.relative(options.srcDir, entry));
  const overlayEntries = options.entries.map((entry) => path7.join(sourceRoot, path7.relative(options.srcDir, entry)));
  const resolveSnapshotPath = path7.join(cacheStore.projectCacheDir, "resolve", "latest.json");
  const cachedSnapshot = usesPersistentCache ? await readJsonIfExists(resolveSnapshotPath) : null;
  if (cachedSnapshot && Array.isArray(cachedSnapshot.packageAliases) && Array.isArray(cachedSnapshot.sourceFiles) && Array.isArray(cachedSnapshot.packageJsonFiles) && cachedSnapshot.packageSignature === context.packageSignature && cachedSnapshot.compilerOptionsHash === compilerOptionsHash && cachedSnapshot.optionsSignature === context.optionsSignature && await trackedFilesMatch(cachedSnapshot.trackedFiles)) {
    const entryFiles2 = cachedSnapshot.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
    const shimDir2 = path7.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    return {
      cleanup: cacheStore.cleanup,
      chunkPlan: await readChunkPlan(cacheStore.projectCacheDir, cachedSnapshot.resolveKey),
      entryFiles: entryFiles2,
      lazyImports: cachedSnapshot.lazyImports ?? [],
      packageAliases: cachedSnapshot.packageAliases,
      packageJsonFiles: cachedSnapshot.packageJsonFiles,
      finalCacheDir: path7.join(cacheStore.projectCacheDir, "final", cachedSnapshot.finalKey),
      finalKey: cachedSnapshot.finalKey,
      nativeEmitCacheDir: path7.join(cacheStore.projectCacheDir, "native-emit", cachedSnapshot.nativeEmitKey),
      shimDir: shimDir2,
      shimFiles: shimFiles2,
      sourceFiles: cachedSnapshot.sourceFiles,
      trackedFiles: cachedSnapshot.trackedFiles,
      tsConfigPath,
      workspaceDir: cacheStore.workspaceDir
    };
  }
  const graphResult = resolveGraph({
    entries: overlayEntries,
    packageMode: options.packages.mode,
    srcDir: sourceRoot,
    workspaceDir: cacheStore.workspaceDir
  });
  const outputNames = resolveOutputNames(entryRelativePaths, options.outputNames);
  const resolvedLazyImports = assignLazyRuntimeBindings(graphResult.lazyImports);
  const resolveKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    entries: entryRelativePaths,
    files: graphResult.fileHashes,
    packageSignature: context.packageSignature
  }) : "active";
  const resolveMetadataPath = path7.join(cacheStore.projectCacheDir, "resolve", `${resolveKey}.json`);
  let resolveMetadata = usesPersistentCache ? await readJsonIfExists(resolveMetadataPath) : null;
  if (!resolveMetadata) {
    const entryFiles2 = graphResult.entries.map((entry, index) => ({
      chunkName: sanitizeChunkName(outputNames[index]),
      exportNames: entry.exportNames,
      hasDefaultExport: entry.hasDefaultExport,
      outputName: outputNames[index],
      sourcePath: entry.sourcePath,
      sourceRelativePath: path7.relative(sourceRoot, entry.sourcePath)
    }));
    const shimDir2 = path7.join(cacheStore.workspaceDir, "entries");
    const shimFiles2 = toShimFiles(entryFiles2, shimDir2);
    resolveMetadata = {
      chunkPlan: buildChunkPlan({
        chunkOptions: options.chunks,
        entryFiles: entryFiles2,
        graph: {
          ...graphResult.graph,
          ...Object.fromEntries(shimFiles2.map((shimFile, index) => [
            shimFile,
            [entryFiles2[index].sourcePath]
          ]))
        },
        lazyImports: resolvedLazyImports,
        shimFiles: shimFiles2,
        workspaceDir: cacheStore.workspaceDir
      }),
      entryFiles: entryFiles2.map((entry) => ({
        chunkName: entry.chunkName,
        exportNames: entry.exportNames,
        hasDefaultExport: entry.hasDefaultExport,
        outputName: entry.outputName,
        sourceRelativePath: entry.sourceRelativePath
      })),
      lazyImports: resolvedLazyImports
    };
    if (usesPersistentCache) {
      await writeJson(resolveMetadataPath, resolveMetadata);
    }
  }
  const entryFiles = resolveMetadata.entryFiles.map((entry) => toBuildEntry(entry, sourceRoot));
  const shimDir = path7.join(cacheStore.workspaceDir, "entries");
  const shimFiles = toShimFiles(entryFiles, shimDir);
  const nativeEmitKey = usesPersistentCache ? hashJson({
    compilerOptionsHash,
    diagnostics: options.diagnostics,
    packageSignature: context.packageSignature,
    resolveKey
  }) : "active";
  const finalKey = usesPersistentCache ? hashJson({
    compilationLevel: options.compilationLevel,
    externalInputHash: await hashExternalInputs([
      ...options.externs,
      ...options.js
    ]),
    languageOut: options.languageOut,
    packageSignature: context.packageSignature,
    resolveKey
  }) : "active";
  const trackedFiles = usesPersistentCache ? await collectTrackedFiles([
    ...graphResult.trackedFiles,
    tsConfigPath,
    ...options.externs,
    ...options.js
  ]) : {};
  if (usesPersistentCache) {
    await writeJson(resolveSnapshotPath, {
      compilerOptionsHash,
      entryFiles: resolveMetadata.entryFiles,
      finalKey,
      lazyImports: resolvedLazyImports,
      nativeEmitKey,
      optionsSignature: context.optionsSignature,
      packageAliases: graphResult.packageAliases,
      packageJsonFiles: graphResult.packageJsonFiles,
      packageSignature: context.packageSignature,
      resolveKey,
      sourceFiles: graphResult.sourceFiles,
      trackedFiles
    });
  }
  return {
    cleanup: cacheStore.cleanup,
    chunkPlan: resolveMetadata.chunkPlan,
    entryFiles,
    lazyImports: resolvedLazyImports,
    packageAliases: graphResult.packageAliases,
    packageJsonFiles: graphResult.packageJsonFiles,
    finalCacheDir: path7.join(cacheStore.projectCacheDir, "final", finalKey),
    finalKey,
    nativeEmitCacheDir: path7.join(cacheStore.projectCacheDir, "native-emit", nativeEmitKey),
    shimDir,
    shimFiles,
    sourceFiles: graphResult.sourceFiles,
    trackedFiles,
    tsConfigPath,
    workspaceDir: cacheStore.workspaceDir
  };
}
function resolveOutputNames(entryPaths, outputNames) {
  if (outputNames.length > 0) {
    if (outputNames.length !== entryPaths.length) {
      throw new Error("outputNames length must match entries length.");
    }
    return outputNames;
  }
  const basenameCounts = new Map;
  const basenames = entryPaths.map((entryPath) => path7.basename(entryPath).replace(/\.[^/.]+$/, ".js"));
  for (const basename of basenames) {
    basenameCounts.set(basename, (basenameCounts.get(basename) ?? 0) + 1);
  }
  return entryPaths.map((entryPath, index) => {
    const basename = basenames[index];
    if ((basenameCounts.get(basename) ?? 0) === 1) {
      return basename;
    }
    return `${entryPath.replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "__")}.js`;
  });
}
function sanitizeChunkName(outputName) {
  return outputName.replace(/\.js$/, "").replace(/[^\w-]/g, "-");
}
function toBuildEntry(entry, sourceRoot) {
  return {
    chunkName: entry.chunkName,
    exportNames: entry.exportNames,
    hasDefaultExport: entry.hasDefaultExport,
    outputName: entry.outputName,
    sourcePath: path7.join(sourceRoot, entry.sourceRelativePath),
    sourceRelativePath: entry.sourceRelativePath
  };
}
function toShimFiles(entryFiles, shimDir) {
  return entryFiles.map((entry) => path7.join(shimDir, `${entry.chunkName}.ts`));
}
async function ensureDirectorySymlink(linkPath, targetPath) {
  try {
    const currentTarget = await fs7.promises.readlink(linkPath);
    if (path7.resolve(path7.dirname(linkPath), currentTarget) === targetPath) {
      return;
    }
    await fs7.promises.rm(linkPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      await fs7.promises.rm(linkPath, { force: true, recursive: true });
    }
  }
  await fs7.promises.mkdir(path7.dirname(linkPath), { recursive: true });
  await fs7.promises.symlink(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}
async function ensureWorkspaceNodeModules(workspaceDir, options) {
  const linkPath = path7.join(workspaceDir, "node_modules");
  if (options.packages.mode === "off") {
    await removePathIfExists(linkPath);
    return;
  }
  const nodeModulesPath = path7.join(options.projectRoot, "node_modules");
  const hasNodeModules = await fs7.promises.access(nodeModulesPath).then(() => true).catch(() => false);
  if (!hasNodeModules) {
    await removePathIfExists(linkPath);
    return;
  }
  await ensureDirectorySymlink(linkPath, nodeModulesPath);
}
async function removePathIfExists(targetPath) {
  try {
    await fs7.promises.rm(targetPath, { force: true, recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}
async function resolveTsConfigPath(projectRoot) {
  const configPath = ts3.findConfigFile(projectRoot, ts3.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`Cannot find tsconfig.json in ${projectRoot}`);
  }
  return configPath;
}
async function hashTsConfig(configPath) {
  return hashContent(await fs7.promises.readFile(configPath, "utf-8"));
}
async function hashExternalInputs(filePaths) {
  const entries = await Promise.all([...filePaths].sort((left, right) => left.localeCompare(right)).map(async (filePath) => ({
    filePath,
    hash: hashContent(await fs7.promises.readFile(filePath, "utf-8"))
  })));
  return hashJson(entries);
}
async function readChunkPlan(projectCacheDir, resolveKey) {
  const resolveMetadataPath = path7.join(projectCacheDir, "resolve", `${resolveKey}.json`);
  const metadata = await readJsonIfExists(resolveMetadataPath);
  if (!metadata) {
    throw new Error(`Missing resolve metadata for ${resolveKey}`);
  }
  return metadata.chunkPlan;
}
function buildChunkPlan({
  chunkOptions,
  entryFiles,
  graph,
  lazyImports,
  shimFiles,
  workspaceDir
}) {
  if (chunkOptions.mode === "closure-library") {
    return buildClosureChunkPlan({
      baseChunkName: chunkOptions.baseChunkName,
      entryFiles,
      graph,
      lazyImports,
      workspaceDir
    });
  }
  const shimToEntry = new Map(shimFiles.map((shimFile, index) => [shimFile, entryFiles[index]]));
  const reachability = new Map;
  const counts = new Map;
  for (const shimFile of shimFiles) {
    const reachable = walkReachableFiles(shimFile, graph);
    reachability.set(shimFile, reachable);
    for (const filePath of reachable) {
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
    }
  }
  const sharedFiles = new Set(Array.from(counts.entries()).filter(([, count]) => count > 1).map(([filePath]) => filePath));
  const chunks = [];
  if (entryFiles.length === 1) {
    const [onlyEntry] = entryFiles;
    const [onlyShim] = shimFiles;
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(topologicalSort(Array.from(reachability.get(onlyShim) ?? []), graph), workspaceDir),
      name: stripExtension(onlyEntry.outputName)
    });
    return chunks;
  }
  if (sharedFiles.size > 0) {
    chunks.push({
      dependencies: [],
      files: toRelativeFiles(topologicalSort(Array.from(sharedFiles), graph), workspaceDir),
      name: "shared"
    });
  }
  for (const shimFile of shimFiles) {
    const entry = shimToEntry.get(shimFile);
    const reachable = reachability.get(shimFile) ?? new Set;
    const uniqueFiles = Array.from(reachable).filter((filePath) => !sharedFiles.has(filePath));
    chunks.push({
      dependencies: sharedFiles.size > 0 ? ["shared"] : [],
      files: toRelativeFiles(topologicalSort(uniqueFiles, graph), workspaceDir),
      name: stripExtension(entry.outputName)
    });
  }
  return chunks;
}
function buildClosureChunkPlan({
  baseChunkName,
  entryFiles,
  graph,
  lazyImports,
  workspaceDir
}) {
  const baseChunk = sanitizeChunkName(baseChunkName);
  const baseReachable = new Set;
  for (const entry of entryFiles) {
    for (const filePath of walkReachableFiles(entry.sourcePath, graph)) {
      baseReachable.add(filePath);
    }
  }
  const uniqueLazyImports = dedupeLazyImports(lazyImports);
  if (uniqueLazyImports.length === 0) {
    return [
      {
        dependencies: [],
        entryFiles: entryFiles.map((entry) => path7.relative(workspaceDir, entry.sourcePath)),
        files: toRelativeFiles(topologicalSort(Array.from(baseReachable), graph), workspaceDir),
        kind: "base",
        name: baseChunk
      }
    ];
  }
  const lazyRootTargets = new Set(uniqueLazyImports.map((item) => item.targetPath));
  const lazyClosures = uniqueLazyImports.map((lazyImport) => ({
    lazyImport,
    reachable: new Set(Array.from(walkReachableFiles(lazyImport.targetPath, graph)).filter((filePath) => !baseReachable.has(filePath)))
  }));
  const sharedCounts = new Map;
  for (const closure of lazyClosures) {
    for (const filePath of closure.reachable) {
      if (lazyRootTargets.has(filePath)) {
        continue;
      }
      sharedCounts.set(filePath, (sharedCounts.get(filePath) ?? 0) + 1);
    }
  }
  const sharedLazyFiles = new Set(Array.from(sharedCounts.entries()).filter(([, count]) => count > 1).map(([filePath]) => filePath));
  const chunks = [
    {
      dependencies: [],
      entryFiles: entryFiles.map((entry) => path7.relative(workspaceDir, entry.sourcePath)),
      files: toRelativeFiles(topologicalSort(Array.from(baseReachable), graph), workspaceDir),
      kind: "base",
      lazyModuleIds: uniqueLazyImports.filter((item) => baseReachable.has(item.targetPath)).map((item) => item.moduleId),
      name: baseChunk
    }
  ];
  const sharedChunkName = `${baseChunk}-shared`;
  if (sharedLazyFiles.size > 0) {
    chunks.push({
      dependencies: [baseChunk],
      files: toRelativeFiles(topologicalSort(Array.from(sharedLazyFiles), graph), workspaceDir),
      kind: "shared",
      name: sharedChunkName
    });
  }
  for (const { lazyImport, reachable } of lazyClosures) {
    if (baseReachable.has(lazyImport.targetPath)) {
      continue;
    }
    const chunkFiles = Array.from(reachable).filter((filePath) => !sharedLazyFiles.has(filePath));
    chunks.push({
      dependencies: [
        baseChunk,
        ...sharedLazyFiles.size > 0 ? [sharedChunkName] : []
      ],
      files: toRelativeFiles(topologicalSort(chunkFiles, graph), workspaceDir),
      kind: "lazy",
      lazyModuleIds: [lazyImport.moduleId],
      name: sanitizeChunkName(`${path7.relative(workspaceDir, lazyImport.targetPath).replace(/\.[^/.]+$/, "").replace(/[\\/]/g, "-")}-lazy`)
    });
  }
  return chunks;
}
function dedupeLazyImports(lazyImports) {
  return [
    ...new Map(lazyImports.map((item) => [item.moduleId, item])).values()
  ];
}
function assignLazyRuntimeBindings(lazyImports) {
  const byModuleId = [...new Set(lazyImports.map((item) => item.moduleId))].sort((left, right) => left.localeCompare(right));
  const bindingMap = new Map(byModuleId.map((moduleId, index) => [
    moduleId,
    {
      preloadBindingName: `__gcc_preload_${index}`,
      runtimeBindingName: `__gcc_lazy_${index}`
    }
  ]));
  return lazyImports.map((item) => ({
    ...item,
    ...bindingMap.get(item.moduleId)
  }));
}
function walkReachableFiles(entryFile, graph) {
  const reachable = new Set;
  const pending = [entryFile];
  while (pending.length > 0) {
    const current = pending.pop();
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    for (const dependency of graph[current] ?? []) {
      pending.push(dependency);
    }
  }
  return reachable;
}
function topologicalSort(files, graph) {
  const fileSet = new Set(files);
  const visited = new Set;
  const ordered = [];
  function visit(filePath) {
    if (visited.has(filePath)) {
      return;
    }
    visited.add(filePath);
    for (const dependency of graph[filePath] ?? []) {
      if (fileSet.has(dependency)) {
        visit(dependency);
      }
    }
    ordered.push(filePath);
  }
  [...files].sort((left, right) => left.localeCompare(right)).forEach(visit);
  return ordered;
}
function toRelativeFiles(files, workspaceDir) {
  const seenEmittedPaths = new Set;
  const relativeFiles = [];
  for (const filePath of files) {
    if (filePath.endsWith(".d.ts")) {
      continue;
    }
    const relativeFile = path7.relative(workspaceDir, filePath);
    const emittedRelativeFile = relativeFile.replace(/\.[^/.]+$/, ".js");
    if (seenEmittedPaths.has(emittedRelativeFile)) {
      continue;
    }
    seenEmittedPaths.add(emittedRelativeFile);
    relativeFiles.push(relativeFile);
  }
  return relativeFiles;
}
function stripExtension(filePath) {
  return filePath.replace(/\.[^/.]+$/, "");
}
function getPackageRoot() {
  return getPackageRootFromBundle();
}
async function readRuntimeSignature(packageRoot2) {
  try {
    const stat = await fs7.promises.stat(path7.join(packageRoot2, "dist", "index.mjs"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
async function readNativeSignature(packageRoot2) {
  try {
    const stat = await fs7.promises.stat(path7.join(packageRoot2, "native", "index.node"));
    return JSON.stringify({
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  } catch {
    return "";
  }
}
var packageSignaturePromises = new Map;
async function getPackageSignature(packageRoot2 = getPackageRoot()) {
  let packageSignaturePromise = packageSignaturePromises.get(packageRoot2);
  if (!packageSignaturePromise) {
    packageSignaturePromise = (async () => {
      const packageJsonStat = await fs7.promises.stat(path7.join(packageRoot2, "package.json"));
      const runtimeSignature = await readRuntimeSignature(packageRoot2);
      const nativeSignature = await readNativeSignature(packageRoot2);
      return hashContent(JSON.stringify({
        nativeSignature,
        packageJson: {
          mtimeMs: packageJsonStat.mtimeMs,
          size: packageJsonStat.size
        },
        runtimeSignature
      }));
    })();
    packageSignaturePromises.set(packageRoot2, packageSignaturePromise);
  }
  return packageSignaturePromise;
}
function getOptionsSignature(options) {
  return hashJson({
    compilationLevel: options.compilationLevel,
    chunks: options.chunks,
    diagnostics: options.diagnostics,
    entries: options.entries.map((entry) => path7.relative(options.srcDir, entry)),
    externs: [...options.externs].sort(),
    js: [...options.js].sort(),
    languageOut: options.languageOut,
    outDir: options.outDir,
    outputNames: [...options.outputNames],
    packages: options.packages,
    projectRoot: options.projectRoot,
    srcDir: options.srcDir
  });
}
function normalizeBuildOptions(options) {
  const projectRoot = path7.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path7.resolve(projectRoot, options.srcDir ?? (DEFAULT_BUILD_OPTIONS.srcDir || "src"));
  const outDir = path7.resolve(projectRoot, options.outDir ?? (DEFAULT_BUILD_OPTIONS.outDir || "dist"));
  const chunkPublicPath = normalizeChunkPublicPath(options.chunks?.publicPath ?? DEFAULT_BUILD_OPTIONS.chunks.publicPath);
  const chunkManifestFile = path7.basename(options.chunks?.manifestFile ?? DEFAULT_BUILD_OPTIONS.chunks.manifestFile);
  return {
    cache: {
      dir: options.cache?.dir ? path7.resolve(projectRoot, options.cache.dir) : DEFAULT_BUILD_OPTIONS.cache.dir,
      mode: options.cache?.mode ?? DEFAULT_BUILD_OPTIONS.cache.mode
    },
    chunks: {
      baseChunkName: options.chunks?.baseChunkName ?? DEFAULT_BUILD_OPTIONS.chunks.baseChunkName,
      manifestFile: chunkManifestFile,
      mode: options.chunks?.mode ?? DEFAULT_BUILD_OPTIONS.chunks.mode,
      publicPath: chunkPublicPath
    },
    compilationLevel: options.compilationLevel ?? DEFAULT_BUILD_OPTIONS.compilationLevel,
    diagnostics: {
      fatalWarnings: options.diagnostics?.fatalWarnings ?? DEFAULT_BUILD_OPTIONS.diagnostics.fatalWarnings,
      preflight: options.diagnostics?.preflight ?? DEFAULT_BUILD_OPTIONS.diagnostics.preflight,
      verbose: options.diagnostics?.verbose ?? DEFAULT_BUILD_OPTIONS.diagnostics.verbose
    },
    entries: options.entries.map((entry) => path7.isAbsolute(entry) ? entry : path7.resolve(srcDir, entry)),
    externs: [...options.externs ?? []].map((filePath) => path7.isAbsolute(filePath) ? filePath : path7.resolve(projectRoot, filePath)),
    js: [...options.js ?? []].map((filePath) => path7.isAbsolute(filePath) ? filePath : path7.resolve(projectRoot, filePath)),
    languageOut: options.languageOut ?? DEFAULT_BUILD_OPTIONS.languageOut,
    outDir,
    outputNames: [...options.outputNames ?? []],
    packages: {
      mode: options.packages?.mode ?? DEFAULT_BUILD_OPTIONS.packages.mode
    },
    projectRoot,
    srcDir
  };
}
function normalizeChunkPublicPath(publicPath) {
  if (publicPath.length === 0) {
    return "./";
  }
  return publicPath.endsWith("/") ? publicPath : `${publicPath}/`;
}

// src/stages/native/emit.ts
import fs8 from "fs";
import path8 from "path";
import ts5 from "typescript";

// src/stages/native/closure-ir.ts
import ts4 from "typescript";
async function collectClosureIrMetadata({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    rootDir: workspaceDir
  });
  const program = ts4.createProgram(fileNames, compilerOptions);
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const inputFiles = new Set(fileNames);
  const files = [];
  const diagnostics = [];
  for (const sourceFile of program.getSourceFiles()) {
    if (!inputFiles.has(sourceFile.fileName)) {
      continue;
    }
    const typeDeclarations = [];
    const topLevelDocs = [];
    const enumDeclarations = [];
    for (const statement of sourceFile.statements) {
      if (ts4.isInterfaceDeclaration(statement)) {
        typeDeclarations.push(buildInterfaceDeclarationSnippet(statement, checker));
        continue;
      }
      if (ts4.isTypeAliasDeclaration(statement)) {
        typeDeclarations.push(buildTypeAliasDeclarationSnippet(statement, checker));
        continue;
      }
      if (ts4.isEnumDeclaration(statement)) {
        const enumDeclaration = buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols);
        if (enumDeclaration) {
          enumDeclarations.push(enumDeclaration);
        }
        continue;
      }
      if (ts4.isFunctionDeclaration(statement) && statement.name) {
        const objectParamRecord = buildFunctionObjectParamRecord(statement, checker);
        if (objectParamRecord) {
          typeDeclarations.push({ snippet: objectParamRecord.snippet });
        }
        const jsdoc = buildFunctionJsDoc(statement, checker, objectParamRecord?.typeName);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "function",
            name: statement.name.text
          });
        }
        continue;
      }
      if (ts4.isClassDeclaration(statement) && statement.name) {
        const jsdoc = buildClassJsDoc(statement, checker);
        if (jsdoc) {
          topLevelDocs.push({
            jsdoc,
            kind: "class",
            name: statement.name.text
          });
        }
      }
    }
    let decoratedOutputText;
    if (containsDecorators(sourceFile)) {
      const transpiled = ts4.transpileModule(sourceFile.getFullText(), {
        compilerOptions: {
          ...compilerOptions,
          module: ts4.ModuleKind.ESNext,
          moduleResolution: ts4.ModuleResolutionKind.Bundler,
          sourceMap: false,
          target: ts4.ScriptTarget.ES2018
        },
        fileName: sourceFile.fileName,
        reportDiagnostics: true
      });
      diagnostics.push(...(transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts4.DiagnosticCategory.Error));
      decoratedOutputText = transpiled.outputText;
    }
    files.push({
      decoratedOutputText,
      enumDeclarations,
      filePath: sourceFile.fileName,
      topLevelDocs,
      typeDeclarations
    });
  }
  return { diagnostics, files };
}
function containsDecorators(sourceFile) {
  let found = false;
  const visit = (node) => {
    if (found) {
      return;
    }
    if (ts4.canHaveDecorators(node) && (ts4.getDecorators(node)?.length ?? 0) > 0) {
      found = true;
      return;
    }
    ts4.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
function collectUnsafeEnumSymbols(program, checker) {
  const unsafe = new Set;
  const mark = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol) {
      unsafe.add(symbol.flags & ts4.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
    }
  };
  for (const sourceFile of program.getSourceFiles()) {
    const visit = (node) => {
      if (ts4.isElementAccessExpression(node) && ts4.isIdentifier(node.expression)) {
        mark(node.expression);
      }
      if (ts4.isCallExpression(node) && ts4.isPropertyAccessExpression(node.expression) && ts4.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object" && ["entries", "keys", "values"].includes(node.expression.name.text) && node.arguments.length > 0 && ts4.isIdentifier(node.arguments[0])) {
        mark(node.arguments[0]);
      }
      if (ts4.isIdentifier(node) && !ts4.isPropertyAccessExpression(node.parent) && !ts4.isElementAccessExpression(node.parent) && !ts4.isImportSpecifier(node.parent) && !ts4.isImportClause(node.parent) && !ts4.isExportSpecifier(node.parent) && !ts4.isEnumDeclaration(node.parent) && !ts4.isEnumMember(node.parent)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol) {
          const resolved = symbol.flags & ts4.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
          if (resolved.flags & ts4.SymbolFlags.Enum) {
            unsafe.add(resolved);
          }
        }
      }
      ts4.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return unsafe;
}
function buildEnumDeclarationMetadata(statement, checker, unsafeEnumSymbols) {
  const symbol = checker.getSymbolAtLocation(statement.name);
  const resolved = symbol && symbol.flags & ts4.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (resolved && unsafeEnumSymbols.has(resolved)) {
    return null;
  }
  const members = [];
  let valueType = null;
  let nextNumber = 0;
  for (const member of statement.members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      return null;
    }
    const constantValue = checker.getConstantValue(member);
    const memberValue = constantValue ?? (member.initializer ? literalValueFromExpression(member.initializer) : nextNumber);
    if (memberValue === undefined) {
      return null;
    }
    const currentValueType = typeof memberValue;
    if (currentValueType !== "number" && currentValueType !== "string" && currentValueType !== "boolean") {
      return null;
    }
    if (valueType && valueType !== currentValueType) {
      return null;
    }
    valueType = currentValueType;
    members.push({ name: memberName, value: memberValue });
    if (typeof memberValue === "number") {
      nextNumber = memberValue + 1;
    }
  }
  if (!valueType || members.length === 0) {
    return null;
  }
  if (valueType === "number" && !hasConstModifier(statement)) {
    return null;
  }
  return {
    exported: hasExportModifier(statement),
    members,
    name: statement.name.text,
    valueType
  };
}
function buildInterfaceDeclarationSnippet(statement, checker) {
  const lines = ["/**"];
  lines.push(" * @record");
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(" */");
  lines.push(`function ${statement.name.text}() {}`);
  for (const member of statement.members) {
    const memberName = getPropertyNameText2(member.name);
    if (!memberName) {
      continue;
    }
    if (ts4.isPropertySignature(member)) {
      const propertyType = member.type ? toClosureType(checker.getTypeFromTypeNode(member.type), checker) : "?";
      lines.push(`/** @type {${propertyType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
      continue;
    }
    if (ts4.isMethodSignature(member)) {
      const signature = checker.getSignatureFromDeclaration(member);
      if (!signature) {
        continue;
      }
      const functionType = signatureToClosureFunctionType(signature, checker);
      lines.push(`/** @type {${functionType}} */`);
      lines.push(`${statement.name.text}.prototype.${renderPropertyName(memberName)};`);
    }
  }
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildTypeAliasDeclarationSnippet(statement, checker) {
  const aliasType = checker.getTypeAtLocation(statement);
  const closureType = toClosureType(aliasType, checker);
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  lines.push(` * @typedef {${closureType}}`);
  lines.push(" */");
  lines.push(`let ${statement.name.text};`);
  if (hasExportModifier(statement)) {
    lines.push(`exports.${statement.name.text} = ${statement.name.text};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`
  };
}
function buildFunctionJsDoc(statement, checker, firstParamObjectRecordTypeName) {
  const signature = checker.getSignatureFromDeclaration(statement);
  if (!signature) {
    return null;
  }
  const lines = ["/**"];
  for (const templateName of getTemplateNames(statement.typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  for (const [index, parameter] of signature.getParameters().entries()) {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    const parameterName = index === 0 && firstParamObjectRecordTypeName ? "__props" : parameter.getName();
    const closureType = index === 0 && firstParamObjectRecordTypeName ? `!${firstParamObjectRecordTypeName}` : toClosureType(parameterType, checker);
    lines.push(` * @param {${closureType}} ${parameterName}`);
  }
  const returnType = checker.getReturnTypeOfSignature(signature);
  lines.push(` * @return {${toClosureType(returnType, checker)}}`);
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function buildFunctionObjectParamRecord(statement, checker) {
  if (!isComponentLikeName(statement.name?.text)) {
    return null;
  }
  const firstParameter = statement.parameters[0];
  if (!firstParameter || !ts4.isObjectBindingPattern(firstParameter.name) || hasRestElement(firstParameter.name)) {
    return null;
  }
  const parameterType = checker.getTypeAtLocation(firstParameter);
  const properties = checker.getPropertiesOfType(parameterType);
  if (properties.length === 0) {
    return null;
  }
  const typeName = `${statement.name.text}$Param0`;
  const lines = ["/**", " * @record", " */", `function ${typeName}() {}`];
  for (const property of properties) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? firstParameter;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    lines.push(`/** @type {${toClosureType(propertyType, checker)}} */`);
    lines.push(`${typeName}.prototype.${renderPropertyName(property.getName())};`);
  }
  return {
    snippet: `${lines.join(`
`)}
`,
    typeName
  };
}
function hasRestElement(pattern) {
  return pattern.elements.some((element) => element.dotDotDotToken);
}
function isComponentLikeName(name) {
  return !!name && /^[A-Z]/.test(name);
}
function buildClassJsDoc(statement, checker) {
  const typeParameters = statement.typeParameters ?? [];
  const lines = ["/**"];
  for (const templateName of getTemplateNames(typeParameters)) {
    lines.push(` * @template ${templateName}`);
  }
  if (statement.heritageClauses) {
    for (const clause of statement.heritageClauses) {
      for (const typeNode of clause.types) {
        const closureType = toClosureType(checker.getTypeAtLocation(typeNode), checker);
        if (clause.token === ts4.SyntaxKind.ExtendsKeyword) {
          lines.push(` * @extends {${closureType}}`);
        } else if (clause.token === ts4.SyntaxKind.ImplementsKeyword) {
          lines.push(` * @implements {${closureType}}`);
        }
      }
    }
  }
  lines.push(" */");
  return `${lines.join(`
`)}
`;
}
function getTemplateNames(typeParameters) {
  return (typeParameters ?? []).map((parameter) => parameter.name.text);
}
function hasExportModifier(node) {
  return (ts4.getCombinedModifierFlags(node) & ts4.ModifierFlags.Export) !== 0;
}
function hasConstModifier(node) {
  return (ts4.getCombinedModifierFlags(node) & ts4.ModifierFlags.Const) !== 0;
}
function getPropertyNameText2(name) {
  if (!name) {
    return null;
  }
  if (ts4.isIdentifier(name) || ts4.isStringLiteral(name) || ts4.isNumericLiteral(name) || ts4.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}
function renderPropertyName(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `[${JSON.stringify(name)}]`;
}
function literalValueFromExpression(expression) {
  if (ts4.isStringLiteralLike(expression)) {
    return expression.text;
  }
  if (ts4.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (expression.kind === ts4.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (expression.kind === ts4.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts4.isPrefixUnaryExpression(expression) && expression.operator === ts4.SyntaxKind.MinusToken && ts4.isNumericLiteral(expression.operand)) {
    return -Number(expression.operand.text);
  }
  return;
}
function signatureToClosureFunctionType(signature, checker) {
  const params = signature.getParameters().map((parameter) => {
    const declaration = parameter.valueDeclaration;
    const parameterType = declaration ? checker.getTypeOfSymbolAtLocation(parameter, declaration) : checker.getTypeOfSymbol(parameter);
    return toClosureType(parameterType, checker);
  });
  const returnType = toClosureType(checker.getReturnTypeOfSignature(signature), checker);
  return `function(${params.join(", ")}): ${returnType}`;
}
function toClosureType(type, checker, seen = new Set) {
  if (seen.has(type)) {
    return "?";
  }
  seen.add(type);
  if (type.flags & ts4.TypeFlags.Any) {
    return "?";
  }
  if (type.flags & ts4.TypeFlags.Unknown) {
    return "?";
  }
  if (type.flags & ts4.TypeFlags.StringLike) {
    return "string";
  }
  if (type.flags & ts4.TypeFlags.NumberLike) {
    return "number";
  }
  if (type.flags & ts4.TypeFlags.BooleanLike) {
    return "boolean";
  }
  if (type.flags & ts4.TypeFlags.Void) {
    return "void";
  }
  if (type.flags & ts4.TypeFlags.Undefined) {
    return "undefined";
  }
  if (type.flags & ts4.TypeFlags.Null) {
    return "null";
  }
  if (type.flags & ts4.TypeFlags.Never) {
    return "never";
  }
  if (type.flags & ts4.TypeFlags.TypeParameter) {
    return checker.typeToString(type);
  }
  if (type.isUnion()) {
    return `(${type.types.map((item) => toClosureType(item, checker, seen)).join("|")})`;
  }
  if (checker.isArrayType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    const elementType = typeArguments[0] ? toClosureType(typeArguments[0], checker, seen) : "?";
    return `!Array<${elementType}>`;
  }
  if (checker.isTupleType(type)) {
    const typeArguments = checker.getTypeArguments(type);
    if (typeArguments.length === 0) {
      return "!Array<?>";
    }
    return `!Array<${typeArguments.map((item) => toClosureType(item, checker, seen)).join("|")}>`;
  }
  const callSignatures = type.getCallSignatures();
  if (callSignatures.length > 0) {
    return signatureToClosureFunctionType(callSignatures[0], checker);
  }
  if (type.getSymbol()) {
    const symbolName = checker.symbolToString(type.getSymbol());
    if (symbolName && symbolName !== "__type") {
      return symbolName;
    }
  }
  if (type.isClassOrInterface() || type.getProperties().length > 0 && !(type.flags & ts4.TypeFlags.Object)) {
    return "!Object";
  }
  return "?";
}

// src/stages/native/emit.ts
var require3 = createBundleRequire();
var NATIVE_EMIT_METADATA_VERSION = 7;
async function emitNativeStage({
  cacheDir,
  fileNames,
  lazyImports,
  metadataPath,
  options,
  packageAliases,
  packageJsonFiles,
  tsConfigPath,
  workspaceDir
}) {
  const usesPersistentCache = options.cache.mode === "persistent";
  const outDir = path8.join(cacheDir, "out");
  const externsPath = path8.join(cacheDir, "modules-externs.js");
  const metadataPathForNative = path8.join(cacheDir, "closure-ir.json");
  const runtimePackageInputs = await collectTsxRuntimePackageInputs({
    fileNames,
    tsConfigPath,
    workspaceDir
  });
  const runtimeSupportFiles = runtimePackageInputs.sourceFiles.map((fileName) => toEmittedPath(fileName, outDir, workspaceDir));
  const combinedFileNames = uniqueSorted2([
    ...fileNames,
    ...runtimePackageInputs.sourceFiles
  ]);
  const combinedPackageAliases = mergePackageAliases([
    ...packageAliases,
    ...runtimePackageInputs.packageAliases
  ]);
  const combinedPackageJsonFiles = uniqueSorted2([
    ...packageJsonFiles,
    ...runtimePackageInputs.packageJsonFiles
  ]);
  const dependencyModules = collectDependencyModules(combinedPackageAliases);
  const dependencyRuntimeFiles = collectDependencyRuntimeFiles({
    outDir,
    sourceFiles: combinedFileNames,
    workspaceDir
  });
  const cachedMetadata = usesPersistentCache ? await readMetadata(metadataPath) : null;
  if (cachedMetadata && await filesExist([
    cachedMetadata.externsPath,
    cachedMetadata.metadataPath,
    ...cachedMetadata.emittedFiles,
    ...cachedMetadata.supportFiles
  ])) {
    return {
      dependencyModules: cachedMetadata.dependencyModules,
      dependencyRuntimeFiles: cachedMetadata.dependencyRuntimeFiles,
      diagnostics: [],
      emitSkipped: false,
      emittedFiles: cachedMetadata.emittedFiles,
      externsPath: cachedMetadata.externsPath,
      outDir,
      supportFiles: cachedMetadata.supportFiles
    };
  }
  await fs8.promises.rm(outDir, { force: true, recursive: true });
  await fs8.promises.mkdir(outDir, { recursive: true });
  const diagnostics = await getPreflightDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir
  });
  if (diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  const closureIr = await collectClosureIrMetadata({
    fileNames: combinedFileNames,
    tsConfigPath,
    workspaceDir
  });
  if (closureIr.diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: closureIr.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  await fs8.promises.writeFile(metadataPathForNative, JSON.stringify(closureIr.files, null, 2), "utf-8");
  const result = transpileSources({
    metadataPath: metadataPathForNative,
    externsPath,
    fileNames: combinedFileNames,
    lazyImports,
    outDir,
    packageAliases: combinedPackageAliases,
    packageJsonFiles: combinedPackageJsonFiles,
    workspaceDir
  });
  const finalSupportFiles = uniqueSorted2([
    ...runtimeSupportFiles,
    ...result.supportFiles
  ]);
  if (usesPersistentCache) {
    await fs8.promises.writeFile(metadataPath, JSON.stringify({
      dependencyModules,
      dependencyRuntimeFiles,
      emittedFiles: result.emittedFiles,
      externsPath: result.externsPath,
      metadataPath: metadataPathForNative,
      supportFiles: finalSupportFiles,
      version: NATIVE_EMIT_METADATA_VERSION
    }, null, 2), "utf-8");
  }
  return {
    dependencyModules,
    dependencyRuntimeFiles,
    diagnostics: [],
    emitSkipped: false,
    emittedFiles: result.emittedFiles,
    externsPath: result.externsPath,
    outDir,
    supportFiles: finalSupportFiles
  };
}
async function collectTsxRuntimePackageInputs({
  fileNames,
  tsConfigPath,
  workspaceDir
}) {
  if (!fileNames.some((fileName) => fileName.endsWith(".tsx"))) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const runtimeSpecifier = getJsxRuntimeSpecifier(compilerOptions);
  if (!runtimeSpecifier) {
    return {
      packageAliases: [],
      packageJsonFiles: [],
      sourceFiles: []
    };
  }
  const resolvedEntry = require3.resolve(runtimeSpecifier, {
    paths: [workspaceDir]
  });
  const workspaceEntry = toWorkspaceNodeModulesPath(resolvedEntry, workspaceDir);
  const runtimeAlias = toRuntimePackageAlias(runtimeSpecifier, workspaceEntry);
  const graph = resolveGraph({
    entries: [workspaceEntry],
    packageMode: "esm-only",
    srcDir: path8.join(workspaceDir, "src"),
    workspaceDir
  });
  return {
    packageAliases: mergePackageAliases([
      runtimeAlias,
      ...graph.packageAliases
    ]),
    packageJsonFiles: graph.packageJsonFiles,
    sourceFiles: graph.sourceFiles
  };
}
async function getPreflightDiagnostics({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir
}) {
  if (preflight === "off") {
    return [];
  }
  const requiredStates = collectFileStates([tsConfigPath, ...fileNames]);
  const missingFiles = requiredStates.filter((state) => !state.exists).map((state) => state.filePath);
  if (missingFiles.length > 0) {
    return [
      createSimpleDiagnostic(`Missing required build input(s): ${missingFiles.join(", ")}`)
    ];
  }
  if (preflight !== "full") {
    return [];
  }
  const compilerOptions = await loadCompilerOptions(tsConfigPath);
  const finalCompilerOptions = {
    ...compilerOptions,
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts5.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts5.ScriptTarget.ESNext
  };
  const compilerHost = ts5.createCompilerHost(finalCompilerOptions);
  const program = ts5.createProgram(fileNames, finalCompilerOptions, compilerHost);
  return [...ts5.getPreEmitDiagnostics(program)].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic));
}
function createSimpleDiagnostic(messageText) {
  return {
    category: ts5.DiagnosticCategory.Error,
    code: 0,
    file: undefined,
    length: undefined,
    messageText,
    start: undefined
  };
}
function shouldIgnorePreflightDiagnostic(diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }
  const message = ts5.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
}
function getJsxRuntimeSpecifier(compilerOptions) {
  const jsxImportSource = compilerOptions.jsxImportSource ?? "react";
  switch (compilerOptions.jsx) {
    case ts5.JsxEmit.ReactJSX:
      return `${jsxImportSource}/jsx-runtime`;
    case ts5.JsxEmit.ReactJSXDev:
      return `${jsxImportSource}/jsx-dev-runtime`;
    default:
      return null;
  }
}
async function readMetadata(metadataPath) {
  try {
    const raw = await fs8.promises.readFile(metadataPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== NATIVE_EMIT_METADATA_VERSION) {
      return null;
    }
    return {
      dependencyModules: parsed.dependencyModules ?? [],
      dependencyRuntimeFiles: parsed.dependencyRuntimeFiles ?? [],
      emittedFiles: parsed.emittedFiles ?? [],
      externsPath: parsed.externsPath ?? "",
      metadataPath: parsed.metadataPath ?? "",
      supportFiles: parsed.supportFiles ?? [],
      version: parsed.version
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
function toEmittedPath(sourcePath, outDir, workspaceDir) {
  return path8.join(outDir, path8.relative(workspaceDir, sourcePath)).replace(/\.[^/.]+$/, ".js");
}
function collectDependencyModules(packageAliases) {
  return uniqueSorted2(packageAliases.filter((alias) => isDependencyFile(alias.targetPath)).map((alias) => alias.subpath === "." ? alias.packageName : `${alias.packageName}/${alias.subpath.replace(/^\.\//, "")}`));
}
function collectDependencyRuntimeFiles({
  outDir,
  sourceFiles,
  workspaceDir
}) {
  return uniqueSorted2(sourceFiles.filter((filePath) => isDependencyFile(filePath)).map((filePath) => toEmittedPath(filePath, outDir, workspaceDir)));
}
function isDependencyFile(filePath) {
  return path8.resolve(filePath).includes(`${path8.sep}node_modules${path8.sep}`);
}
function uniqueSorted2(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function mergePackageAliases(aliases) {
  const merged = new Map;
  for (const alias of aliases) {
    merged.set(`${alias.packageName}\x00${alias.subpath}`, alias);
  }
  return [...merged.values()].sort((left, right) => {
    const leftKey = `${left.packageName}\x00${left.subpath}`;
    const rightKey = `${right.packageName}\x00${right.subpath}`;
    return leftKey.localeCompare(rightKey);
  });
}
function toWorkspaceNodeModulesPath(resolvedPath, workspaceDir) {
  const marker = `${path8.sep}node_modules${path8.sep}`;
  const markerIndex = resolvedPath.lastIndexOf(marker);
  if (markerIndex === -1) {
    return resolvedPath;
  }
  const relativeNodeModulesPath = resolvedPath.slice(markerIndex + 1);
  return path8.join(workspaceDir, relativeNodeModulesPath);
}
function toRuntimePackageAlias(specifier, targetPath) {
  const segments = specifier.startsWith("@") ? specifier.split("/", 3) : specifier.split("/", 2);
  const packageName = specifier.startsWith("@") ? `${segments[0]}/${segments[1]}` : segments[0];
  const subpath = specifier.startsWith("@") ? segments[2] : segments[1];
  return {
    packageName,
    subpath: subpath ? `./${subpath}` : ".",
    targetPath
  };
}

// src/stages/closure/run-closure.ts
import fs9 from "fs/promises";
import path9 from "path";
import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
var closureLibFilesCache = new Map;
var CHUNK_NAMESPACE = "__gcc$chunks";
var CHUNK_MANAGER_JUSTIFICATION = "Generated by gcc-ts-bundler chunk runtime.";
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  externPaths,
  finalCacheDir,
  options,
  outDir,
  supportFiles,
  lazyImports,
  packageRoot: packageRoot2
}) {
  await fs9.rm(finalCacheDir, { force: true, recursive: true });
  await fs9.mkdir(finalCacheDir, { recursive: true });
  const rawDir = path9.join(finalCacheDir, "raw");
  const cacheOutputDir = path9.join(finalCacheDir, "outputs");
  const supportDir = path9.join(emittedOutDir, "__gcc_chunk_support");
  await fs9.mkdir(rawDir, { recursive: true });
  await fs9.mkdir(cacheOutputDir, { recursive: true });
  await fs9.rm(supportDir, { force: true, recursive: true });
  await fs9.mkdir(supportDir, { recursive: true });
  await fs9.rm(outDir, { force: true, recursive: true });
  await fs9.mkdir(outDir, { recursive: true });
  const resolvedChunks = resolveChunkPlan(chunkPlan, emittedOutDir);
  let finalSupportFiles = [...supportFiles];
  let manifestOutputPath = null;
  let runtimeEntryPoint = null;
  if (options.chunks.mode === "closure-library") {
    const chunkAssets = await createChunkRuntimeAssets({
      chunkPlan: resolvedChunks,
      emittedOutDir,
      lazyImports,
      options,
      supportDir
    });
    finalSupportFiles = uniquePaths([
      ...supportFiles,
      chunkAssets.runtimeSupportFile
    ]);
    runtimeEntryPoint = chunkAssets.runtimeModuleId;
    applyChunkBridgesToResolvedChunks(resolvedChunks, chunkAssets.bridgeFiles);
    if (options.chunks.manifestFile) {
      manifestOutputPath = path9.join(outDir, options.chunks.manifestFile);
      await fs9.mkdir(path9.dirname(manifestOutputPath), { recursive: true });
      await fs9.writeFile(manifestOutputPath, chunkAssets.manifestText, "utf-8");
      await fs9.mkdir(path9.join(cacheOutputDir, path9.dirname(options.chunks.manifestFile)), {
        recursive: true
      });
      await fs9.writeFile(path9.join(cacheOutputDir, options.chunks.manifestFile), chunkAssets.manifestText, "utf-8");
    }
  }
  const closureLibFiles = await collectClosureLibFiles(packageRoot2, [
    ...finalSupportFiles,
    ...resolvedChunks.flatMap((chunk) => chunk.files)
  ]);
  const exitCode = resolvedChunks.length === 1 && options.chunks.mode !== "closure-library" ? await runSingleClosureCompilation({
    closureLibFiles,
    entryChunk: resolvedChunks[0],
    externPaths,
    options,
    supportFiles: finalSupportFiles,
    rawOutputPath: path9.join(rawDir, `${resolvedChunks[0].name}.js`)
  }) : await runChunkedClosureCompilation({
    chunkPlan: resolvedChunks,
    closureLibFiles,
    externPaths,
    options,
    outputDir: rawDir,
    runtimeEntryPoint,
    supportFiles: finalSupportFiles,
    wrapperNamespace: toChunkWrapperNamespace(options.chunks.baseChunkName || resolvedChunks[0]?.name || "main")
  });
  if (exitCode !== 0) {
    return { cacheOutputFiles: [], exitCode, outputFiles: [] };
  }
  const rawOutputs = resolvedChunks.map((chunk) => path9.join(rawDir, `${chunk.name}.js`));
  const outputFiles = resolvedChunks.map((chunk) => path9.join(outDir, `${chunk.name}.js`));
  if (options.chunks.mode === "closure-library") {
    await Promise.all(rawOutputs.map(async (rawFile, index) => {
      const contents = await fs9.readFile(rawFile, "utf-8");
      await fs9.writeFile(outputFiles[index], contents);
    }));
  } else {
    await Promise.all(rawOutputs.map(async (rawFile, index) => {
      const contents = await fs9.readFile(rawFile, "utf-8");
      const transformed = rewriteGccExports(contents);
      await fs9.writeFile(outputFiles[index], transformed);
    }));
  }
  const publishedFiles = manifestOutputPath === null ? outputFiles : [...outputFiles, manifestOutputPath];
  await copyOrLinkFiles(publishedFiles, cacheOutputDir);
  const cacheOutputFiles = publishedFiles.map((outputFile) => path9.join(cacheOutputDir, path9.relative(outDir, outputFile)));
  return { cacheOutputFiles, exitCode: 0, outputFiles: publishedFiles };
}
async function runSingleClosureCompilation({
  closureLibFiles,
  entryChunk,
  externPaths,
  options,
  supportFiles,
  rawOutputPath
}) {
  const closureOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: uniquePaths([
      ...options.js,
      ...closureLibFiles,
      ...supportFiles,
      ...entryChunk.files
    ]),
    jsOutputFile: rawOutputPath,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  };
  if (entryChunk.entryPoints.length > 0) {
    closureOptions.entryPoint = entryChunk.entryPoints;
  }
  applyInternalClosureDebugOptions(closureOptions);
  return runClosureCompiler(closureOptions);
}
async function runChunkedClosureCompilation({
  chunkPlan,
  closureLibFiles,
  externPaths,
  options,
  outputDir,
  runtimeEntryPoint,
  supportFiles,
  wrapperNamespace
}) {
  const leadingJs = uniquePaths([
    ...options.js,
    ...closureLibFiles,
    ...supportFiles
  ]);
  const chunkSpecs = chunkPlan.map((chunk, index) => {
    const dependencySuffix = chunk.dependencies.length > 0 ? `:${chunk.dependencies.join(",")}` : "";
    return `${chunk.name}:${uniquePaths(chunk.files).length + (index === 0 ? leadingJs.length : 0)}${dependencySuffix}`;
  });
  const chunkFiles = uniquePaths([
    ...leadingJs,
    ...chunkPlan.flatMap((chunk) => chunk.files)
  ]);
  const closureOptions = {
    assumeFunctionWrapper: true,
    compilationLevel: options.compilationLevel,
    chunk: chunkSpecs,
    chunkOutputPathPrefix: `${outputDir}${path9.sep}`,
    dependencyMode: "PRUNE",
    externs: uniquePaths(externPaths),
    js: chunkFiles,
    languageIn: "UNSTABLE",
    languageOut: options.languageOut,
    rewritePolyfills: false,
    warningLevel: options.diagnostics.verbose ? "VERBOSE" : "QUIET"
  };
  const entryPoints = uniquePaths([
    ...runtimeEntryPoint ? [runtimeEntryPoint] : [],
    ...chunkPlan.flatMap((chunk) => chunk.entryPoints)
  ]);
  if (entryPoints.length > 0) {
    closureOptions.entryPoint = entryPoints;
  }
  if (options.chunks.mode === "closure-library") {
    const mutableOptions = closureOptions;
    mutableOptions.chunkOutputType = "GLOBAL_NAMESPACE";
    mutableOptions.renamePrefixNamespace = CHUNK_NAMESPACE;
    mutableOptions.chunkWrapper = chunkPlan.map((chunk) => `${chunk.name}:${createChunkWrapper(chunk, wrapperNamespace)}`);
  }
  applyInternalClosureDebugOptions(closureOptions);
  return runClosureCompiler(closureOptions);
}
function applyInternalClosureDebugOptions(closureOptions) {
  const mutableOptions = closureOptions;
  if (process.env.GCC_CLOSURE_DEBUG === "1") {
    mutableOptions.debug = true;
    mutableOptions.formatting = "PRETTY_PRINT";
  }
  if (process.env.GCC_USE_TYPES_FOR_OPTIMIZATION === "false") {
    mutableOptions.useTypesForOptimization = false;
  }
}
async function createChunkRuntimeAssets({
  chunkPlan,
  emittedOutDir,
  lazyImports,
  options,
  supportDir
}) {
  const baseChunk = chunkPlan.find((chunk) => chunk.kind === "base") ?? chunkPlan[0];
  const chunkUrls = chunkPlan.map((chunk) => `${options.chunks.publicPath}${chunk.name}.js`);
  const uniqueLazyImports = dedupeLazyImports2(lazyImports);
  const bridgeFiles = await Promise.all(uniqueLazyImports.map(async (lazyImport, index) => {
    const chunkName = chunkPlan.find((chunk) => chunk.lazyModuleIds.includes(lazyImport.moduleId))?.name;
    if (!chunkName) {
      throw new Error(`Missing lazy chunk for ${lazyImport.moduleId}`);
    }
    const filePath = path9.join(supportDir, `lazy-bridge-${index}.js`);
    const moduleId = toGoogModuleId(filePath, emittedOutDir);
    await fs9.writeFile(filePath, renderLazyBridgeModule(moduleId, lazyImport.moduleId), "utf-8");
    return {
      chunkName,
      filePath,
      moduleId,
      preloadBindingName: lazyImport.preloadBindingName ?? `__gcc_preload_${index}`,
      runtimeBindingName: lazyImport.runtimeBindingName ?? `__gcc_lazy_${index}`
    };
  }));
  const manifest = {
    baseChunkName: baseChunk.name,
    chunkDependencies: Object.fromEntries(chunkPlan.map((chunk) => [chunk.name, chunk.dependencies])),
    chunkUrls: Object.fromEntries(chunkPlan.map((chunk) => [
      chunk.name,
      `${options.chunks.publicPath}${chunk.name}.js`
    ])),
    lazyModules: Object.fromEntries(uniqueLazyImports.map((lazyImport) => [
      lazyImport.moduleId,
      chunkPlan.find((chunk) => chunk.lazyModuleIds.includes(lazyImport.moduleId))?.name ?? ""
    ])),
    namespace: CHUNK_NAMESPACE,
    publicPath: options.chunks.publicPath
  };
  const runtimeSupportFile = path9.join(supportDir, "runtime.js");
  await fs9.writeFile(runtimeSupportFile, renderChunkRuntimeSupport({
    bridgeFiles,
    chunkNames: chunkPlan.map((chunk) => chunk.name),
    chunkUrls,
    publicPath: options.chunks.publicPath,
    moduleInfoString: renderModuleInfoString(chunkPlan)
  }), "utf-8");
  return {
    bridgeFiles,
    manifestText: `${JSON.stringify(manifest, null, 2)}
`,
    runtimeModuleId: "gcc.__gcc_chunk_runtime",
    runtimeSupportFile
  };
}
function renderChunkRuntimeSupport({
  bridgeFiles,
  chunkNames,
  chunkUrls,
  publicPath,
  moduleInfoString
}) {
  const chunkUrlMap = Object.fromEntries(chunkNames.map((chunkName, index) => [chunkName, chunkUrls[index] ?? ""]));
  return [
    'goog.module("gcc.__gcc_chunk_runtime");',
    'const googModule = goog.require("goog.module");',
    'const ModuleLoader = goog.require("goog.module.ModuleLoader");',
    'const ModuleManager = goog.require("goog.module.ModuleManager");',
    'const uncheckedConversions = goog.require("goog.html.uncheckedconversions");',
    'const Const = goog.require("goog.string.Const");',
    `const __gcc_chunk_urls = ${JSON.stringify(chunkUrlMap)};`,
    `const __gcc_module_info = ${JSON.stringify(moduleInfoString)};`,
    `const __gcc_public_path = ${JSON.stringify(publicPath)};`,
    `const __gcc_justification = Const.from(${JSON.stringify(CHUNK_MANAGER_JUSTIFICATION)});`,
    "const __gcc_loader = new ModuleLoader();",
    "__gcc_loader.setUseScriptTags(true);",
    "const __gcc_manager = ModuleManager.getInstance();",
    "__gcc_manager.setLoader(__gcc_loader);",
    "__gcc_manager.setBatchModeEnabled(false);",
    "__gcc_manager.setConcurrentLoadingEnabled(false);",
    "__gcc_manager.setAllModuleInfoString(__gcc_module_info);",
    "__gcc_manager.setModuleTrustedUris((function() {",
    "  const baseUrl = document.currentScript && document.currentScript.src ? new URL(__gcc_public_path, document.currentScript.src).toString() : __gcc_public_path;",
    "  const trustedUris = {};",
    "  for (const chunkId in __gcc_chunk_urls) {",
    "    trustedUris[chunkId] = [uncheckedConversions.trustedResourceUrlFromStringKnownToSatisfyTypeContract(__gcc_justification, new URL(__gcc_chunk_urls[chunkId], baseUrl).toString())];",
    "  }",
    "  return trustedUris;",
    "})());",
    "__gcc_manager.setModuleContext(globalThis);",
    "const __gcc_module_cache = new Map();",
    "function __gcc_wrap_module(moduleId) {",
    "  if (__gcc_module_cache.has(moduleId)) {",
    "    return __gcc_module_cache.get(moduleId);",
    "  }",
    "  const target = googModule.get(moduleId);",
    "  const wrapped = new Proxy(target, {",
    "    get(moduleTarget, property, receiver) {",
    "      if (property === 'm') {",
    "        return function(exportName) {",
    "          if (!Object.prototype.hasOwnProperty.call(moduleTarget, exportName)) {",
    `            throw new Error('Missing export "' + exportName + '" from lazy module ' + moduleId);`,
    "          }",
    "          return moduleTarget[exportName];",
    "        };",
    "      }",
    "      if (typeof property === 'string' && !Reflect.has(moduleTarget, property)) {",
    `        throw new Error('Missing property "' + property + '" from lazy module ' + moduleId);`,
    "      }",
    "      return Reflect.get(moduleTarget, property, receiver);",
    "    },",
    "    has(moduleTarget, property) {",
    "      return property === 'm' || Reflect.has(moduleTarget, property);",
    "    },",
    "  });",
    "  __gcc_module_cache.set(moduleId, wrapped);",
    "  return wrapped;",
    "}",
    "function __gcc_load(chunkId, moduleId) {",
    "  return Promise.resolve(__gcc_manager.load(chunkId)).then(function() {",
    "    return __gcc_wrap_module(moduleId);",
    "  });",
    "}",
    "function __gcc_preload(chunkId) {",
    "  return Promise.resolve(__gcc_manager.preloadModule(chunkId)).then(function() {});",
    "}",
    ...bridgeFiles.flatMap((bridge) => {
      return [
        `function ${bridge.runtimeBindingName}() { return __gcc_load(${JSON.stringify(bridge.chunkName)}, ${JSON.stringify(bridge.moduleId)}); }`,
        `function ${bridge.preloadBindingName}() { return __gcc_preload(${JSON.stringify(bridge.chunkName)}); }`,
        `exports.${bridge.runtimeBindingName} = ${bridge.runtimeBindingName};`,
        `exports.${bridge.preloadBindingName} = ${bridge.preloadBindingName};`
      ];
    }),
    ""
  ].join(`
`);
}
function renderLazyBridgeModule(moduleId, targetModuleId) {
  return [
    `goog.module(${JSON.stringify(moduleId)});`,
    `const __module = goog.require(${JSON.stringify(targetModuleId)});`,
    "for (const key in __module) {",
    '  if (key !== "default") {',
    "    exports[key] = __module[key];",
    "  }",
    "}",
    "exports.default = __module.default;",
    ""
  ].join(`
`);
}
function dedupeLazyImports2(lazyImports) {
  return [
    ...new Map(lazyImports.map((item) => [item.moduleId, item])).values()
  ];
}
function applyChunkBridgesToResolvedChunks(chunkPlan, bridgeFiles) {
  const bridgesByChunk = new Map;
  for (const bridge of bridgeFiles) {
    const existing = bridgesByChunk.get(bridge.chunkName) ?? [];
    existing.push(bridge);
    bridgesByChunk.set(bridge.chunkName, existing);
  }
  for (const chunk of chunkPlan) {
    const bridges = bridgesByChunk.get(chunk.name) ?? [];
    if (bridges.length === 0) {
      continue;
    }
    chunk.files.push(...bridges.map((bridge) => bridge.filePath));
    chunk.entryPoints = bridges.map((bridge) => bridge.moduleId);
  }
}
function createChunkWrapper(chunk, wrapperNamespace) {
  const namespaceTarget = `globalThis.${wrapperNamespace}=globalThis.${wrapperNamespace}||{}`;
  if (chunk.kind === "base") {
    return `(function(${CHUNK_NAMESPACE}){%output%}).call(this,${namespaceTarget});`;
  }
  return `(function(${CHUNK_NAMESPACE}){var __gcc_manager=goog.module.ModuleManager.getInstance();__gcc_manager.beforeLoadModuleCode(${JSON.stringify(chunk.name)});%output%__gcc_manager.setLoaded();}).call(this,${namespaceTarget});`;
}
function toChunkWrapperNamespace(baseChunkName) {
  const sanitized = baseChunkName.replace(/[^A-Za-z0-9_$]/g, "_");
  return `default_${sanitized}`;
}
function renderModuleInfoString(chunkPlan) {
  return chunkPlan.map((chunk) => {
    const dependencyIndexes = chunk.dependencies.map((dependency) => chunkPlan.findIndex((candidate) => candidate.name === dependency)).filter((index) => index >= 0).map((index) => index.toString(36));
    return dependencyIndexes.length > 0 ? `${chunk.name}:${dependencyIndexes.join(",")}` : chunk.name;
  }).join("/");
}
function resolveChunkPlan(chunkPlan, emittedOutDir) {
  return chunkPlan.map((chunk) => ({
    dependencies: chunk.dependencies,
    entryPoints: chunk.entryFiles ? chunk.entryFiles.map((filePath) => toGoogModuleId(path9.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js")), emittedOutDir)) : (chunk.lazyModuleIds ?? []).length > 0 ? [...chunk.lazyModuleIds ?? []] : chunk.files.length > 0 ? [
      toGoogModuleId(path9.join(emittedOutDir, chunk.files[chunk.files.length - 1].replace(/\.[^/.]+$/, ".js")), emittedOutDir)
    ] : [],
    files: chunk.files.map((filePath) => path9.join(emittedOutDir, filePath.replace(/\.[^/.]+$/, ".js"))),
    kind: chunk.kind,
    lazyModuleIds: chunk.lazyModuleIds ?? [],
    name: chunk.name
  }));
}
function getDefaultString(value) {
  if (typeof value === "object" && value !== null && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return;
}
function uniquePaths(paths) {
  return [...new Set(paths)];
}
function toGoogModuleId(filePath, moduleRoot) {
  const relativePath = path9.relative(moduleRoot, filePath).replace(/\\/g, "/");
  const withoutExtension = relativePath.replace(/\.[^/.]+$/, "");
  return `gcc.${withoutExtension.split("/").map((segment) => segment.replace(/[^A-Za-z0-9_$]/g, "_")).join(".")}`;
}
function resolveClosureCompilerJarPath() {
  const closureCompilerModule = closureCompilerPackage;
  const closureCompiler = closureCompilerPackage.compiler;
  const jarPath = typeof closureCompiler.JAR_PATH === "string" ? closureCompiler.JAR_PATH : typeof closureCompilerModule.JAR_PATH === "string" ? closureCompilerModule.JAR_PATH : getDefaultString(closureCompiler.JAR_PATH) ?? getDefaultString(closureCompilerModule.JAR_PATH);
  return jarPath;
}
function configureClosureCompilerInstance(instance) {
  const nativeImagePath = getNativeImagePath();
  if (nativeImagePath) {
    instance.JAR_PATH = null;
    instance.javaPath = nativeImagePath;
    return instance;
  }
  const jarPath = resolveClosureCompilerJarPath();
  if (jarPath) {
    instance.JAR_PATH = jarPath;
  }
  return instance;
}
async function runClosureCompiler(options) {
  const closureCompiler = closureCompilerPackage.compiler;
  return new Promise((resolve) => {
    const compilerProcess = configureClosureCompilerInstance(new closureCompiler(options));
    compilerProcess.run((exitCode, stdOut, stdErr) => {
      if (stdOut) {
        console.log(stdOut);
      }
      if (stdErr) {
        console.error(stdErr);
      }
      resolve(exitCode);
    });
  });
}
async function collectJavaScriptFiles(dir) {
  const files = [];
  const pending = [dir];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = await fs9.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path9.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return files;
}
async function collectClosureLibFiles(packageRoot2, candidateFiles) {
  const closureLibDir = path9.join(packageRoot2, "closure-lib");
  const cacheKey = `${closureLibDir}\x00${await hashClosureLibSelection(candidateFiles)}`;
  const existing = closureLibFilesCache.get(cacheKey);
  if (existing) {
    return existing;
  }
  const filesPromise = selectClosureLibFiles(closureLibDir, candidateFiles);
  closureLibFilesCache.set(cacheKey, filesPromise);
  return filesPromise;
}
async function hashClosureLibSelection(filePaths) {
  const stats = await Promise.all(uniquePaths(filePaths).map(async (filePath) => {
    try {
      const stat = await fs9.stat(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return `${filePath}:missing`;
    }
  }));
  return stats.sort((left, right) => left.localeCompare(right)).join("|");
}
async function selectClosureLibFiles(closureLibDir, candidateFiles) {
  const usesChunkLoader = candidateFiles.some((filePath) => filePath.includes(`${path9.sep}__gcc_chunk_support${path9.sep}`));
  if (usesChunkLoader) {
    const vendoredLoaderFiles = await collectJavaScriptFiles(path9.join(closureLibDir, "goog"));
    return uniquePaths([path9.join(closureLibDir, "base.js"), ...vendoredLoaderFiles]);
  }
  const required = [path9.join(closureLibDir, "base.js")];
  const contents = (await Promise.all(uniquePaths(candidateFiles).map((filePath) => fs9.readFile(filePath, "utf-8").catch(() => "")))).join(`
`);
  if (contents.includes("goog.reflect.")) {
    required.push(path9.join(closureLibDir, "reflect.js"));
  }
  if (contents.includes("tslib")) {
    required.push(path9.join(closureLibDir, "tslib.js"));
  }
  return required;
}

// src/pipeline/build-pipeline.ts
var bundledExternsCacheByRoot = new Map;
async function build(options) {
  const context = await createBuildContext(normalizeBuildOptions(options));
  const usesPersistentCache = context.options.cache.mode === "persistent";
  if (usesPersistentCache) {
    const fastSnapshot = await readJsonIfExists(path10.join(context.projectCacheDir, "final-fast.json"));
    if (fastSnapshot && fastSnapshot.optionsSignature === context.optionsSignature && fastSnapshot.packageSignature === context.packageSignature && await trackedFilesMatch(fastSnapshot.trackedFiles) && await publishedOutputsMatchSnapshot(fastSnapshot.publishedOutputs, context.options.outDir)) {
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(fastSnapshot.publishedOutputs, context.options.outDir)
      };
    }
  }
  let resolved = null;
  try {
    resolved = await resolveBuild(context);
    const resolvedBuild = resolved;
    const finalMetadataPath = path10.join(resolvedBuild.finalCacheDir, "meta.json");
    const finalMetadata = usesPersistentCache ? await readJsonIfExists(finalMetadataPath) : null;
    if (usesPersistentCache && finalMetadata && await filesExist(finalMetadata.outputFiles)) {
      await publishOutputs(finalMetadata.outputFiles, context.options.outDir);
      return {
        cacheHit: true,
        diagnostics: [],
        emitSkipped: false,
        exitCode: 0,
        outputFiles: toPublishedOutputPaths(finalMetadata.outputFiles.map((outputFile) => ({
          name: path10.basename(outputFile)
        })), context.options.outDir)
      };
    }
    if (context.options.chunks.mode === "closure-library" && resolvedBuild.entryFiles.some((entry) => entry.exportNames.length > 0 || entry.hasDefaultExport)) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic("Chunk mode is application-oriented and does not emit exported library entry files. Remove entry exports or disable chunks.mode.")
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode !== "closure-library") {
      writeEntryShims({
        entries: resolvedBuild.entryFiles.map((entry) => ({
          exportNames: entry.exportNames,
          hasDefaultExport: entry.hasDefaultExport,
          importPath: toImportPath(path10.relative(path10.dirname(path10.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)), entry.sourcePath)),
          shimPath: path10.join(resolvedBuild.shimDir, `${entry.chunkName}.ts`)
        }))
      });
    }
    const nativeEmitMetadataPath = path10.join(resolvedBuild.nativeEmitCacheDir, "meta.json");
    const nativeEmitResult = await emitNativeStage({
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      fileNames: context.options.chunks.mode === "closure-library" ? resolvedBuild.sourceFiles : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
      lazyImports: resolvedBuild.lazyImports,
      metadataPath: nativeEmitMetadataPath,
      options: context.options,
      packageAliases: resolvedBuild.packageAliases,
      packageJsonFiles: resolvedBuild.packageJsonFiles,
      tsConfigPath: resolvedBuild.tsConfigPath,
      workspaceDir: resolvedBuild.workspaceDir
    });
    if (nativeEmitResult.diagnostics.length > 0 || nativeEmitResult.emitSkipped) {
      return {
        cacheHit: false,
        diagnostics: nativeEmitResult.diagnostics,
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    const bundledExterns = await collectBundledExterns(context.packageRoot);
    const runtimeDependencyExterns = await generateRuntimeDependencyExterns({
      appEntryFiles: context.options.entries,
      cacheDir: resolvedBuild.nativeEmitCacheDir,
      dependencyModules: nativeEmitResult.dependencyModules,
      dependencyRuntimeFiles: nativeEmitResult.dependencyRuntimeFiles,
      projectRoot: context.options.projectRoot,
      srcDir: context.options.srcDir,
      tsConfigPath: resolvedBuild.tsConfigPath
    });
    const closureResult = await runClosureStage({
      chunkPlan: resolvedBuild.chunkPlan,
      emittedOutDir: nativeEmitResult.outDir,
      externPaths: [
        ...context.options.externs,
        ...bundledExterns,
        ...runtimeDependencyExterns ? [runtimeDependencyExterns] : [],
        nativeEmitResult.externsPath
      ],
      finalCacheDir: resolvedBuild.finalCacheDir,
      lazyImports: resolvedBuild.lazyImports,
      options: context.options,
      outDir: context.options.outDir,
      supportFiles: nativeEmitResult.supportFiles,
      packageRoot: context.packageRoot
    });
    if (closureResult.exitCode !== 0) {
      return {
        cacheHit: false,
        diagnostics: [],
        emitSkipped: true,
        exitCode: closureResult.exitCode,
        outputFiles: []
      };
    }
    if (usesPersistentCache) {
      await writeJson(finalMetadataPath, {
        outputFiles: closureResult.cacheOutputFiles
      });
      await writeJson(path10.join(context.projectCacheDir, "final-fast.json"), {
        finalKey: resolvedBuild.finalKey,
        optionsSignature: context.optionsSignature,
        packageSignature: context.packageSignature,
        publishedOutputs: await collectPublishedOutputStats2(closureResult.outputFiles),
        trackedFiles: resolvedBuild.trackedFiles
      });
    }
    return {
      cacheHit: false,
      diagnostics: [],
      emitSkipped: false,
      exitCode: 0,
      outputFiles: closureResult.outputFiles
    };
  } catch (error) {
    return {
      cacheHit: false,
      diagnostics: [createBuildDiagnostic(error)],
      emitSkipped: true,
      exitCode: 1,
      outputFiles: []
    };
  } finally {
    await resolved?.cleanup();
  }
}
async function cleanCache(options = {}) {
  const projectRoot = path10.resolve(options.projectRoot ?? process.cwd());
  const cacheRoot = path10.resolve(options.cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path10.join(cacheRoot, hashContent(projectRoot));
  await fs10.promises.rm(projectCacheDir, { force: true, recursive: true });
}
async function generateRuntimeDependencyExterns({
  appEntryFiles,
  cacheDir,
  dependencyModules,
  dependencyRuntimeFiles,
  projectRoot,
  srcDir,
  tsConfigPath
}) {
  if (dependencyModules.length === 0 || dependencyRuntimeFiles.length === 0) {
    return null;
  }
  const outputFile = path10.join(cacheDir, "runtime-dependency-externs.js");
  await generateExterns({
    appEntryFiles,
    mode: "runtime-aware",
    modules: dependencyModules,
    outputFile,
    projectRoot,
    runtimeEntryFiles: dependencyRuntimeFiles,
    srcDir,
    tsConfigPath
  });
  return outputFile;
}
async function collectBundledExterns(packageRoot2) {
  let bundledExternsPromise = bundledExternsCacheByRoot.get(packageRoot2);
  if (!bundledExternsPromise) {
    bundledExternsPromise = (async () => {
      const closureExternsPath = path10.join(packageRoot2, "closure-externs");
      const entries = await fs10.promises.readdir(closureExternsPath);
      return entries.map((entry) => path10.join(closureExternsPath, entry)).sort((left, right) => left.localeCompare(right));
    })();
    bundledExternsCacheByRoot.set(packageRoot2, bundledExternsPromise);
  }
  return bundledExternsPromise;
}
async function publishOutputs(outputFiles, outDir) {
  if (await publishedOutputsMatch2(outputFiles, outDir)) {
    return;
  }
  await copyOrLinkFiles(outputFiles, outDir);
}
function toImportPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}
function toPublishedOutputPaths(publishedOutputs, outDir) {
  return publishedOutputs.map(({ name }) => path10.join(outDir, name));
}
function createBuildDiagnostic(error) {
  return {
    category: 1,
    code: 0,
    messageText: error instanceof Error ? error.message : typeof error === "string" ? error : "Build failed."
  };
}

// src/api/build.ts
var build2 = (options) => build(options);
export {
  generateExterns,
  cleanCache,
  build2 as build,
  DEFAULT_BUILD_OPTIONS
};
