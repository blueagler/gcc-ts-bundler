const __gcc_current_module_url = import.meta.url;

// src/api/externs.ts
import fs2 from "fs";
import path2 from "path";
import ts2 from "typescript";

// src/stages/native/compiler-options.ts
import fs from "fs";
import path from "path";
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

// src/stages/native/compiler-options.ts
var compilerOptionsCache = new Map;
async function loadCompilerOptions(configPath, extraOptions = {}) {
  const configStat = await fs.promises.stat(configPath);
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
  const configDir = path.dirname(configPath);
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
      ...extraOptions.paths ?? {}
    }
  }, configPath);
  if (parsedConfig.errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, ts.createCompilerHost({})));
  }
  compilerOptionsCache.set(cacheKey, parsedConfig.options);
  return parsedConfig.options;
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
  const projectRoot = path2.resolve(options.projectRoot ?? process.cwd());
  const srcDir = path2.resolve(projectRoot, options.srcDir ?? ".");
  const tsConfigPath = options.tsConfigPath && path2.resolve(projectRoot, options.tsConfigPath);
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
  const outputFile = options.outputFile && path2.resolve(projectRoot, options.outputFile);
  if (outputFile) {
    await fs2.promises.mkdir(path2.dirname(outputFile), { recursive: true });
    await fs2.promises.writeFile(outputFile, text, "utf8");
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
  const resolvedConfigPath = tsConfigPath ?? path2.join(projectRoot, "tsconfig.json");
  try {
    await fs2.promises.access(resolvedConfigPath, fs2.constants.R_OK);
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
  const containingFile = path2.join(projectRoot, "__gcc_externs_entry__.ts");
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
  const normalizedPath = path2.resolve(resolvedFileName);
  if (isTypeSourceFile(normalizedPath)) {
    return normalizedPath;
  }
  for (const extension of DECLARATION_EXTENSIONS) {
    const candidate = withTypeExtension(normalizedPath, extension);
    if (ts2.sys.fileExists(candidate)) {
      return path2.resolve(candidate);
    }
  }
  return null;
}
function withTypeExtension(filePath, nextExtension) {
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return filePath;
  }
  const extension = path2.extname(filePath);
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
    const resolvedFile = path2.resolve(nextFile);
    if (seen.has(resolvedFile) || !isTypeSourceFile(resolvedFile)) {
      continue;
    }
    if (isTypescriptLibFile(resolvedFile)) {
      continue;
    }
    seen.add(resolvedFile);
    const sourceText = await fs2.promises.readFile(resolvedFile, "utf8");
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
  const scannedFileSet = new Set(scannedFiles.map((filePath) => path2.resolve(filePath)));
  const interfaceContracts = new Map;
  const typeAliasContracts = new Map;
  const classContracts = new Map;
  for (const sourceFile of program.getSourceFiles()) {
    if (!scannedFileSet.has(path2.resolve(sourceFile.fileName))) {
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
    if (path2.isAbsolute(entry)) {
      return entry;
    }
    const fromSrcDir = path2.resolve(srcDir, entry);
    if (ts2.sys.fileExists(fromSrcDir)) {
      return fromSrcDir;
    }
    return path2.resolve(projectRoot, entry);
  });
}
async function analyzeRuntimeUsage(runtimeEntryFiles) {
  const structuralMembers = new Set;
  for (const runtimeEntryFile of runtimeEntryFiles) {
    const sourceText = await fs2.promises.readFile(runtimeEntryFile, "utf8");
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
  for (const [
    index,
    contractSymbols
  ] of classContract.constructorParamContracts.entries()) {
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
  const resolvedFilePath = path2.resolve(filePath);
  return !resolvedFilePath.includes(`${path2.sep}node_modules${path2.sep}`) && !resolvedFilePath.endsWith(".d.ts") && resolvedFilePath.startsWith(path2.resolve(projectRoot) + path2.sep);
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
  return (symbol.declarations ?? []).some((declaration) => scannedFiles.has(path2.resolve(declaration.getSourceFile().fileName)));
}
function findPackageDir(filePath) {
  let currentDir = path2.dirname(filePath);
  while (true) {
    const packageJsonPath = path2.join(currentDir, "package.json");
    if (ts2.sys.fileExists(packageJsonPath)) {
      return currentDir;
    }
    const parentDir = path2.dirname(currentDir);
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
  return filePath.includes(`${path2.sep}node_modules${path2.sep}typescript${path2.sep}lib${path2.sep}`);
}
function symbolCacheKey(symbol) {
  const declaration = symbol.declarations?.[0];
  return declaration ? `${path2.resolve(declaration.getSourceFile().fileName)}:${symbol.getName()}` : symbol.getName();
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
    loader: "auto",
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
import fs3 from "fs";
import os from "os";
import path3 from "path";
function getDefaultPersistentCacheRoot() {
  if (process.platform === "darwin") {
    return path3.join(os.homedir(), "Library", "Caches", "gcc-ts-bundler");
  }
  if (process.platform === "win32") {
    return path3.join(process.env.LOCALAPPDATA ?? path3.join(os.homedir(), "AppData", "Local"), "gcc-ts-bundler");
  }
  return path3.join(process.env.XDG_CACHE_HOME ?? path3.join(os.homedir(), ".cache"), "gcc-ts-bundler");
}
async function createCacheStore({
  cacheDir,
  mode,
  projectRoot
}) {
  if (mode === "off" || mode === "temp") {
    const rootDir2 = await fs3.promises.mkdtemp(path3.join(os.tmpdir(), "gcc-ts-bundler-"));
    const workspaceDir2 = path3.join(rootDir2, "workspace");
    await fs3.promises.mkdir(workspaceDir2, { recursive: true });
    return {
      async cleanup() {
        await fs3.promises.rm(rootDir2, { force: true, recursive: true });
      },
      mode,
      projectCacheDir: rootDir2,
      rootDir: rootDir2,
      workspaceDir: workspaceDir2
    };
  }
  const rootDir = path3.resolve(cacheDir || getDefaultPersistentCacheRoot());
  const projectCacheDir = path3.join(rootDir, hashContent(projectRoot));
  const workspaceDir = path3.join(projectCacheDir, "workspace");
  await fs3.promises.mkdir(workspaceDir, { recursive: true });
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
    const raw = await fs3.promises.readFile(filePath, "utf-8");
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
  await fs3.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}
async function ensureDirectoryExistence(filePath) {
  await fs3.promises.mkdir(path3.dirname(filePath), { recursive: true });
}

// src/internal/file-state.ts
import fs6 from "fs";
import path6 from "path";

// src/native/index.ts
import fs5 from "fs";
import path5 from "path";

// src/internal/bundle-location.ts
import fs4 from "fs";
import path4 from "path";
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
  let currentDir = path4.dirname(getBundleFilePath());
  while (true) {
    if (fs4.existsSync(path4.join(currentDir, "package.json"))) {
      packageRoot = currentDir;
      return currentDir;
    }
    const parentDir = path4.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate package.json from bundled module path ${getBundleFilePath()}`);
    }
    currentDir = parentDir;
  }
}

// src/native/index.ts
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
  const localFallbackPath = path5.join(getPackageRootFromBundle(), "native", "index.node");
  if (fs5.existsSync(localFallbackPath)) {
    return require2(localFallbackPath);
  }
  const loadErrors = [];
  if (packageName) {
    try {
      return require2(packageName);
    } catch (error) {
      loadErrors.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
    }
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
function planChunks(input) {
  return loadBinding().planChunks(input.chunkMode, input.baseChunkName, input.workspaceDir, input.entryFiles, input.graphEntries, input.lazyImports, input.shimFiles);
}
function rewriteGccExports(code) {
  return loadBinding().rewriteGccExports(code);
}
function transpileSources(input) {
  return loadBinding().transpileSources(input.fileNames, input.outDir, input.externsPath, input.metadataPath, input.chunkMode, input.workspaceDir, input.packageAliases ?? [], input.packageJsonFiles ?? [], input.lazyImports ?? []);
}
function prepareClosureJobs(input) {
  return loadBinding().prepareClosureJobs(input);
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
  const resolvedLazyImports = graphResult.lazyImports;
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
      chunkPlan: planChunks({
        baseChunkName: options.chunks.baseChunkName,
        chunkMode: options.chunks.mode,
        entryFiles: entryFiles2.map((entry) => ({
          chunkName: entry.chunkName,
          outputName: entry.outputName,
          sourcePath: entry.sourcePath
        })),
        graphEntries: [
          ...Object.entries(graphResult.graph).map(([filePath, dependencies]) => ({
            dependencies,
            filePath
          })),
          ...shimFiles2.map((shimFile, index) => ({
            dependencies: [entryFiles2[index].sourcePath],
            filePath: shimFile
          }))
        ],
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
      loader: options.chunks?.loader ?? DEFAULT_BUILD_OPTIONS.chunks.loader,
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
async function collectNativeTypeAnalysis({
  fileNames,
  preflight,
  tsConfigPath,
  workspaceDir
}) {
  const compilerOptions = await loadCompilerOptions(tsConfigPath, {
    allowJs: true,
    ignoreDeprecations: "6.0",
    moduleResolution: ts4.ModuleResolutionKind.Bundler,
    noEmit: true,
    rootDir: workspaceDir,
    skipLibCheck: true,
    target: ts4.ScriptTarget.ESNext
  });
  const program = ts4.createProgram(fileNames, compilerOptions);
  const preflightDiagnostics = preflight === "full" ? [...ts4.getPreEmitDiagnostics(program)].filter((diagnostic) => !shouldIgnorePreflightDiagnostic(diagnostic)) : [];
  const { diagnostics: closureIrDiagnostics, files } = collectClosureIrFiles({
    compilerOptions,
    fileNames,
    program
  });
  return {
    diagnostics: [...preflightDiagnostics, ...closureIrDiagnostics],
    files
  };
}
function collectClosureIrFiles({
  compilerOptions,
  fileNames,
  program
}) {
  const checker = program.getTypeChecker();
  const unsafeEnumSymbols = collectUnsafeEnumSymbols(program, checker);
  const inputFiles = new Set(fileNames);
  const diagnostics = [];
  const files = [];
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
function shouldIgnorePreflightDiagnostic(diagnostic) {
  if (diagnostic.code !== 7016) {
    return false;
  }
  const message = ts4.flattenDiagnosticMessageText(diagnostic.messageText, `
`);
  return message.includes("node_modules") && message.includes("implicitly has an 'any' type");
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
  const externsPath = path8.join(cacheDir, "native-generated.externs.js");
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
  const missingInputDiagnostics = await getMissingInputDiagnostics({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath
  });
  if (missingInputDiagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: missingInputDiagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  const analysis = await collectNativeTypeAnalysis({
    fileNames: combinedFileNames,
    preflight: options.diagnostics.preflight,
    tsConfigPath,
    workspaceDir
  });
  if (analysis.diagnostics.length > 0) {
    return {
      dependencyModules,
      dependencyRuntimeFiles,
      diagnostics: analysis.diagnostics,
      emitSkipped: true,
      emittedFiles: [],
      externsPath,
      outDir,
      supportFiles: []
    };
  }
  await fs8.promises.writeFile(metadataPathForNative, JSON.stringify(analysis.files, null, 2), "utf-8");
  const result = transpileSources({
    chunkMode: options.chunks.mode,
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
async function getMissingInputDiagnostics({
  fileNames,
  preflight,
  tsConfigPath
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
  return [];
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
import os2 from "os";
import path9 from "path";
import * as closureCompilerPackage from "google-closure-compiler";
import { getNativeImagePath } from "google-closure-compiler/lib/utils.js";
var CLOSURE_JOB_CACHE_VERSION = 1;
var closureInputHashCache = new Map;
async function runClosureStage({
  chunkPlan,
  emittedOutDir,
  explicitExternPaths,
  finalCacheDir,
  generatedExternPaths,
  nativeExternPath,
  options,
  outDir,
  projectCacheDir,
  supportFiles,
  packageRoot: packageRoot2
}) {
  await fs9.rm(finalCacheDir, { force: true, recursive: true });
  await fs9.mkdir(finalCacheDir, { recursive: true });
  const rawDir = path9.join(finalCacheDir, "raw");
  const cacheOutputDir = path9.join(finalCacheDir, "outputs");
  await fs9.mkdir(rawDir, { recursive: true });
  await fs9.mkdir(cacheOutputDir, { recursive: true });
  await fs9.rm(outDir, { force: true, recursive: true });
  await fs9.mkdir(outDir, { recursive: true });
  const prepared = prepareClosureJobs({
    chunkLoader: options.chunks.loader,
    chunkMode: options.chunks.mode,
    chunkPlan,
    compilationLevel: options.compilationLevel,
    diagnosticsVerbose: options.diagnostics.verbose,
    emittedOutDir,
    explicitExternPaths,
    explicitJsInputs: options.js,
    finalCacheDir,
    generatedExternPaths,
    languageOut: options.languageOut,
    manifestFile: options.chunks.manifestFile,
    nativeExternPath,
    outDir,
    packageRoot: packageRoot2,
    publicPath: options.chunks.publicPath,
    supportFiles
  });
  await Promise.all(prepared.generatedAssets.map(async (asset) => {
    await fs9.mkdir(path9.dirname(asset.path), { recursive: true });
    await fs9.writeFile(asset.path, asset.text, "utf-8");
  }));
  const closureJobCacheDir = options.cache.mode === "off" ? null : path9.join(projectCacheDir, "closure-jobs");
  const concurrency = options.chunks.mode === "bundler-runtime" ? determineClosureConcurrency(prepared.compileJobs.length) : 1;
  const exitCodes = await runWithConcurrency(prepared.compileJobs, concurrency, async (job) => runPreparedClosureJob({
    cacheDir: closureJobCacheDir,
    job
  }));
  const failedExitCode = exitCodes.find((exitCode) => exitCode !== 0);
  if (failedExitCode !== undefined) {
    return { cacheOutputFiles: [], exitCode: failedExitCode, outputFiles: [] };
  }
  await Promise.all(prepared.postprocessActions.map(async (action) => {
    await fs9.mkdir(path9.dirname(action.outputPath), { recursive: true });
    if (action.kind === "rewrite-gcc-exports") {
      const contents = await fs9.readFile(action.inputPath, "utf-8");
      await fs9.writeFile(action.outputPath, rewriteGccExports(contents));
      return;
    }
    await fs9.copyFile(action.inputPath, action.outputPath);
  }));
  await copyOrLinkFiles(prepared.publishedOutputs, cacheOutputDir);
  const cacheOutputFiles = prepared.publishedOutputs.map((outputFile) => path9.join(cacheOutputDir, path9.relative(outDir, outputFile)));
  return {
    cacheOutputFiles,
    exitCode: 0,
    outputFiles: prepared.publishedOutputs
  };
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
function getDefaultString(value) {
  if (typeof value === "object" && value !== null && "default" in value && typeof value.default === "string") {
    return value.default;
  }
  return;
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
function uniquePaths(paths) {
  return [...new Set(paths)];
}
async function runPreparedClosureJob({
  cacheDir,
  job
}) {
  const outputFiles = getCompileJobOutputFiles(job);
  const cached = cacheDir ? await tryRestoreCachedClosureJob({
    cacheDir,
    job,
    outputFiles
  }) : false;
  if (cached) {
    return 0;
  }
  const closureOptions = {
    assumeFunctionWrapper: job.assumeFunctionWrapper,
    compilationLevel: job.compilationLevel,
    externs: uniquePaths(job.externs),
    js: uniquePaths(job.js),
    languageIn: job.languageIn,
    languageOut: job.languageOut,
    rewritePolyfills: job.rewritePolyfills,
    warningLevel: job.warningLevel
  };
  if (job.chunk) {
    closureOptions.chunk = job.chunk;
  }
  if (job.chunkOutputPathPrefix) {
    closureOptions.chunkOutputPathPrefix = job.chunkOutputPathPrefix;
  }
  if (job.dependencyMode) {
    closureOptions.dependencyMode = job.dependencyMode;
  }
  if (job.entryPoint && job.entryPoint.length > 0) {
    closureOptions.entryPoint = job.entryPoint;
  }
  if (job.jsOutputFile) {
    closureOptions.jsOutputFile = job.jsOutputFile;
  }
  applyInternalClosureDebugOptions(closureOptions);
  const exitCode = await runClosureCompiler(closureOptions);
  if (exitCode !== 0) {
    return exitCode;
  }
  if (cacheDir) {
    await persistCachedClosureJob({
      cacheDir,
      job,
      outputFiles
    });
  }
  return 0;
}
async function tryRestoreCachedClosureJob({
  cacheDir,
  job,
  outputFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job);
  const metadata = await readJsonIfExists(path9.join(jobCacheDir, "meta.json"));
  if (!metadata || metadata.version !== CLOSURE_JOB_CACHE_VERSION || metadata.outputFiles.length !== outputFiles.length) {
    return false;
  }
  const cachedFiles = metadata.outputFiles.map((fileName) => path9.join(jobCacheDir, fileName));
  const filesReady = await Promise.all(cachedFiles.map((filePath) => fs9.stat(filePath).then(() => true).catch(() => false)));
  if (filesReady.some((ready) => !ready)) {
    return false;
  }
  await Promise.all(outputFiles.map(async (outputFile, index) => {
    await fs9.mkdir(path9.dirname(outputFile), { recursive: true });
    await fs9.copyFile(cachedFiles[index], outputFile);
  }));
  return true;
}
async function persistCachedClosureJob({
  cacheDir,
  job,
  outputFiles
}) {
  const jobCacheDir = await getClosureJobCacheDir(cacheDir, job);
  await fs9.rm(jobCacheDir, { force: true, recursive: true });
  await fs9.mkdir(jobCacheDir, { recursive: true });
  const outputNames = outputFiles.map((outputFile) => path9.basename(outputFile));
  await Promise.all(outputFiles.map((outputFile, index) => fs9.copyFile(outputFile, path9.join(jobCacheDir, outputNames[index]))));
  await writeJson(path9.join(jobCacheDir, "meta.json"), {
    outputFiles: outputNames,
    version: CLOSURE_JOB_CACHE_VERSION
  });
}
async function getClosureJobCacheDir(cacheDir, job) {
  const outputFiles = getCompileJobOutputFiles(job);
  const compilerVersion = resolveClosureCompilerJarPath() ?? getNativeImagePath() ?? "native";
  const [jsInputs, externInputs] = await Promise.all([
    hashFilesInOrder(job.js),
    hashFilesInOrder(job.externs)
  ]);
  const key = hashJson({
    compilerVersion,
    externInputs,
    job: {
      assumeFunctionWrapper: job.assumeFunctionWrapper,
      chunk: job.chunk ?? null,
      compilationLevel: job.compilationLevel,
      dependencyMode: job.dependencyMode ?? null,
      entryPoint: job.entryPoint ?? null,
      jsOutputKinds: outputFiles.map((outputFile) => path9.basename(outputFile)),
      languageIn: job.languageIn,
      languageOut: job.languageOut,
      rewritePolyfills: job.rewritePolyfills,
      warningLevel: job.warningLevel
    },
    jsInputs,
    version: CLOSURE_JOB_CACHE_VERSION
  });
  return path9.join(cacheDir, key);
}
async function hashFilesInOrder(filePaths) {
  return Promise.all(filePaths.map((filePath) => hashFileInput(filePath)));
}
async function hashFileInput(filePath) {
  const stat = await fs9.stat(filePath);
  const cacheKey = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = closureInputHashCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const pending = fs9.readFile(filePath, "utf-8").then((contents) => hashContent(contents));
  closureInputHashCache.set(cacheKey, pending);
  return pending;
}
function getCompileJobOutputFiles(job) {
  if (job.jsOutputFile) {
    return [job.jsOutputFile];
  }
  if (job.chunk && job.chunkOutputPathPrefix) {
    return job.chunk.map((chunkSpec) => path9.join(job.chunkOutputPathPrefix, `${chunkSpec.split(":", 1)[0]}.js`));
  }
  throw new Error("Closure compile job is missing output configuration.");
}
function determineClosureConcurrency(jobCount) {
  const fromEnv = Number.parseInt(process.env.GCC_CLOSURE_CONCURRENCY ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(jobCount, fromEnv);
  }
  return Math.min(jobCount, Math.max(1, (os2.availableParallelism?.() ?? 2) - 1));
}
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
  return results;
}

// src/pipeline/build-pipeline.ts
var RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION = 1;
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
    if (context.options.chunks.mode !== "off" && resolvedBuild.entryFiles.some((entry) => entry.exportNames.length > 0 || entry.hasDefaultExport)) {
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
    if (context.options.chunks.mode === "off" && resolvedBuild.lazyImports.length > 0) {
      return {
        cacheHit: false,
        diagnostics: [
          createBuildDiagnostic('Dynamic import() requires chunks.mode = "bundler-runtime".')
        ],
        emitSkipped: true,
        exitCode: 1,
        outputFiles: []
      };
    }
    if (context.options.chunks.mode === "off") {
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
      fileNames: context.options.chunks.mode !== "off" ? resolvedBuild.sourceFiles : [...resolvedBuild.sourceFiles, ...resolvedBuild.shimFiles],
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
    const runtimeDependencyExterns = await generateRuntimeDependencyExterns({
      appEntryFiles: context.options.entries,
      cacheMode: context.options.cache.mode,
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
      explicitExternPaths: context.options.externs,
      finalCacheDir: resolvedBuild.finalCacheDir,
      generatedExternPaths: runtimeDependencyExterns ? [runtimeDependencyExterns] : [],
      nativeExternPath: nativeEmitResult.externsPath,
      options: context.options,
      outDir: context.options.outDir,
      projectCacheDir: context.projectCacheDir,
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
  cacheMode,
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
  const metadataPath = path10.join(cacheDir, "runtime-dependency-externs.meta.json");
  if (cacheMode !== "off") {
    const compilerOptions = await loadCompilerOptions(tsConfigPath);
    const cacheKey = hashJson({
      appEntryFiles,
      compilerOptions,
      dependencyModules,
      dependencyRuntimeFiles,
      projectRoot,
      srcDir,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION
    });
    const cachedMetadata = await readJsonIfExists(metadataPath);
    if (cachedMetadata?.version === RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION && cachedMetadata.key === cacheKey && cachedMetadata.outputFile === outputFile && await filesExist([outputFile])) {
      return outputFile;
    }
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
    await writeJson(metadataPath, {
      key: cacheKey,
      outputFile,
      version: RUNTIME_DEPENDENCY_EXTERNS_CACHE_VERSION
    });
    return outputFile;
  }
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
